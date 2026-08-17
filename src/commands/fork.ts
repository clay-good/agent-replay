import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import { forkTrace } from '../services/fork-service.js';
import { ensureDatabase } from '../db/index.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';
import { safeText } from '../ui/theme.js';

export interface ForkOptions {
  fromStep: string;
  modifyInput?: string;
  modifyContext?: string;
  tag?: string;
  dir?: string;
}

/**
 * `agent-replay fork <trace-id>` — fork a trace at a specific step
 * with optional input/context modifications.
 */
export function runFork(traceId: string, opts: ForkOptions): void {
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  // Resolve trace
  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    process.exitCode = 1;
    return;
  }

  // Parse with Number, not parseInt: `--from-step 1e2` must mean 100 (or be a
  // usage error), not a silently-truncated 1, matching `show`/`replay`'s
  // `--from-step`/`--to-step` and `list --limit`. A non-integer or < 1 is a
  // usage error.
  const fromStep = Number(opts.fromStep);
  if (!Number.isInteger(fromStep) || fromStep < 1) {
    console.error(chalk.red(`  Invalid step number: ${opts.fromStep}`));
    process.exitCode = 2;
    return;
  }

  // Validate the fork point is a real step. step_number can have gaps (a valid
  // ingested/merged trace may be numbered [1, 3]), so checking only against the
  // MAX step would let `--from-step 2` through on a [1, 3] trace — and then
  // --modify-context targets a step that doesn't exist and is silently dropped.
  // Require an exact match so the fork point (and its context edit) always lands.
  const forkPointExists = trace.steps.some((s) => s.step_number === fromStep);
  if (!forkPointExists) {
    const maxStep = trace.steps.length > 0
      ? Math.max(...trace.steps.map((s) => s.step_number))
      : 0;
    console.error(
      chalk.red(`  Step ${fromStep} doesn't exist in this trace (max step ${maxStep}).`),
    );
    process.exitCode = 1;
    return;
  }

  // Parse optional JSON modifications
  let modifiedInput: Record<string, unknown> | undefined;
  let modifiedContext: Record<string, unknown> | undefined;

  if (opts.modifyInput) {
    try {
      modifiedInput = JSON.parse(opts.modifyInput);
    } catch {
      console.error(chalk.red('  Invalid JSON for --modify-input'));
      process.exitCode = 2;
      return;
    }
  }

  if (opts.modifyContext) {
    try {
      modifiedContext = JSON.parse(opts.modifyContext);
    } catch {
      console.error(chalk.red('  Invalid JSON for --modify-context'));
      process.exitCode = 2;
      return;
    }
  }

  const spinner = startSpinner(
    `Forking trace ${safeText(trace.id.slice(0, 12))} at step ${fromStep}...`,
  );

  try {
    // The tag goes in with the fork itself. Writing it afterwards meant any
    // failure on that one statement reported "Fork failed" (exit 1) for a fork
    // that had already committed — an orphan whose id was never printed, with a
    // fresh one created on every retry.
    const result = forkTrace(db, trace.id, fromStep, modifiedInput, modifiedContext, opts.tag);

    successSpinner(spinner, `Forked trace successfully.`);

    console.log('');
    console.log(
      summaryPanel('Fork Result', {
        'Original trace': result.original_trace_id,
        'Forked trace': result.forked_trace_id,
        'Forked from step': result.forked_from_step,
        'Steps copied': result.steps_copied,
        // Report the modification as applied only when the parsed value actually
        // is — mirroring forkTrace's own guards (input: truthy; context:
        // `!= null`). Keying off the raw option string claimed "Yes" for a
        // payload of literal `null`, which the service treats as a no-op.
        ...(modifiedInput ? { 'Modified input': 'Yes' } : {}),
        ...(modifiedContext != null ? { 'Modified context': 'Yes' } : {}),
        ...(opts.tag ? { Tag: opts.tag } : {}),
      }),
    );
    console.log('');
    console.log(
      chalk.dim('  View the fork: ') +
        chalk.white(`agent-replay show ${result.forked_trace_id.slice(0, 8)}`),
    );
    console.log(
      chalk.dim('  Compare:       ') +
        chalk.white(
          `agent-replay diff ${safeText(result.original_trace_id.slice(0, 8))} ${result.forked_trace_id.slice(0, 8)}`,
        ),
    );
    console.log('');
  } catch (err) {
    failSpinner(spinner, `Fork failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}
