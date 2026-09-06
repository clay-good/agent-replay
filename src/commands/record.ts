import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { parseEventLine, validateEvent } from '../services/event-protocol.js';
import type { CaptureEvent } from '../services/event-protocol.js';
import { applyEvent } from '../services/recorder.js';
import { makeTranslator } from '../services/stream-translators.js';
import { updateTrace } from '../services/trace-service.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';
import { existsSync } from 'node:fs';

export interface RecordOptions {
  format?: string;
  agentName?: string;
  input?: string;
  tags?: string;
  leaveOpen?: boolean;
  dir?: string;
}

const FORMATS = ['native', 'codex-exec', 'gemini-stream'];

/**
 * `agent-replay record` — consume an event stream from stdin and write traces
 * incrementally. Reads the native JSONL protocol by default, or translates a
 * harness's own stream via `--format codex-exec` / `gemini-stream`. Still-open
 * traces are finalized as `timeout` on EOF unless `--leave-open`. `--input`
 * and `--agent-name` supply the prompt and the label a stream does not carry.
 */
export async function runRecord(opts: RecordOptions = {}): Promise<void> {
  const format = opts.format ?? 'native';
  if (!FORMATS.includes(format)) {
    console.error(chalk.red(`  --format ${format} is not supported. Options: ${FORMATS.join(', ')}.`));
    process.exitCode = 2;
    return;
  }

  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  // The prompt to give a trace the stream opens without one.
  //
  // `check --golden` matches a candidate to its baseline by agent name and a
  // hash of the trace input, and deliberately never matches an empty input —
  // it is the absence of an identity, not one that happens to be blank. The
  // harness streams carry no prompt at all (codex and gemini both take it as a
  // command-line argument, not as a stream event), so every capture in those
  // formats was unmatchable and the gate could only answer "none compared".
  // The prompt is right there in the shell command; this lets the caller pass
  // it in, which is the only honest source for it.
  //
  // Trimmed, and empty is treated as absent: `--input ""` would otherwise
  // store a blank prompt that reads as a captured input while hashing like
  // every other blank one — the exact confusion the empty-input rule exists to
  // prevent.
  const suppliedInput = (opts.input ?? '').trim();

  // The operator's label for this run.
  //
  // A translated stream names its agent after the HARNESS — every
  // `--format codex-exec` capture is called `codex` — so a store collecting two
  // different Codex-based workflows could not tell them apart: `list --agent`,
  // `stats` and `check --agent` all group by that one name. The stream cannot
  // know the label; the operator does.
  //
  // Unlike `--input`, this OVERRIDES what the stream said. An input is data the
  // producer captured, so the producer knows better; a name is a label, and the
  // one typed on the command line is the operator's answer to "what is this
  // run?".
  //
  // Blank is treated as absent rather than refused, the rule `run --agent-name`
  // follows: `agent_name` is required and non-empty everywhere else (ingest
  // refuses `""`), so storing a blank would write a trace this store's own
  // export -> ingest round trip cannot reproduce.
  const suppliedName = (opts.agentName ?? '').trim() !== '' ? (opts.agentName as string) : null;

  if (opts.agentName != null && suppliedName == null) {
    console.error(chalk.yellow('  ⚠ --agent-name was blank; keeping the name the stream reports.'));
  }

  const extraTags = (opts.tags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const touched = new Set<string>();
  // Traces this stream OPENED (saw a trace_start for), as distinct from traces
  // it merely wrote into — only the former are ours to finalize.
  const opened = new Set<string>();
  let applied = 0;
  let warnings = 0;
  let totalSteps = 0;
  // Non-blank lines the producer actually sent. The failure condition is
  // "input arrived and nothing was recorded" — keying it on `warnings` instead
  // missed the very case it was written for: with `--format codex-exec` or
  // `gemini-stream`, a translator IGNORES an unrecognized line silently rather
  // than warning, so piping the wrong --format left warnings at 0 and the run
  // reported success having recorded nothing.
  let inputLines = 0;

  const apply = (event: CaptureEvent): void => {
    if (event.type === 'trace_start' && suppliedName) {
      event.agent_name = suppliedName;
    }
    if (event.type === 'trace_start' && suppliedInput) {
      // Fill in only, never override: a native producer that sends its own
      // input knows more about the run than the command line does, and
      // silently replacing it would make the stored trace disagree with the
      // producer that emitted it. `{ prompt }` is the shape every other
      // capture path stores a prompt in (the hook adapter, the transcript and
      // rollout importers), so a recorded run matches an imported one of the
      // same prompt.
      const own = event.input;
      const hasOwn = own != null && typeof own === 'object' && Object.keys(own).length > 0;
      if (!hasOwn) event.input = { prompt: suppliedInput };
    }
    if (event.type === 'trace_start' && extraTags.length > 0) {
      // Only merge into an actual array. Spreading a producer's non-array
      // `tags` threw here — OUTSIDE the per-event try below — which aborted the
      // whole stream and lost every trace in it, not just the bad event. A
      // string would also have spread into one tag per character.
      const own = Array.isArray(event.tags) ? event.tags : [];
      event.tags = [...own, ...extraTags];
    }
    try {
      const { traceId, warning: applyWarning } = applyEvent(db, event);
      touched.add(traceId);
      if (event.type === 'trace_start') opened.add(traceId);
      applied++;
      // A repair made while STORING the event — today, a causal reference to a
      // step that does not exist. Dropping it is right (`why` and `show --tree`
      // would otherwise disagree about the same trace, and `export` would
      // produce something `ingest` refuses), but doing it silently is not.
      if (applyWarning) {
        warnings++;
        console.error(chalk.yellow(`  ⚠ ${applyWarning}`));
      }
      if (event.type === 'step' || event.type === 'step_start') totalSteps++;
    } catch (err) {
      warnings++;
      console.error(chalk.yellow(`  ⚠ skipped ${event.type}: ${errorMessage(err)}`));
    }
  };

  /**
   * Apply an event a translator produced, after the same validation the native
   * protocol path performs.
   *
   * A warning here means the vendor's payload carried a field we could not use,
   * not that our translator is broken — so, exactly as on the native path, an
   * event that survives validation with a field dropped is still applied rather
   * than losing the whole step over one bad value.
   */
  const applyTranslated = (event: CaptureEvent): void => {
    const { event: checked, warning } = validateEvent(event);
    if (warning) {
      warnings++;
      console.error(chalk.yellow(`  ⚠ ${warning}`));
    }
    if (!checked) return;
    apply(checked);
  };

  const translator = makeTranslator(format);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    // A `//` comment line is part of the NATIVE protocol only (see
    // parseEventLine), so counting it as input made a legal comment-only native
    // stream report "none of the N line(s) matched the format" and exit 1. In a
    // translated format `//` is just a line the translator rejects, and skipping
    // it there let a wholly rejected stream exit 0.
    const trimmed = line.trim();
    if (trimmed && (translator != null || !trimmed.startsWith('//'))) inputLines++;
    if (translator) {
      // Native harness stream: parse the line, then translate to our events.
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        warnings++;
        console.error(chalk.yellow(`  ⚠ skipped: invalid JSON in ${format} stream`));
        continue;
      }
      // Translated events go through the SAME validation gate as native ones.
      // They bypassed it entirely, which made the translators the one live
      // capture entry point with no check between a vendor's payload and the
      // store. The translators are our code, but their INPUT is the producer's,
      // and every other route to a write (the JSONL protocol, the SDK's emit())
      // is already gated.
      //
      // Be precise about what this buys TODAY: because every translator
      // hard-codes a valid step_type, a non-empty name, a generated trace_id and
      // a step_number >= 1, and never emits tags, decisions or usage numbers,
      // validateEvent currently rejects nothing they produce. The value is that
      // the two paths now share one gate, so a rule added to it covers both —
      // not that it is catching something today. (`output` shape is normalized
      // by the translators themselves; see the codex item branch.)
      const translated = translator.translate(obj);
      for (const ev of translated) applyTranslated(ev);
      // Report a line the translator dropped, the way the native path reports a
      // line it rejects. Producing no events is not always a loss — a repeated
      // `init`, or a line that only records usage, legitimately yields none —
      // so the translator says which it was rather than the caller guessing
      // from an empty array.
      const skipped = translator.lastSkip();
      if (skipped) {
        warnings++;
        console.error(chalk.yellow(`  ⚠ skipped: ${skipped}`));
      }
      continue;
    }

    const { event, warning } = parseEventLine(line);
    if (warning) {
      warnings++;
      console.error(chalk.yellow(`  ⚠ ${warning}`));
    }
    // A warning does not always mean the line was dropped: validation may keep
    // the event and report a single unusable FIELD it ignored. Applying whatever
    // survived (as `run` already does) keeps the step rather than losing it over
    // one bad number.
    if (!event) continue;
    apply(event);
  }

  // Flush any trailing events the translator holds until EOF.
  if (translator) {
    for (const ev of translator.finalize()) applyTranslated(ev);
  }

  // Finalize any trace still running when the stream ended, so it cannot dangle
  // silently (the documented contract). The ONE exception is the trace this
  // process was handed by an enclosing `agent-replay run`: under the README's
  // nested example (`run -- sh -c '... | agent-replay record'`) the events carry
  // the WRAPPER's trace id, and finalizing it as `timeout` when the pipe closed
  // marked a clean run red and permanently wrong. Excluding only that id keeps
  // the contract for every trace this stream resumed by id, which excluding all
  // non-opened traces had broken — they dangled `running` forever.
  // Only exempt the wrapper's trace when a wrapper is actually ALIVE. `run`
  // removes its channel directory as it finalizes, so an events file that still
  // exists means the enclosing wrapper has not finished — while a stale
  // AGENT_REPLAY_TRACE_ID inherited from a run that already ended would
  // otherwise leave a legitimately resumed trace dangling `running` forever.
  const channel = process.env.AGENT_REPLAY_EVENTS;
  const wrapperAlive = channel != null && channel !== '' && existsSync(channel);
  const wrapperTraceId = wrapperAlive ? process.env.AGENT_REPLAY_TRACE_ID : undefined;
  let finalized = 0;
  if (!opts.leaveOpen) {
    for (const id of touched) {
      if (id === wrapperTraceId && !opened.has(id)) continue;
      const row = db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(id) as
        | { status: string }
        | undefined;
      if (row?.status === 'running') {
        updateTrace(db, id, { status: 'timeout', ended_at: new Date().toISOString() });
        finalized++;
      }
    }
  }

  // Summary. Count the steps THIS stream recorded, not the touched traces'
  // lifetime totals: a producer may resume an existing trace by id (the
  // protocol supports it), and summing `getTrace(...).steps.length` then
  // reported every step the trace had ever accumulated — "Total steps: 3" for a
  // run that recorded one — while every other number in the panel is counted
  // over this stream.

  console.log('');
  console.log(
    summaryPanel('Record Summary', {
      'Traces touched': touched.size,
      'Events applied': applied,
      'Total steps': totalSteps,
      'Finalized as timeout': finalized,
      'Warnings': warnings,
    }),
  );
  console.log('');

  // Per-event leniency is deliberate — one bad line must never cost the rest of
  // the stream (see the hostile-input test). But leniency about *some* events is
  // not the same as reporting a total capture failure as success: when the
  // producer sent input and NOTHING was recorded, a CI pipeline
  // (`agent | agent-replay record && agent-replay check`) read that as a clean
  // run. An empty stream stays exit 0 — no input is not a failure.
  if (applied === 0 && inputLines > 0) {
    console.error(
      chalk.red(
        warnings > 0
          ? `  Nothing was recorded: ${warnings} line(s) drew a warning and none produced an event.`
          : `  Nothing was recorded: none of the ${inputLines} line(s) matched the ${format} format.`,
      ),
    );
    process.exitCode = 1;
  }
}
