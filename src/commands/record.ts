import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { parseEventLine } from '../services/event-protocol.js';
import { applyEvent } from '../services/recorder.js';
import { updateTrace, getTrace } from '../services/trace-service.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { errorMessage } from '../utils/json.js';

export interface RecordOptions {
  format?: string;
  tags?: string;
  leaveOpen?: boolean;
  dir?: string;
}

/**
 * `agent-replay record` — consume a JSONL capture-event stream from stdin and
 * write traces incrementally. Still-open traces are finalized as `timeout` on
 * EOF unless `--leave-open`.
 */
export async function runRecord(opts: RecordOptions = {}): Promise<void> {
  const format = opts.format ?? 'native';
  if (format !== 'native') {
    console.error(
      chalk.red(`  --format ${format} is not supported yet. This build records the native JSONL event protocol.`),
    );
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

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const { event, warning } = parseEventLine(line);
    if (warning) {
      warnings++;
      console.error(chalk.yellow(`  ⚠ ${warning}`));
      continue;
    }
    if (!event) continue;

    // Inject --tags into the opening event.
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
