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
  tags?: string;
  leaveOpen?: boolean;
  dir?: string;
}

const FORMATS = ['native', 'codex-exec', 'gemini-stream'];

/**
 * `agent-replay record` — consume an event stream from stdin and write traces
 * incrementally. Reads the native JSONL protocol by default, or translates a
 * harness's own stream via `--format codex-exec` / `gemini-stream`. Still-open
 * traces are finalized as `timeout` on EOF unless `--leave-open`.
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
    if (event.type === 'trace_start' && extraTags.length > 0) {
      // Only merge into an actual array. Spreading a producer's non-array
      // `tags` threw here — OUTSIDE the per-event try below — which aborted the
      // whole stream and lost every trace in it, not just the bad event. A
      // string would also have spread into one tag per character.
      const own = Array.isArray(event.tags) ? event.tags : [];
      event.tags = [...own, ...extraTags];
    }
    try {
      const { traceId } = applyEvent(db, event);
      touched.add(traceId);
      if (event.type === 'trace_start') opened.add(traceId);
      applied++;
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
