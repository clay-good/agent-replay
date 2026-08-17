import { resolve } from 'node:path';
import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { getTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceHeaderPanel } from '../ui/boxen-panels.js';
import { stepSpinner, successSpinner, failSpinner, warnSpinner } from '../ui/spinner.js';
import { stepIcon, stepLabel, heading, separator, colors, safeText } from '../ui/theme.js';

import { errorMessage, truncate, hasRenderableContent } from '../utils/json.js';
import { formatDuration } from '../utils/time.js';
import { resolveDataDir } from '../utils/paths.js';

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

  if (steps.length === 0) {
    console.error(chalk.yellow('  No steps in the specified range.'));
    return;
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

  console.log(
    colors.primary('  Replay complete: ') +
      chalk.white(`${steps.length} steps`) +
      chalk.dim(totalMs != null ? ` | ${formatDuration(totalMs)}` : '') +
      chalk.dim(totalTokens != null ? ` | ${totalTokens.toLocaleString()} tokens` : '') +
      (errorSteps.length > 0 ? chalk.redBright(` | ${errorSteps.length} error(s)`) : ''),
  );
  console.log('');
}

// ── Step Replay ──────────────────────────────────────────────────────────

async function replayStep(step: TraceStep, speed: number): Promise<void> {
  const icon = stepIcon(step.step_type as StepType);
  const typeLabel = stepLabel(step.step_type as StepType);
  const name = chalk.white.bold(`"${safeText(step.name)}"`);
  const num = chalk.dim(String(step.step_number).padStart(2));

  // Calculate simulated delay
  const actualMs = step.duration_ms ?? 500;
  const delayMs = speed === 0 ? 0 : Math.min(actualMs / speed, 3000); // cap at 3s

  // Start spinner
  const spinner = stepSpinner(step.step_type as StepType);
  spinner.text = `${num}  ${icon} ${typeLabel}  ${name}`;

  if (step.model) {
    spinner.text += chalk.dim(`  [${safeText(step.model)}]`);
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
    console.log(chalk.red(`       Error: ${safeText(step.error)}`));
  } else if (step.step_type === 'guard_check') {
    warnSpinner(spinner, resultText);
  } else {
    successSpinner(spinner, resultText);
  }

  // Reveal the decision made at this step, mirroring `show`.
  if (step.decision) {
    console.log(
      chalk.dim('       Chose: ') +
        chalk.greenBright(safeText(step.decision.chosen)) +
        (step.decision.rationale ? chalk.dim(` — ${safeText(step.decision.rationale)}`) : ''),
    );
  }

  // Show output summary if present
  if (hasRenderableContent(step.output)) {
    let outputStr: string;
    try {
      outputStr = truncate(JSON.stringify(step.output), 100);
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
