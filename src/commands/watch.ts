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

  // Reject a malformed --interval up front — before resolving the trace — rather
  // than silently polling at the default (which would hide a typo), matching
  // `dashboard --refresh`. Validating first means a bad value is a usage error
  // even when there is no trace to watch.
  let pollMs = DEFAULT_POLL_MS;
  if (opts.interval != null) {
    const n = Number(opts.interval);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(chalk.red(`  Invalid --interval: ${opts.interval} (must be a positive number of milliseconds).`));
      process.exitCode = 2;
      return;
    }
    pollMs = n;
  }

  const resolved = traceId ? getTrace(db, traceId) : getMostRecentRunningTrace(db);
  if (!resolved) {
    if (traceId) {
      // An explicitly named trace that doesn't exist is an error; the auto case
      // (nothing running) is a normal empty state, so leave its exit code at 0.
      console.error(chalk.red(`  Trace not found: ${traceId}`));
      process.exitCode = 1;
    } else {
      console.error(chalk.dim('  No running trace to watch. Start one with "agent-replay record".'));
    }
    return;
  }

  const id = resolved.id;

  console.log('');
  console.log(heading(`  Watching ${id} — ${resolved.agent_name}`));
  console.log(chalk.dim(`  Polling every ${pollMs}ms. Press Ctrl-C to stop.`));
  console.log('');

  // Track which step numbers have been printed, rather than cursoring on the
  // max step number seen. Step numbers are producer-supplied and need not be
  // written in increasing order (only unique per trace), so a `> lastSeen`
  // cursor would silently drop a step whose number is lower than one already
  // printed but which was written later. A seen-set surfaces it on the next poll.
  const seen = new Set<number>();
  const printNew = (): void => {
    for (const s of unseenSteps(getStepsAfter(db, id, 0), seen)) {
      console.log(renderStepLine(s));
      seen.add(s.step_number);
    }
  };
  printNew();

  const finish = (status: TraceStatus): void => {
    clearInterval(timer);
    // Drain once more before finishing. The producer is a separate process and
    // can commit a final step AND flip status to a terminal value in the gap
    // between this tick's printNew() and the status read that detected
    // completion; without this last pass that step is dropped from the tail even
    // though `show` displays it.
    printNew();
    console.log('');
    console.log(`  ${chalk.dim('trace finished:')} ${statusBadge(status)}`);
    console.log('');
  };

  const timer = setInterval(() => {
    printNew();

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

/**
 * The steps whose numbers have not yet been printed, preserving input order.
 * Cursoring on a seen-set (rather than the max step number) keeps the tail from
 * dropping a step written after a higher-numbered one.
 */
export function unseenSteps(steps: TraceStep[], seen: Set<number>): TraceStep[] {
  return steps.filter((s) => !seen.has(s.step_number));
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
