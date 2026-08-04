import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import { forkTrace } from '../services/fork-service.js';
import { ensureDatabase } from '../db/index.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage, safeJsonParse } from '../utils/json.js';

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
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // Resolve trace
  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    process.exitCode = 1;
    return;
  }

  const fromStep = parseInt(opts.fromStep, 10);
  if (isNaN(fromStep) || fromStep < 1) {
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
    `Forking trace ${trace.id.slice(0, 12)} at step ${fromStep}...`,
  );

  try {
    const result = forkTrace(db, trace.id, fromStep, modifiedInput, modifiedContext);

    // Apply tag if provided
    if (opts.tag) {
      const existing = db
        .prepare('SELECT tags FROM agent_traces WHERE id = ?')
        .get(result.forked_trace_id) as { tags: string } | undefined;
      const tags = existing ? (safeJsonParse<string[]>(existing.tags) ?? []) : [];
      tags.push(opts.tag);
      db.prepare('UPDATE agent_traces SET tags = ? WHERE id = ?')
        .run(JSON.stringify(tags), result.forked_trace_id);
    }

    successSpinner(spinner, `Forked trace successfully.`);

    console.log('');
    console.log(
      summaryPanel('Fork Result', {
        'Original trace': result.original_trace_id,
        'Forked trace': result.forked_trace_id,
        'Forked from step': result.forked_from_step,
        'Steps copied': result.steps_copied,
        ...(opts.modifyInput ? { 'Modified input': 'Yes' } : {}),
        ...(opts.modifyContext ? { 'Modified context': 'Yes' } : {}),
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
          `agent-replay diff ${result.original_trace_id.slice(0, 8)} ${result.forked_trace_id.slice(0, 8)}`,
        ),
    );
    console.log('');
  } catch (err) {
    failSpinner(spinner, `Fork failed: ${errorMessage(err)}`);
  }
}
