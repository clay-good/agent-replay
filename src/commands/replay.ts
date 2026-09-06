import { resolve } from 'node:path';
import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { getTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceHeaderPanel } from '../ui/boxen-panels.js';
import { stepSpinner, successSpinner, failSpinner, warnSpinner } from '../ui/spinner.js';
import { stepIcon, stepLabel, heading, separator, colors, safeText, safeLine } from '../ui/theme.js';

import { errorMessage, truncate, hasRenderableContent } from '../utils/json.js';
import { formatDuration } from '../utils/time.js';
import { resolveDataDir, storeExists, storeAboveNote } from '../utils/paths.js';

export interface ReplayOptions {
  speed?: string;
  pause?: boolean;
  fromStep?: string;
  toStep?: string;
  dir?: string;
}

/**
 * `agent-replay replay <trace-id>` — animated step-by-step replay
 * with ora spinners and simulated timing.
 */
export async function runReplay(
  traceId: string,
  opts: ReplayOptions = {},
): Promise<void> {
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Refused, not created: `ensureDatabase` CREATES what it does not find, so
  // this wrote an empty store nobody asked for and then reported "Trace not
  // found" — naming the wrong problem, since the real one is a wrong working
  // directory or a missing --dir. Same rule as the read commands that share
  // `openStoreOr`, and as `guard check`.
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

  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    process.exitCode = 1;
    return;
  }

  // Validate numeric args so a typo is a clear usage error rather than a silent
  // fallback (matches `show`'s window validation).
  if (opts.speed != null) {
    const s = Number(opts.speed);
    if (!Number.isFinite(s) || s < 0) {
      console.error(chalk.red(`  Invalid --speed: ${opts.speed} (must be a non-negative number).`));
      process.exitCode = 2;
      return;
    }
  }
  // Parse with Number, not parseInt: `--to-step 1e2` must mean 100 (or be a
  // usage error), not a silently-truncated 1, matching `list --limit`/`config`
  // and the --speed check above. A non-integer or < 1 is a usage error.
  let fromStep = 1;
  if (opts.fromStep != null) {
    const n = Number(opts.fromStep);
    if (!Number.isInteger(n) || n < 1) {
      console.error(chalk.red(`  Invalid --from-step: ${opts.fromStep} (must be a positive integer).`));
      process.exitCode = 2;
      return;
    }
    fromStep = n;
  }
  let toStep = Infinity;
  if (opts.toStep != null) {
    const n = Number(opts.toStep);
    if (!Number.isInteger(n) || n < 1) {
      console.error(chalk.red(`  Invalid --to-step: ${opts.toStep} (must be a positive integer).`));
      process.exitCode = 2;
      return;
    }
    toStep = n;
  }
  if (fromStep > toStep) {
    console.error(chalk.red(`  --from-step (${fromStep}) cannot be greater than --to-step (${toStep}).`));
    process.exitCode = 2;
    return;
  }

  // Consume the value validated with Number() above. safeParseFloat/parseFloat
  // would disagree on inputs like "0x10" (Number → 16, parseFloat → 0), replaying
  // at the wrong (here: instant) speed. Keep validation and consumption in sync.
  const speed = opts.speed != null ? Number(opts.speed) : 5;

  // Filter steps to the requested range
  const steps = trace.steps.filter(
    (s) => s.step_number >= fromStep && s.step_number <= toStep,
  );

  // A window that matched nothing is a failure, not a quiet success.
  //
  // This said so on stderr and then exited 0, so `replay <id> --from-step $N`
  // in a script reported success having replayed NOTHING — the one outcome the
  // command exists to rule out. `fork`, the sibling that takes the same
  // `--from-step` against the same trace, has always refused this at exit 1,
  // and for the same reason: the caller named steps of a specific trace that do
  // not exist. (An empty `list` stays exit 0 — that is a filter over a corpus
  // legitimately matching nothing, not a request that could never be served.)
  //
  // Name the range that DOES exist, as `fork` names its max step, so the caller
  // can correct the command from this line alone. step_number can have gaps, so
  // report the real endpoints rather than 1..length.
  if (steps.length === 0) {
    const numbers = trace.steps.map((s) => s.step_number);
    const have = numbers.length
      ? `this trace has steps ${Math.min(...numbers)}-${Math.max(...numbers)}`
      : 'this trace has no steps';
    console.error(chalk.red(`  No steps in the specified range (${have}).`));
    process.exitCode = 1;
    return;
  }

  // Say when --pause cannot do anything, rather than accepting it and ignoring
  // it. `waitForKeypress` returns immediately when stdin is not a TTY (there is
  // no one to press a key, and blocking would hang a pipeline), so
  // `replay <id> --pause | less`, or a --pause left in a CI script, replayed
  // straight through at full speed and reported the same success as a paused
  // run — the flag silently did nothing. This is the warning `export` already
  // prints for `--with-snapshots --format golden`: a flag that cannot take
  // effect is worth one line on stderr, not silence. Not a refusal — the replay
  // itself is still exactly what was asked for.
  //
  // stdin, not stdout: "is a human present to press a key?" is a question about
  // the INPUT channel. Reading it from stdout is the bug `guard check` had.
  if (opts.pause && !process.stdin.isTTY) {
    console.error(chalk.yellow('  ⚠ --pause has no effect without an interactive terminal.'));
    console.error(chalk.dim('    stdin is not a TTY, so there is no keypress to wait for; replaying straight through.'));
  }

  // Header
  console.log('');
  console.log(traceHeaderPanel(trace));
  console.log('');
  console.log(
    heading('  Replaying') +
      chalk.dim(` steps ${steps[0].step_number}-${steps[steps.length - 1].step_number}`) +
      chalk.dim(speed === 0 ? ' (instant)' : ` at ${speed}x speed`),
  );
  console.log('');

  // Replay each step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLast = i === steps.length - 1;

    await replayStep(step, speed);

    // Pause between steps if requested
    if (opts.pause && !isLast) {
      await waitForKeypress();
    }
  }

  // Summary
  console.log('');
  console.log(separator());
  console.log('');

  // Sum only the steps that were actually timed. `?? 0` made "unmeasured"
  // indistinguishable from "instant": on a trace whose steps carry no
  // duration_ms, this printed "| 0ms" directly below the header panel THIS
  // COMMAND had just printed showing the trace's real duration — two
  // contradictory durations on one screen. With nothing timed, say nothing.
  const timed = steps.filter((s) => s.duration_ms != null);
  const totalMs = timed.length ? timed.reduce((sum, s) => sum + (s.duration_ms as number), 0) : null;
  // Same for tokens: a measured total of 0 is a fact, absence is not.
  const counted = steps.filter((s) => s.tokens_used != null);
  const totalTokens = counted.length ? counted.reduce((sum, s) => sum + (s.tokens_used as number), 0) : null;
  const errorSteps = steps.filter((s) => s.error);

  // Say what each total was taken OVER when it is a sum over a subset.
  //
  // A trace mixing timed and untimed steps reported "3 steps | 150ms" — the sum
  // of the two steps that carried a duration, presented as the run's. An
  // imported session is exactly this shape: its steps are finished but
  // undurated, because a transcript records when a record was written and not
  // how long a tool took. Same disclosure `stats` makes with "(over N of M)"
  // and `eval` now makes for a criterion that measured nothing: the number
  // stands, the reader is told what it covers.
  const over = (measured: number): string =>
    measured === steps.length ? '' : ` (over ${measured} of ${steps.length})`;

  console.log(
    colors.primary('  Replay complete: ') +
      chalk.white(`${steps.length} steps`) +
      chalk.dim(totalMs != null ? ` | ${formatDuration(totalMs)}${over(timed.length)}` : '') +
      chalk.dim(totalTokens != null ? ` | ${totalTokens.toLocaleString()} tokens${over(counted.length)}` : '') +
      (errorSteps.length > 0 ? chalk.redBright(` | ${errorSteps.length} error(s)`) : ''),
  );
  console.log('');
}

