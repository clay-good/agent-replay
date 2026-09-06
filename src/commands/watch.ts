import { resolve } from 'node:path';
import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType, TraceStatus } from '../models/enums.js';
import { getTrace, getStepsAfter, getStepsSince, getStepsByNumbers, countSteps, getMostRecentRunningTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { stepIcon, stepLabel, heading, statusBadge, safeText, safeLine} from '../ui/theme.js';
import { formatDuration } from '../utils/time.js';
import { resolveDataDir, storeExists, storeAboveNote } from '../utils/paths.js';
import { escapeForMessage, truncate} from '../utils/json.js';

export interface WatchOptions {
  interval?: string;
  dir?: string;
}

const DEFAULT_POLL_MS = 500;

/** The largest delay `setInterval` stores; above this Node clamps to 1 ms. */
const MAX_POLL_MS = 2_147_483_647;

/**
 * `agent-replay watch [trace-id]` — live-tail a running trace, printing new
 * steps as they are written and announcing the final status on completion.
 * With no trace ID, follows the most recently started running trace.
 */
export function runWatch(traceId: string | undefined, opts: WatchOptions = {}): void {
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Refused, not created — same rule as the other read paths and as
  // `guard check`: `ensureDatabase` CREATES what it does not find, so this
  // wrote an empty store nobody asked for and then watched it forever, which
  // looks exactly like an agent that never started. Creating a store is `init`.
  if (!storeExists(resolveDataDir(opts.dir))) {
    console.error(chalk.red(`  No trace store at ${dbPath}.`));
    console.error(chalk.dim('  Run "agent-replay init" in the project directory, or pass --dir <path>.'));
    // ...and, if the caller is simply standing in a subdirectory of a project
    // that HAS a store, name it: the advice above would otherwise have them
    // create a second one beside their source.
    const above = storeAboveNote(opts.dir);
    if (above) console.error(chalk.dim(`  ${above}`));
    process.exitCode = 2;
    return;
  }
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
    // Node stores a timer delay in a 32-bit signed int and CLAMPS anything
    // larger to 1 ms — so `--interval 999999999999`, which plainly asks to poll
    // almost never, polls SQLite about a thousand times a second instead: the
    // exact inverse of the request. `dashboard --refresh` refuses this for the
    // same reason; `watch` validated only that the number was positive.
    if (n > MAX_POLL_MS) {
      console.error(chalk.red(`  Invalid --interval: ${opts.interval} (maximum is ${MAX_POLL_MS} ms).`));
      console.error(chalk.dim('  A larger value overflows the timer and polls every millisecond instead.'));
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
  // The id is escaped here too. It is constrained at the `record` door, but
  // this was the one render site that omitted the escape, and the rule is to
  // escape unless THIS tool generated the value.
  // One-line header, so the stricter escaper: a newline here would forge a
  // second line into the live view.
  console.log(heading(`  Watching ${escapeForMessage(id)} — ${escapeForMessage(resolved.agent_name)}`));
  console.log(chalk.dim(`  Polling every ${pollMs}ms. Press Ctrl-C to stop.`));
  console.log('');

  // Track which step numbers have been printed, rather than cursoring on the
  // max step number seen. Step numbers are producer-supplied and need not be
  // written in increasing order (only unique per trace), so a `> lastSeen`
  // cursor would silently drop a step whose number is lower than one already
  // printed but which was written later. A seen-set surfaces it on the next poll.
  const seen = new Set<number>();
  // Steps printed while still unfinished, awaiting their closing line.
  const open = new Set<number>();
  // Insertion-order cursor, so a poll reads what arrived rather than the whole
  // trace. See `getStepsSince`: the cost of following a run must not grow with
  // the length of the run.
  let cursor = 0;

  const print = (steps: TraceStep[]): void => {
    for (const s of unseenSteps(steps, seen)) {
      console.log(renderStepLine(s));
      seen.add(s.step_number);
      if (s.ended_at == null) open.add(s.step_number);
    }
    // Under the two-phase protocol (`step_start` then `step_end`) a step is FIRST
    // SEEN open, when its duration, tokens and error are all still null — so
    // printing each step exactly once meant the live tail never showed any of
    // them. A failing run reported its failure with no error text, under a
    // "trace finished: FAILED" badge whose cause `show` displayed but `watch`
    // withheld. Print a closing line when a step gains its outcome.
    for (const s of steps) {
      if (s.ended_at != null && open.delete(s.step_number)) {
        console.log(renderStepLine(s, 'closed'));
      }
    }
  };

  const printNew = (): void => {
    const page = getStepsSince(db, id, cursor);
    cursor = page.cursor;
    // A `step_end` updates a row in place, so a step already past the cursor
    // gains its outcome without becoming a new row: re-read the few still open.
    print([...page.steps, ...getStepsByNumbers(db, id, [...open])]);

    // Insurance, not routine: a rowid is reused when the rows holding the
    // table's highest ones are deleted (deleting a trace cascades to its
    // steps), so a step written afterwards could in principle land BELOW this
    // cursor and never be read. Rather than argue that cannot happen, compare
    // the count — index-only, ~0.1 ms even at 8,000 steps, against the ~11 ms
    // the unconditional full read cost — and reconcile with one full pass if it
    // ever disagrees. The seen-set makes that pass print only what is missing.
    //
    // The comparison is exact rather than approximate because `(trace_id,
    // step_number)` is UNIQUE: one row per step number, so the number of step
    // numbers printed equals the row count precisely when nothing is missing.
    const total = countSteps(db, id);
    if (seen.size !== total) {
      // The cursor is deliberately left where it is: if it is too high, the
      // count keeps disagreeing and this pass keeps running, which is the
      // correct behaviour — and the seen-set means it prints each step once.
      print(getStepsAfter(db, id, 0));
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
    // ...and WHY, when the trace carries a reason. The step-level fix above only
    // covers a failure a step recorded; the two most common failure paths write a
    // TRACE-level error and no step error at all — `run` finalizing a non-zero
    // child exit, and a `trace_end` event carrying `error`. So the one view open
    // at the moment a run dies said "FAILED" and nothing else, while `show` on
    // the same trace printed the reason.
    const finished = getTrace(db, id);
    if (finished?.error) {
      console.log(`  ${chalk.dim('error:')} ${chalk.redBright(safeLine(finished.error))}`);
    }
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

/**
 * One compact line per step for the live tail.
 *
 * `phase` is 'closed' for the follow-up line a two-phase producer's `step_end`
 * earns: the step was already announced by name, so the closing line carries
 * what the opening one could not yet know — outcome, duration, tokens, error.
 */
export function renderStepLine(step: TraceStep, phase: 'full' | 'closed' = 'full'): string {
  const num = chalk.dim(`#${step.step_number}`.padStart(4));
  const dur = step.duration_ms != null ? chalk.dim(`  ${formatDuration(step.duration_ms)}`) : '';
  const tokens = step.tokens_used != null ? chalk.dim(`  ${step.tokens_used.toLocaleString()} tok`) : '';
  const err = step.error ? `  ${chalk.redBright('error:')} ${chalk.red(safeLine(step.error))}` : '';
  if (phase === 'closed') {
    const outcome = step.error ? chalk.redBright('failed') : chalk.dim('done');
    return `  ${num} ${chalk.dim('\u2514')} ${outcome}${dur}${tokens}${err}`;
  }
  const icon = stepIcon(step.step_type as StepType);
  const type = stepLabel(step.step_type as StepType);
  const name = chalk.white.bold(`"${safeLine(truncate(step.name, 80))}"`);
  return `  ${num} ${icon} ${type}  ${name}${dur}${tokens}${err}`;
}
