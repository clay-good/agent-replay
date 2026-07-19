import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import {
  addPolicy,
  listPolicies,
  removePolicy,
  testPolicies,
  evaluateStep,
  verdictForMatches,
  resolveGuardExit,
} from '../services/guard-service.js';
import type { StepPolicyResult } from '../services/guard-service.js';
import { ensureDatabase } from '../db/index.js';
import { policyTable } from '../ui/table.js';
import { heading, separator, guardActionBadge, stepIcon, colors } from '../ui/theme.js';
import type { StepType } from '../models/enums.js';
import type { TraceStep } from '../models/types.js';
import { isValidStepType } from '../utils/validators.js';
import { openSync, readSync, closeSync } from 'node:fs';
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
    process.exitCode = 2;
    return;
  }

  // Validate action
  const validActions = ['allow', 'deny', 'warn', 'require_review'];
  if (!validActions.includes(opts.action)) {
    console.error(chalk.red(`  Invalid action: ${opts.action}`));
    console.error(chalk.dim(`  Valid actions: ${validActions.join(', ')}`));
    process.exitCode = 2;
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
    process.exitCode = 1;
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
    process.exitCode = 1;
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
    process.exitCode = 1;
    return;
  }

  const spinner = startSpinner(`Testing policies against ${trace.id.slice(0, 12)}...`);

  let results: StepPolicyResult[];
  try {
    results = testPolicies(db, trace.id);
  } catch (err) {
    failSpinner(spinner, `Test failed: ${errorMessage(err)}`);
    process.exitCode = 1;
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

// ── guard check ────────────────────────────────────────────────────────────

export interface GuardCheckOptions {
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay guard check` — evaluate a single proposed step (JSON on stdin)
 * against enabled policies and answer by exit code: 0 for allow/warn, 2 for
 * deny. `require_review` prompts when a TTY is present and fails closed (deny)
 * otherwise. This is a guardrail, not a complete security boundary — a
 * determined agent may reach equivalent effects by another tool path; use OS
 * sandboxing (Claude Code sandbox, Codex sandbox_mode, Gemini sandbox) for hard
 * isolation.
 */
export async function runGuardCheck(opts: GuardCheckOptions = {}): Promise<void> {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch (err) {
    console.error(chalk.red(`  Failed to read stdin: ${errorMessage(err)}`));
    process.exitCode = 1;
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    console.error(chalk.red('  Invalid JSON on stdin — expected a single step object.'));
    process.exitCode = 1;
    return;
  }

  if (typeof parsed.step_type !== 'string' || !isValidStepType(parsed.step_type)) {
    console.error(chalk.red('  Step must include a valid "step_type".'));
    process.exitCode = 1;
    return;
  }

  const step: TraceStep = {
    id: '',
    trace_id: '',
    step_number: typeof parsed.step_number === 'number' ? parsed.step_number : 1,
    step_type: parsed.step_type as StepType,
    name: typeof parsed.name === 'string' ? parsed.name : '',
    input: (parsed.input as Record<string, unknown>) ?? {},
    output: (parsed.output as Record<string, unknown>) ?? null,
    started_at: '',
    ended_at: null,
    duration_ms: null,
    tokens_used: null,
    model: null,
    error: null,
    metadata: {},
    parent_step_number: null,
    caused_by_step_number: null,
  };

  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const verdict = verdictForMatches(evaluateStep(db, step));

  // require_review needs a human; prompt via /dev/tty when interactive.
  const isTty = process.stdout.isTTY === true;
  let confirmed: boolean | undefined;
  if (verdict.action === 'require_review' && isTty) {
    confirmed = confirmReviewViaTty(verdict.reason ?? 'review required');
  }
  const { final, exitCode } = resolveGuardExit(verdict.action, { isTty, confirmed });

  // JSON verdict to stdout (the reason also goes to stderr for deny/warn).
  console.log(JSON.stringify({ action: final, policy: verdict.policy, reason: verdict.reason }));

  if (final === 'deny') {
    const why = verdict.action === 'require_review'
      ? `review required${isTty ? ' (declined)' : ' (no TTY — failed closed)'}: ${verdict.reason ?? ''}`
      : verdict.reason ?? 'blocked by policy';
    console.error(chalk.redBright(`  DENY [${verdict.policy ?? 'policy'}]: ${why}`));
  } else if (final === 'warn') {
    console.error(chalk.yellow(`  WARN [${verdict.policy ?? 'policy'}]: ${verdict.reason ?? ''}`));
  }

  process.exitCode = exitCode;
}

function confirmReviewViaTty(reason: string): boolean {
  try {
    const fd = openSync('/dev/tty', 'rs');
    process.stderr.write(`\n  ⚠ require_review: ${reason}\n  Allow this step? [y/N] `);
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, null);
    closeSync(fd);
    const ans = buf.toString('utf-8', 0, n).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } catch {
    return false;
  }
}
