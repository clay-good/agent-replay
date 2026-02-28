import { resolve } from 'node:path';
import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { getTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceHeaderPanel } from '../ui/boxen-panels.js';
import { stepSpinner, successSpinner, failSpinner, warnSpinner } from '../ui/spinner.js';
import { stepIcon, stepLabel, heading, separator, colors } from '../ui/theme.js';
import { errorMessage, safeParseFloat, safeParseInt } from '../utils/json.js';

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
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    return;
  }

  const speed = safeParseFloat(opts.speed, 5);
  const fromStep = safeParseInt(opts.fromStep, 1);
  const toStep = opts.toStep ? safeParseInt(opts.toStep, Infinity) : Infinity;

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

  const totalMs = steps.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokens_used ?? 0), 0);
  const errorSteps = steps.filter((s) => s.error);

  console.log(
    colors.primary('  Replay complete: ') +
      chalk.white(`${steps.length} steps`) +
      chalk.dim(` | ${formatDuration(totalMs)}`) +
      chalk.dim(totalTokens > 0 ? ` | ${totalTokens.toLocaleString()} tokens` : '') +
      (errorSteps.length > 0 ? chalk.redBright(` | ${errorSteps.length} error(s)`) : ''),
  );
  console.log('');
}

// ── Step Replay ──────────────────────────────────────────────────────────

async function replayStep(step: TraceStep, speed: number): Promise<void> {
  const icon = stepIcon(step.step_type as StepType);
  const typeLabel = stepLabel(step.step_type as StepType);
  const name = chalk.white.bold(`"${step.name}"`);
  const num = chalk.dim(String(step.step_number).padStart(2));

  // Calculate simulated delay
  const actualMs = step.duration_ms ?? 500;
  const delayMs = speed === 0 ? 0 : Math.min(actualMs / speed, 3000); // cap at 3s

  // Start spinner
  const spinner = stepSpinner(step.step_type as StepType);
  spinner.text = `${num}  ${icon} ${typeLabel}  ${name}`;

  if (step.model) {
    spinner.text += chalk.dim(`  [${step.model}]`);
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
    console.log(chalk.red(`       Error: ${step.error}`));
  } else if (step.step_type === 'guard_check') {
    warnSpinner(spinner, resultText);
  } else {
    successSpinner(spinner, resultText);
  }

  // Show output summary if present
  if (step.output && Object.keys(step.output).length > 0) {
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
