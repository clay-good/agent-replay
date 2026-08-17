import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { parseEventLine } from '../services/event-protocol.js';
import type { CaptureEvent } from '../services/event-protocol.js';
import { applyEvent } from '../services/recorder.js';
import { makeTranslator } from '../services/stream-translators.js';
import { updateTrace } from '../services/trace-service.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { errorMessage } from '../utils/json.js';

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

  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const extraTags = (opts.tags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const touched = new Set<string>();
  let applied = 0;
  let warnings = 0;
  let totalSteps = 0;

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
      applied++;
      if (event.type === 'step' || event.type === 'step_start') totalSteps++;
    } catch (err) {
      warnings++;
      console.error(chalk.yellow(`  ⚠ skipped ${event.type}: ${errorMessage(err)}`));
    }
  };

  const translator = makeTranslator(format);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
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
      for (const ev of translator.translate(obj)) apply(ev);
      continue;
    }

    const { event, warning } = parseEventLine(line);
    if (warning) {
      warnings++;
      console.error(chalk.yellow(`  ⚠ ${warning}`));
      continue;
    }
    if (!event) continue;
    apply(event);
  }

  // Flush any trailing events the translator holds until EOF.
  if (translator) {
    for (const ev of translator.finalize()) apply(ev);
  }

  // Finalize any trace still running when the stream ended.
  let finalized = 0;
  if (!opts.leaveOpen) {
    for (const id of touched) {
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
  // producer sent input and EVERY event was dropped, nothing was recorded and a
  // CI pipeline (`agent | agent-replay record && agent-replay check`) read that
  // as a clean run. An empty stream stays exit 0 — no input is not a failure.
  if (applied === 0 && warnings > 0) {
    console.error(
      chalk.red(`  Nothing was recorded: all ${warnings} event(s) were rejected.`),
    );
    process.exitCode = 1;
  }
}
