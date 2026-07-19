import { resolve } from 'node:path';
import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType, TraceStatus } from '../models/enums.js';
import { getTrace, getStepsAfter, getMostRecentRunningTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { stepIcon, stepLabel, heading, statusBadge } from '../ui/theme.js';
import { formatDuration } from '../utils/time.js';

export interface WatchOptions {
  interval?: string;
  dir?: string;
}

const DEFAULT_POLL_MS = 500;

/**
 * `agent-replay watch [trace-id]` — live-tail a running trace, printing new
 * steps as they are written and announcing the final status on completion.
 * With no trace ID, follows the most recently started running trace.
 */
export function runWatch(traceId: string | undefined, opts: WatchOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const resolved = traceId ? getTrace(db, traceId) : getMostRecentRunningTrace(db);
  if (!resolved) {
    if (traceId) {
      console.error(chalk.red(`  Trace not found: ${traceId}`));
    } else {
      console.error(chalk.dim('  No running trace to watch. Start one with "agent-replay record".'));
    }
    return;
  }

  const id = resolved.id;
  const pollMs = Number(opts.interval) > 0 ? Number(opts.interval) : DEFAULT_POLL_MS;

  console.log('');
  console.log(heading(`  Watching ${id} — ${resolved.agent_name}`));
  console.log(chalk.dim(`  Polling every ${pollMs}ms. Press Ctrl-C to stop.`));
  console.log('');

  // Render steps already present, then tail from the last of them.
  const existing = getStepsAfter(db, id, 0);
  for (const s of existing) console.log(renderStepLine(s));
  let lastSeen = existing.length > 0 ? existing[existing.length - 1].step_number : 0;

  const finish = (status: TraceStatus): void => {
    clearInterval(timer);
    console.log('');
    console.log(`  ${chalk.dim('trace finished:')} ${statusBadge(status)}`);
    console.log('');
  };

  const timer = setInterval(() => {
    const fresh = getStepsAfter(db, id, lastSeen);
    for (const s of fresh) {
      console.log(renderStepLine(s));
      lastSeen = s.step_number;
    }

    const row = db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(id) as
      | { status: TraceStatus }
      | undefined;
    if (row && row.status !== 'running') {
      finish(row.status);
    }
  }, pollMs);

  // Stop cleanly on Ctrl-C.
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('');
    console.log(chalk.dim('  watch stopped.'));
    process.exit(0);
  });
}

/** One compact line per step for the live tail. */
export function renderStepLine(step: TraceStep): string {
  const num = chalk.dim(`#${step.step_number}`.padStart(4));
  const icon = stepIcon(step.step_type as StepType);
  const type = stepLabel(step.step_type as StepType);
  const name = chalk.white.bold(`"${step.name}"`);
  const dur = step.duration_ms != null ? chalk.dim(`  ${formatDuration(step.duration_ms)}`) : '';
  const tokens = step.tokens_used != null ? chalk.dim(`  ${step.tokens_used.toLocaleString()} tok`) : '';
  const err = step.error ? `  ${chalk.redBright('error:')} ${chalk.red(step.error)}` : '';
  return `  ${num} ${icon} ${type}  ${name}${dur}${tokens}${err}`;
}