// ── Step Replay ──────────────────────────────────────────────────────────

async function replayStep(step: TraceStep, speed: number): Promise<void> {
  const icon = stepIcon(step.step_type as StepType);
  const typeLabel = stepLabel(step.step_type as StepType);
  const name = chalk.white.bold(`"${safeLine(truncate(step.name, 80))}"`);
  const num = chalk.dim(String(step.step_number).padStart(2));

  // Calculate simulated delay
  const actualMs = step.duration_ms ?? 500;
  const delayMs = speed === 0 ? 0 : Math.min(actualMs / speed, 3000); // cap at 3s

  // Start spinner
  const spinner = stepSpinner(step.step_type as StepType);
  spinner.text = `${num}  ${icon} ${typeLabel}  ${name}`;

  if (step.model) {
    spinner.text += chalk.dim(`  [${safeLine(step.model)}]`);
  }

  // Wait for simulated duration
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  // Complete spinner based on outcome
  const durStr = step.duration_ms != null ? chalk.dim(` (${formatDuration(step.duration_ms)})`) : '';
  const tokenStr = step.tokens_used != null ? chalk.dim(` [${step.tokens_used} tok]`) : '';
  const resultText = `${num}  ${icon} ${typeLabel}  ${name}${durStr}${tokenStr}`;

  if (step.error) {
    failSpinner(spinner, resultText);
    console.log(chalk.red(`       Error: ${safeLine(step.error)}`));
  } else if (step.step_type === 'guard_check') {
    warnSpinner(spinner, resultText);
  } else {
    successSpinner(spinner, resultText);
  }

  // Reveal the decision made at this step, mirroring `show`.
  if (step.decision) {
    console.log(
      chalk.dim('       Chose: ') +
        chalk.greenBright(safeLine(step.decision.chosen)) +
        (step.decision.rationale ? chalk.dim(` — ${safeLine(step.decision.rationale)}`) : ''),
    );
  }

  // Show output summary if present
  if (hasRenderableContent(step.output)) {
    let outputStr: string;
    try {
      // safeText AFTER stringification: JSON.stringify escapes C0 but not C1
      // (U+0080-U+009F), and terminals decode U+009B as CSI. Same reason as the
      // timeline helper.
      outputStr = safeText(truncate(JSON.stringify(step.output), 100));
    } catch {
      outputStr = '[complex object]';
    }
    console.log(chalk.dim(`       Output: ${outputStr}`));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForKeypress(): Promise<void> {
  // Skip pause in non-interactive environments to avoid hanging
  if (!process.stdin.isTTY) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    console.log(chalk.dim('       Press any key to continue...'));
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
    };

    process.stdin.once('data', (data) => {
      cleanup();
      // Ctrl+C during pause — exit gracefully
      if (data[0] === 3) {
        process.exit(0);
      }
      resolve();
    });
  });
}
