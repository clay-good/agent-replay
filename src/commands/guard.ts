import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import {
  addPolicy,
  listPolicies,
  removePolicy,
  testPolicies,
} from '../services/guard-service.js';
import type { StepPolicyResult } from '../services/guard-service.js';
import { ensureDatabase } from '../db/index.js';
import { policyTable } from '../ui/table.js';
import { heading, separator, guardActionBadge, stepIcon, colors } from '../ui/theme.js';
import type { StepType } from '../models/enums.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage, safeParseInt } from '../utils/json.js';

// ── guard list ───────────────────────────────────────────────────────────

export interface GuardListOptions {
  dir?: string;
}

export function runGuardList(opts: GuardListOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const policies = listPolicies(db);

  if (policies.length === 0) {
    console.log('');
    console.log(chalk.dim('  No guardrail policies found.'));
    console.log(
      chalk.dim('  Add one with ') +
        chalk.white('agent-replay guard add --name <name> --pattern <json> --action deny'),
    );
    console.log('');
    return;
  }

  console.log('');
  console.log(heading(`  ${policies.length} guardrail policy/policies`));
  console.log('');
  console.log(policyTable(policies));
  console.log('');
}

// ── guard add ────────────────────────────────────────────────────────────

export interface GuardAddOptions {
  name: string;
  pattern: string;
  action: string;
  description?: string;
  priority?: string;
  dir?: string;
}

export function runGuardAdd(opts: GuardAddOptions): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // Parse pattern JSON
  let matchPattern: Record<string, unknown>;
  try {
    matchPattern = JSON.parse(opts.pattern);
  } catch {
    console.error(chalk.red('  Invalid JSON for --pattern'));
    console.error(
      chalk.dim(
        '  Example: \'{"step_type":"tool_call","name_contains":"delete"}\'',
      ),
    );
    return;
  }

  // Validate action
  const validActions = ['allow', 'deny', 'warn', 'require_review'];
  if (!validActions.includes(opts.action)) {
    console.error(chalk.red(`  Invalid action: ${opts.action}`));
    console.error(chalk.dim(`  Valid actions: ${validActions.join(', ')}`));
    return;
  }

  const spinner = startSpinner(`Adding policy "${opts.name}"...`);

  try {
    const policy = addPolicy(db, {
      name: opts.name,
      description: opts.description,
      action: opts.action,
      priority: safeParseInt(opts.priority, 0),
      match_pattern: matchPattern,
    });

    successSpinner(spinner, `Policy "${opts.name}" added.`);
    console.log(chalk.dim(`  ID: ${policy.id}`));
    console.log('');
  } catch (err) {
    failSpinner(spinner, `Failed: ${errorMessage(err)}`);
  }
}

// ── guard remove ─────────────────────────────────────────────────────────

export interface GuardRemoveOptions {
  dir?: string;
}

export function runGuardRemove(policyId: string, opts: GuardRemoveOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  try {
    removePolicy(db, policyId);
    console.log(chalk.greenBright(`  Policy "${policyId}" removed.`));
    console.log('');
  } catch (err) {
    console.error(chalk.red(`  ${errorMessage(err)}`));
  }
}

// ── guard test ───────────────────────────────────────────────────────────

export interface GuardTestOptions {
  dir?: string;
}

export function runGuardTest(traceId: string, opts: GuardTestOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // Resolve trace
  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    return;
  }

  const spinner = startSpinner(`Testing policies against ${trace.id.slice(0, 12)}...`);

  let results: StepPolicyResult[];
  try {
    results = testPolicies(db, trace.id);
  } catch (err) {
    failSpinner(spinner, `Test failed: ${errorMessage(err)}`);
    return;
  }

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
  const stepsWithMatches = results.filter((r) => r.matches.length > 0);

  if (totalMatches === 0) {
    successSpinner(spinner, 'No policy violations found.');
    console.log('');
    return;
  }

  successSpinner(
    spinner,
    `Found ${totalMatches} policy match(es) across ${stepsWithMatches.length} step(s).`,
  );
  console.log('');

  // Display results
  for (const result of stepsWithMatches) {
    const icon = stepIcon(result.step.step_type as StepType);
    console.log(
      `  ${icon} ${chalk.white.bold(`Step ${result.step.step_number}`)} — ` +
        chalk.dim(`"${result.step.name}"`) +
        chalk.dim(` (${result.step.step_type})`),
    );

    for (const match of result.matches) {
      console.log(
        `     ${guardActionBadge(match.action)} ` +
          chalk.white(match.policy.name) +
          chalk.dim(` — ${match.reason}`),
      );
    }
    console.log('');
  }

  // Summary
  console.log(separator());
  console.log('');

  const denies = results
    .flatMap((r) => r.matches)
    .filter((m) => m.action === 'deny').length;
  const warns = results
    .flatMap((r) => r.matches)
    .filter((m) => m.action === 'warn').length;

  if (denies > 0) {
    console.log(chalk.redBright(`  ${denies} DENY action(s) would block execution.`));
  }
  if (warns > 0) {
    console.log(chalk.yellow(`  ${warns} WARN action(s) would generate alerts.`));
  }
  console.log('');
}
