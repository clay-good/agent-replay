import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { parseEventLine } from '../services/event-protocol.js';
import type { CaptureEvent } from '../services/event-protocol.js';
import { applyEvent } from '../services/recorder.js';
import { makeTranslator } from '../services/stream-translators.js';
import { updateTrace, getTrace } from '../services/trace-service.js';
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

  const apply = (event: CaptureEvent): void => {
    if (event.type === 'trace_start' && extraTags.length > 0) {
      event.tags = [...(event.tags ?? []), ...extraTags];
    }
    try {
      const { traceId } = applyEvent(db, event);
      touched.add(traceId);
      applied++;
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

  // Summary
  let totalSteps = 0;
  for (const id of touched) {
    const t = getTrace(db, id);
    if (t) totalSteps += t.steps.length;
  }

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
}
