import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import {
  addPolicy,
  listPolicies,
  removePolicy,
  setPolicyEnabled,
  testPolicies,
  evaluateStep,
  verdictForMatches,
  resolveGuardExit,
  validateMatchPattern, noEnabledPolicyReason } from '../services/guard-service.js';
import type { StepPolicyResult } from '../services/guard-service.js';
import { ensureDatabase } from '../db/index.js';
import { policyTable } from '../ui/table.js';
import { heading, separator, guardActionBadge, stepIcon, colors, safeText, safeLine} from '../ui/theme.js';
import type { StepType } from '../models/enums.js';
import type { TraceStep } from '../models/types.js';
import { isValidStepType } from '../utils/validators.js';
import { openSync, readSync, closeSync } from 'node:fs';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage, safeParseInt, truncate} from '../utils/json.js';
import { resolveDataDir, storeExists, storeAboveNote, storeSplitNote } from '../utils/paths.js';
import { makeRefuse } from '../utils/refuse.js';

// ── guard list ───────────────────────────────────────────────────────────

export interface GuardListOptions {
  dir?: string;
  json?: boolean;
}

export function runGuardList(opts: GuardListOptions = {}): void {
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Refused, not created — the rule the twelve trace-reading commands adopted
  // and this one never did. `ensureDatabase` CREATES what it does not find, so
  // `guard list` from the wrong directory wrote a store nobody asked for and
  // then answered "No guardrail policies found." at exit 0: the wrong problem,
  // stated confidently, and concealed permanently, because the next run finds a
  // store that now genuinely exists and is genuinely empty. For a policy set
  // that is worse than for traces — the reader concludes the project has no
  // guardrails when it has a full set, one directory up.
  if (!storeExists(resolveDataDir(opts.dir))) {
    // Answered in the caller's shape: a `--json` reader gets the refusal as a
    // document, the same contract every other reading command keeps.
    const above = storeAboveNote(opts.dir);
    makeRefuse(opts.json)(2, `No trace store at ${dbPath}.`, [
      'Run "agent-replay init" in the project directory, or pass --dir <path>.',
      ...(above ? [above] : []),
    ]);
    return;
  }
  const db = ensureDatabase(dbPath);

  const policies = listPolicies(db);

  // The blocking policies that cannot block live, computed once: the table
  // prints them as a warning and `--json` carries the same list, so an audit
  // done by a script sees what an audit done by eye sees.
  const inert = policies.filter(
    (p) => (p.action === 'deny' || p.action === 'require_review')
      && (p.match_pattern as { output_contains?: unknown } | null)?.output_contains != null,
  );

  if (opts.json) {
    // A policy set is configuration, and configuration is what a CI job most
    // wants to assert on ("no disabled deny policies", "this rule is present").
    // Every other reading command answers `--json`; this one printed a table
    // only, so the check had to be a table scrape or a raw SQLite read.
    //
    // Warnings travel WITH the data rather than being left in the rendering:
    // the table's `⚠ ... cannot block live` is the whole point of auditing a
    // policy set, and a JSON reader that could not see it would be told
    // `DENY / enabled` about a rule that never fires.
    console.log(
      JSON.stringify(
        {
          policies,
          warnings: inert.length > 0
            ? [{
                type: 'blocking_policy_matches_on_output',
                policies: inert.map((p) => p.name),
                detail:
                  'Enforcement runs before a tool call, when there is no output yet, so these cannot block live. They still match in `guard test` and on recorded traces.',
              }]
            : [],
        },
        null,
        2,
      ),
    );
    return;
  }

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

  // A blocking policy that matches on OUTPUT cannot block live, and this is the
  // view where that has to be visible. `guard add` says so at the moment it is
  // written — but that warning scrolls away, and the table is the durable
  // record: it shows `DENY / Enabled: Yes`, which reads as an armed kill switch
  // however inert it is against a live tool call. Anyone auditing an inherited
  // store, or their own store a month later, sees only the table.
  //
  // Listed by name rather than flagged with a column, so the table's shape
  // stays as it is; the explanation is the same one `guard add` gives.
  // Enabled state is deliberately not part of the test: enabling one of these
  // later would not make it block either.
  if (inert.length > 0) {
    const names = inert.map((p) => p.name).join(', ');
    console.log(chalk.yellow(`  ⚠ ${inert.length} blocking ${inert.length === 1 ? 'policy matches' : 'policies match'} on output, so ${inert.length === 1 ? 'it cannot' : 'they cannot'} block live: ${names}`));
    console.log(chalk.dim('    Enforcement runs before a tool call, when there is no output yet;'));
    console.log(chalk.dim(`    ${inert.length === 1 ? 'it still matches' : 'they still match'} in \`guard test\` and recorded traces.`));
    console.log('');
  }
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
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // `add` is a WRITE and may create the store it writes into — but a policy
  // written to a store the enforcement path never opens is a guardrail that
  // cannot fire, so say when this is a second store below a project that has
  // one. Same note the capture commands print, for a sharper reason.
  const splitNote = storeSplitNote(opts.dir, dbPath);
  if (splitNote) console.error(chalk.yellow(`  ⚠ ${splitNote}`));
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

  // Reject an unusable pattern up front. A policy stored with an invalid or
  // unsafe name_regex would silently fail to match at evaluation time — a
  // kill-switch that never fires — so it must never be saved.
  const patternError = validateMatchPattern(matchPattern);
  if (patternError) {
    console.error(chalk.red(`  Invalid --pattern: ${patternError}`));
    process.exitCode = 2;
    return;
  }

  // Validate like every other numeric option (list --limit, otel --port,
  // watch --interval, …): `safeParseInt` is a PARSER, so `--priority high`
  // silently stored 0 and `--priority 1e3` stored 1. Priority orders policy
  // evaluation and breaks ties, so a rule the author meant to rank first ranked
  // last and `guard check` cited the wrong policy.
  // An empty value coerces to 0, which is a legal priority (the default) — the
  // same convention `--max-cost ""` follows as a $0 budget, pinned by test.
  // `--limit ""` is a usage error only because 0 is not a legal limit.
  const priority = opts.priority == null ? 0 : Number(opts.priority);
  if (!Number.isInteger(priority)) {
    console.error(chalk.red(`  Invalid --priority: ${opts.priority} (must be an integer).`));
    process.exitCode = 2;
    return;
  }

  const spinner = startSpinner(`Adding policy "${opts.name}"...`);

  try {
    const policy = addPolicy(db, {
      name: opts.name,
      description: opts.description,
      action: opts.action,
      priority,
      match_pattern: matchPattern,
    });

    successSpinner(spinner, `Policy "${opts.name}" added.`);
    console.log(chalk.dim(`  ID: ${policy.id}`));

    // Live enforcement evaluates a *proposed* tool call — before it runs, so it
    // has no output yet — and every match key must match. So a blocking policy
    // keyed on `output_contains` can never fire under `hook --enforce`, however
    // correct it looks in `guard list`. It still matches in post-hoc evaluation
    // (`guard test`, recorded traces), which is a real use, so this is a warning
    // rather than a rejection — but a user writing a kill switch deserves to
    // hear that it will not block anything.
    if ((opts.action === 'deny' || opts.action === 'require_review') && matchPattern.output_contains != null) {
      console.log('');
      console.log(chalk.yellow('  ⚠ This policy matches on output, so it cannot block live.'));
      console.log(chalk.dim('    Enforcement runs before a tool call, when there is no output yet;'));
      console.log(chalk.dim('    the policy still matches in `guard test` and recorded traces.'));
    }
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
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Same rule as `guard list` above: a store this command CREATES can only
  // answer "policy not found", which names the wrong problem.
  if (!storeExists(resolveDataDir(opts.dir))) {
    console.error(chalk.red(`  No trace store at ${dbPath}.`));
    console.error(chalk.dim('  Run "agent-replay init" in the project directory, or pass --dir <path>.'));
    const above = storeAboveNote(opts.dir);
    if (above) console.error(chalk.dim(`  ${above}`));
    process.exitCode = 2;
    return;
  }
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

// ── guard enable / disable ───────────────────────────────────────────────

export interface GuardToggleOptions {
  dir?: string;
}

/**
 * `agent-replay guard enable|disable <policy>` — flip a policy's enabled flag,
 * the one part of the policy model the CLI never exposed. Silencing a policy
 * used to mean deleting it (and retyping it, with a new id, to bring it back).
 */
export function runGuardToggle(policyId: string, enabled: boolean, opts: GuardToggleOptions = {}): void {
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Same rule as `guard list` above: a store this command CREATES can only
  // answer "policy not found", which names the wrong problem.
  if (!storeExists(resolveDataDir(opts.dir))) {
    console.error(chalk.red(`  No trace store at ${dbPath}.`));
    console.error(chalk.dim('  Run "agent-replay init" in the project directory, or pass --dir <path>.'));
    const above = storeAboveNote(opts.dir);
    if (above) console.error(chalk.dim(`  ${above}`));
    process.exitCode = 2;
    return;
  }
  const db = ensureDatabase(dbPath);

  try {
    const name = setPolicyEnabled(db, policyId, enabled);
    // The STORED name, read back from the database — not the argv the user typed.
    console.log(chalk.greenBright(`  Policy "${safeLine(name)}" ${enabled ? 'enabled' : 'disabled'}.`));
    if (!enabled) console.log(chalk.dim('  It stays in "guard list" and stops matching until re-enabled.'));
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
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Same rule as `guard list` above: a store this command CREATES can only
  // answer "policy not found", which names the wrong problem.
  if (!storeExists(resolveDataDir(opts.dir))) {
    console.error(chalk.red(`  No trace store at ${dbPath}.`));
    console.error(chalk.dim('  Run "agent-replay init" in the project directory, or pass --dir <path>.'));
    const above = storeAboveNote(opts.dir);
    if (above) console.error(chalk.dim(`  ${above}`));
    process.exitCode = 2;
    return;
  }
  const db = ensureDatabase(dbPath);

  // Resolve trace
  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    process.exitCode = 1;
    return;
  }

  const spinner = startSpinner(`Testing policies against ${safeText(trace.id.slice(0, 12))}...`);

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
        chalk.dim(`"${safeLine(truncate(result.step.name, 80))}"`) +
        chalk.dim(` (${result.step.step_type})`),
    );

    for (const match of result.matches) {
      console.log(
        `     ${guardActionBadge(match.action)} ` +
          chalk.white(safeLine(match.policy.name)) +
          chalk.dim(` — ${match.reason}`),
      );
    }
    console.log('');
  }

  // Summary
  console.log(separator());
  console.log('');

  const all = results.flatMap((r) => r.matches);
  const denies = all.filter((m) => m.action === 'deny').length;
  const reviews = all.filter((m) => m.action === 'require_review').length;
  const warns = all.filter((m) => m.action === 'warn').length;

  if (denies > 0) {
    console.log(chalk.redBright(`  ${denies} DENY action(s) would block execution.`));
  }
  // `require_review` blocks too — `resolveGuardExit` fails it closed without an
  // approval, which is every non-interactive run. The summary counted only deny
  // and warn, so a trace whose matches were all `require_review` listed them
  // step by step and then printed a summary that said nothing at all: the one
  // line a reader scans to answer "would this run have been stopped?" reported
  // zero for matches that stop it.
  if (reviews > 0) {
    console.log(
      chalk.redBright(`  ${reviews} REQUIRE_REVIEW action(s) would block without an approval.`),
    );
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
  /** Allow the check to run against a store with no enabled policies. */
  allowEmpty?: boolean;
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
  // Every "we could not evaluate this step" answer is a DENY with exit 2, the
  // block signal a wrapper gates on. These paths used to exit 1, which callers
  // read as a non-blocking error and ran the tool — a fail-open on exactly the
  // malformed input a caller cannot vouch for.
  const denied = (reason: string): void => {
    console.error(chalk.redBright(`  DENY: ${reason}`));
    console.error(chalk.dim('  Blocking to fail closed.'));
    console.log(JSON.stringify({ action: 'deny', policy: null, reason }));
    process.exitCode = 2;
  };

  let raw = '';
  try {
    // Decode once over the whole body, not per chunk — see the same read in
    // `hook`: a 64 KiB pipe boundary through a multi-byte character silently
    // corrupted the text a content-based policy matches against.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    // Fail CLOSED, like the policy-evaluation failure below. A step we could not
    // read is a step we could not clear, and exit 1 is not the block signal — 2
    // is — so a wrapper gating on `$? == 2` ran the tool anyway.
    denied(`cannot read the step — ${errorMessage(err)}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    denied('invalid JSON on stdin — expected a single step object');
    return;
  }

  // `null`, an array, or a bare primitive are all valid JSON but not a step
  // object — reject them with a clean message rather than crashing on the
  // property access below (`null.step_type` throws a raw TypeError).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    denied('invalid step on stdin — expected a single step object');
    return;
  }
  const step_input = parsed as Record<string, unknown>;

  // A missing or non-string NAME was quietly coerced to '', which makes every
  // name-keyed policy (`name_contains`, `name_regex`) unable to match — so an
  // under-specified step disabled a whole class of denies and exited 0. Every
  // other unusable field in this command denies; this one now does too.
  if (typeof step_input.name !== 'string' || !step_input.name) {
    denied('step must include a non-empty "name" — name-based policies cannot be evaluated without it');
    return;
  }
  if (typeof step_input.step_type !== 'string' || !isValidStepType(step_input.step_type)) {
    denied('step must include a valid "step_type"');
    return;
  }

  const step: TraceStep = {
    id: '',
    trace_id: '',
    step_number: typeof step_input.step_number === 'number' ? step_input.step_number : 1,
    step_type: step_input.step_type as StepType,
    name: step_input.name as string,
    input: (step_input.input as Record<string, unknown>) ?? {},
    output: (step_input.output as Record<string, unknown>) ?? null,
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

  // Opening the store and evaluating policies must fail CLOSED. Neither call
  // was guarded, so an infrastructure error — an unopenable or read-only store,
  // or SQLITE_BUSY from a concurrent hook process — propagated to the CLI's
  // top-level handler, which exits 1. Exit 1 is not the block signal (2 is), so
  // every harness treated it as a non-blocking error and ran the tool: a gate
  // wired in as a blocking pre-exec check silently stopped denying the moment
  // the DB was locked. `hook --enforce` already fails closed here, and this
  // command's own require_review path fails closed without a TTY, so allowing
  // on "cannot evaluate" contradicted the module's stated posture.
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Same fail-open as `hook --enforce`, in the command the README documents as
  // the out-of-band gate: `ensureDatabase` CREATES what it does not find, so a
  // check run from anywhere but the project root built an empty store, answered
  // `allow` at exit 0, and left that store behind so every later check allowed
  // too. Creating a policy store is what `agent-replay init` is for.
  if (!storeExists(resolveDataDir(opts.dir))) {
    // The same note the read commands add: a gate configured once and then run
    // from a subdirectory of the project is the ordinary way to reach this, and
    // "run init there" would create a second, policy-less store — the exact
    // state this refusal exists to prevent.
    const above = storeAboveNote(opts.dir);
    denied(
      `no trace store at ${dbPath} — run "agent-replay init" there, or point the check at one with --dir` +
        (above ? `. ${above}` : ''),
    );
    return;
  }
  let verdict: ReturnType<typeof verdictForMatches>;
  try {
    const db = ensureDatabase(dbPath);
    // A store that EXISTS but holds no enabled policy is the same failure with
    // the file present: a gate that cannot fire. The store is created by `init`
    // or by any capture hook, so the "brand-new empty policy set answers allow"
    // scenario survived the missing-store check above through that door — in the
    // command the README documents as the gate for harnesses without hooks.
    // Same rule and same opt-out as `hook --enforce`.
    const policies = listPolicies(db);
    if (!opts.allowEmpty && policies.filter((p) => p.enabled).length === 0) {
      denied(noEnabledPolicyReason(dbPath, policies, 'check'));
      return;
    }
    verdict = verdictForMatches(evaluateStep(db, step));
  } catch (err) {
    console.error(chalk.redBright(`  DENY: cannot evaluate policies — ${errorMessage(err)}`));
    console.error(chalk.dim('  Blocking to fail closed.'));
    console.log(JSON.stringify({ action: 'deny', policy: null, reason: `policy evaluation failed: ${errorMessage(err)}` }));
    process.exitCode = 2;
    return;
  }

  // require_review needs a human, so ask the channel the human is actually on.
  // This read `process.stdout.isTTY` — but stdout is this command's MACHINE
  // channel: it carries the JSON verdict, and the README documents capturing it
  // ("so it scripts cleanly"). Any wrapper that does so — `v=$(... | guard
  // check)`, a pipe into `jq` — made stdout a pipe, so an operator sitting at an
  // interactive terminal was reported as "no TTY" and every `require_review`
  // failed closed without ever prompting. The prompt is written to stderr and
  // the answer read from /dev/tty, so stderr is the signal that matches where
  // the interaction happens.
  const isTty = process.stderr.isTTY === true;
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
