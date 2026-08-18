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

  /**
   * Parse a --modify-* value, requiring a JSON OBJECT.
   *
   * The result was typed `Record<string, unknown>` and never checked, so
   * `--modify-input 5` stored the trace's input as the scalar `5` — a shape the
   * model type and every other producer path guarantee against, waiting for the
   * first consumer that does `Object.keys(input)`. Both flags are parsed here
   * so they cannot disagree about what they accept.
   */
  /** Distinguishes "rejected" from the legal `null` no-op below. */
  const REJECTED = Symbol('rejected');
  const parseModifier = (raw: string, flag: string): Record<string, unknown> | undefined | typeof REJECTED => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(chalk.red(`  Invalid JSON for ${flag}`));
      process.exitCode = 2;
      return REJECTED;
    }
    // `null` is a deliberate no-op — it keeps the original value, and the
    // summary correctly reports no modification. Preserved explicitly so that
    // requiring an object below does not take it away.
    if (parsed === null) return undefined;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(chalk.red(`  Invalid JSON for ${flag}: expected an object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`));
      process.exitCode = 2;
      return REJECTED;
    }
    return parsed as Record<string, unknown>;
  };

  if (opts.modifyInput) {
    const parsed = parseModifier(opts.modifyInput, '--modify-input');
    if (parsed === REJECTED) return;
    modifiedInput = parsed;
  }

  if (opts.modifyContext) {
    const parsed = parseModifier(opts.modifyContext, '--modify-context');
    if (parsed === REJECTED) return;
    modifiedContext = parsed;
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
