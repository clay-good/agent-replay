import type Database from 'better-sqlite3';
import type { GuardrailPolicy, TraceStep } from '../models/types.js';
import type { GuardAction } from '../models/enums.js';
import { STEP_TYPES } from '../models/enums.js';
import { safeRegex } from '../utils/json.js';
import { generateId } from '../utils/id.js';
import { rowToStep } from './trace-service.js';

function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function rowToPolicy(row: Record<string, unknown>): GuardrailPolicy {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    action: row.action as GuardAction,
    priority: row.priority as number,
    enabled: !!(row.enabled as number),
    match_pattern: parseJson(row.match_pattern as string),
    action_params: row.action_params ? parseJson(row.action_params as string) : null,
    tags: parseJsonArray(row.tags as string),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export function addPolicy(
  db: Database.Database,
  policy: {
    name: string;
    description?: string;
    action: string;
    priority?: number;
    match_pattern: Record<string, unknown>;
    action_params?: Record<string, unknown>;
    tags?: string[];
  },
): GuardrailPolicy {
  const id = generateId('pol');
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO guardrail_policies
      (id, name, description, action, priority, enabled, match_pattern, action_params, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    policy.name,
    policy.description ?? null,
    policy.action,
    policy.priority ?? 0,
    JSON.stringify(policy.match_pattern),
    policy.action_params ? JSON.stringify(policy.action_params) : null,
    JSON.stringify(policy.tags ?? []),
    now,
    now,
  );

  const row = db
    .prepare('SELECT * FROM guardrail_policies WHERE id = ?')
    .get(id) as Record<string, unknown>;
  return rowToPolicy(row);
}

export function listPolicies(db: Database.Database): GuardrailPolicy[] {
  const rows = db
    .prepare('SELECT * FROM guardrail_policies ORDER BY priority DESC, name')
    .all() as Record<string, unknown>[];
  return rows.map(rowToPolicy);
}

export function removePolicy(db: Database.Database, policyId: string): void {
  // Resolve by id first, then by name — `WHERE id = ? OR name = ?` deleted BOTH
  // rows when one policy happened to be named after another's id, and reported
  // success. Names are UNIQUE, so each step deletes at most one row.
  const byId = db.prepare('DELETE FROM guardrail_policies WHERE id = ?').run(policyId);
  if (byId.changes > 0) return;

  const byName = db.prepare('DELETE FROM guardrail_policies WHERE name = ?').run(policyId);
  if (byName.changes === 0) {
    throw new Error(`Policy '${policyId}' not found`);
  }
}

// ── Policy testing ────────────────────────────────────────────────────────

export interface PolicyMatch {
  policy: GuardrailPolicy;
  action: string;
  reason: string;
}

export interface StepPolicyResult {
  step: TraceStep;
  matches: PolicyMatch[];
}

/** Load enabled policies, highest priority first. */
function loadEnabledPolicies(db: Database.Database): GuardrailPolicy[] {
  // `name` (UNIQUE) is a stable tiebreaker so the verdict attributes a block to
  // a deterministic policy when several equal-priority policies match a step —
  // `verdictForMatches` keeps the first max-restrictiveness match, so without it
  // the cited policy/reason varied by SQLite's incidental row order. Mirrors the
  // ordering `listPolicies` already uses.
  const rows = db
    .prepare('SELECT * FROM guardrail_policies WHERE enabled = 1 ORDER BY priority DESC, name')
    .all() as Record<string, unknown>[];
  return rows.map(rowToPolicy);
}

/** Evaluate one step against a preloaded policy set. */
function evaluateStepWithPolicies(step: TraceStep, policies: GuardrailPolicy[]): PolicyMatch[] {
  const matches: PolicyMatch[] = [];
  for (const policy of policies) {
    const reason = matchesPolicy(step, policy);
    if (reason) matches.push({ policy, action: policy.action, reason });
  }
  return matches;
}

/**
 * Evaluate a single proposed step against all enabled policies. Used by
 * `guard check` and hook enforcement to decide before a step runs.
 */
export function evaluateStep(db: Database.Database, step: TraceStep): PolicyMatch[] {
  return evaluateStepWithPolicies(step, loadEnabledPolicies(db));
}

/**
 * Test all enabled guardrail policies against each step of a trace.
 * Returns which policies would trigger on which steps.
 */
export function testPolicies(
  db: Database.Database,
  traceId: string,
): StepPolicyResult[] {
  const parsedPolicies = loadEnabledPolicies(db);

  const steps = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number',
    )
    .all(traceId) as Record<string, unknown>[];

  if (steps.length === 0) {
    // Distinguish a missing trace from an empty one so the message isn't
    // misleading (a real trace can legitimately have zero steps).
    const exists = db.prepare('SELECT 1 FROM agent_traces WHERE id = ?').get(traceId);
    throw new Error(exists ? `Trace ${traceId} has no steps to test` : `Trace ${traceId} not found`);
  }

  const results: StepPolicyResult[] = [];
  for (const rawStep of steps) {
    const step = rowToStep(rawStep);
    results.push({ step, matches: evaluateStepWithPolicies(step, parsedPolicies) });
  }
  return results;
}

// ── Verdicts ───────────────────────────────────────────────────────────────

export interface GuardVerdict {
  /** The effective action: the most restrictive of all matching policies. */
  action: GuardAction;
  policy: string | null;
  reason: string | null;
  matches: PolicyMatch[];
}

// Restrictiveness order — a guard fails toward blocking, so the most
// restrictive matching policy wins; ties break by policy priority (matches are
// already ordered priority-descending).
const RESTRICTIVENESS: Record<GuardAction, number> = {
  deny: 3,
  require_review: 2,
  warn: 1,
  allow: 0,
};

/** Reduce a step's policy matches to a single effective verdict. */
export function verdictForMatches(matches: PolicyMatch[]): GuardVerdict {
  if (matches.length === 0) {
    return { action: 'allow', policy: null, reason: null, matches };
  }
  let top = matches[0];
  for (const m of matches) {
    if (RESTRICTIVENESS[m.action as GuardAction] > RESTRICTIVENESS[top.action as GuardAction]) {
      top = m;
    }
  }
  return { action: top.action as GuardAction, policy: top.policy.name, reason: top.reason, matches };
}

/**
 * Resolve a verdict action to a process exit code for `guard check`:
 * allow/warn → 0, deny → 2 (the harness "block" convention). `require_review`
 * prompts when a TTY is present (via `confirmed`) and fails closed (deny) when
 * none is.
 */
export function resolveGuardExit(
  action: GuardAction,
  opts: { isTty: boolean; confirmed?: boolean },
): { final: GuardAction; exitCode: 0 | 2 } {
  switch (action) {
    case 'deny':
      return { final: 'deny', exitCode: 2 };
    case 'require_review':
      if (!opts.isTty) return { final: 'deny', exitCode: 2 };
      return opts.confirmed ? { final: 'allow', exitCode: 0 } : { final: 'deny', exitCode: 2 };
    case 'warn':
      return { final: 'warn', exitCode: 0 };
    case 'allow':
    default:
      return { final: 'allow', exitCode: 0 };
  }
}

// ── Matching logic ────────────────────────────────────────────────────────

/**
 * Validate a match pattern before it is stored, so a policy can never be saved
 * in a form that silently fails open at evaluation time. Returns an error
 * message, or null if the pattern is usable.
 *
 * The critical case: an invalid or ReDoS-rejected `name_regex` makes safeRegex
 * return null, which the matcher would otherwise read as "no match" — a `deny`
 * kill-switch that never fires. Reject it up front instead.
 */
const MATCH_KEYS = [
  'name_contains',
  'input_contains',
  'output_contains',
  'step_type',
  'name_regex',
] as const;

export function validateMatchPattern(pattern: Record<string, unknown>): string | null {
  for (const key of ['name_contains', 'input_contains', 'output_contains', 'step_type'] as const) {
    if (pattern[key] != null && typeof pattern[key] !== 'string') {
      return `${key} must be a string`;
    }
  }
  // step_type is a closed enum: a real step's type is always one of STEP_TYPES
  // (DB CHECK + guard-check input validation), so a pattern with an out-of-enum
  // step_type (e.g. the typo "toolcall" for "tool_call") can never match any
  // step — a saved deny would be a kill-switch that never fires. Validate the
  // value like name_regex, mirroring the keyless-pattern rejection below.
  if (pattern.step_type != null && !(STEP_TYPES as readonly string[]).includes(pattern.step_type as string)) {
    return `step_type must be one of: ${STEP_TYPES.join(', ')}`;
  }
  if (pattern.name_regex != null) {
    if (typeof pattern.name_regex !== 'string') {
      return 'name_regex must be a string';
    }
    if (!safeRegex(pattern.name_regex, 'i')) {
      return `name_regex is not a valid or safe regular expression: ${pattern.name_regex}`;
    }
  }
  // A pattern with no recognized match key matches nothing at evaluation time —
  // a kill-switch that never fires. This catches a typo'd key (e.g. `tool_name`
  // instead of `name_contains`), which would otherwise be silently ignored and
  // the policy saved as a deny that can never block. Require at least one key.
  if (!MATCH_KEYS.some((key) => pattern[key] != null)) {
    return `pattern must include at least one match key (${MATCH_KEYS.join(', ')})`;
  }
  return null;
}

/**
 * The text a `*_contains` pattern is searched against: the JSON form — what
 * this has always matched, so patterns keyed on structure or key names still
 * work — plus every raw string value inside it.
 *
 * `JSON.stringify` escapes quotes, backslashes, newlines and tabs (`\"`, `\\`,
 * `\n`, `\t`), while the needle is the pattern exactly as the user typed it.
 * So a deny on `rm -rf "/etc"`, or on a Windows path like
 * `C:\Windows\System32`, could never match its own step — and did so silently,
 * validating cleanly and listing as an active deny. Those are precisely the
 * shapes a destructive-command policy is written with.
 *
 * Searching both forms only ever adds matches, never removes one, which is the
 * safe direction for a kill-switch.
 */
function searchableText(value: unknown): string {
  const parts: string[] = [JSON.stringify(value) ?? ''];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return parts.join('\n').toLowerCase();
}

/**
 * The lower-cased needle for a `*_contains` pattern, or null when the value
 * can't be searched for at all.
 *
 * A scalar still coerces (a policy written `input_contains: 123` means the text
 * "123"), but an object or array stringifies to `"[object Object]"`, which can
 * never occur in the haystack — an unusable pattern that made a deny silently
 * never fire. Those return null so a blocking policy fails closed, matching how
 * `step_type` and `name_regex` already behave.
 */
function containsNeedle(value: unknown): string | null {
  if (typeof value === 'object') return null;
  return String(value).toLowerCase();
}

function matchesPolicy(step: TraceStep, policy: GuardrailPolicy): string | null {
  const pattern = policy.match_pattern;
  const reasons: string[] = [];
  // A blocking policy must fail toward blocking. If a stored pattern is
  // unusable (e.g. a legacy policy with a bad name_regex, or one inserted
  // outside `guard add`'s validation), a deny/require_review policy treats the
  // step as a match rather than silently skipping; warn/allow just don't fire.
  const failsClosed = policy.action === 'deny' || policy.action === 'require_review';

  // Match by step_type (exact). A non-string step_type can never equal a real
  // step_type, so it's an unusable pattern: fail closed for a blocking policy
  // rather than silently never matching (a deny that never fires), mirroring the
  // name_regex handling below. `guard add` now rejects it up front; this guards a
  // policy stored before that validation existed.
  if (pattern.step_type != null) {
    // Unusable if non-string OR not a real step_type: either can never equal a
    // real step's (enum-constrained) type, so a deny keyed on it would silently
    // never fire. Fail closed for a blocking policy, mirroring name_regex.
    // `guard add` now rejects both up front; this guards a policy stored before
    // that validation existed.
    if (typeof pattern.step_type !== 'string' || !(STEP_TYPES as readonly string[]).includes(pattern.step_type)) {
      if (!failsClosed) return null;
      reasons.push(`step_type '${String(pattern.step_type)}' is unusable — failing closed`);
    } else if (step.step_type !== pattern.step_type) {
      return null; // step_type filter doesn't match — skip
    } else {
      reasons.push(`step_type=${step.step_type}`);
    }
  }

  // Match by step name (contains)
  if (pattern.name_contains != null) {
    const nameStr = String(pattern.name_contains);
    if (!step.name.toLowerCase().includes(nameStr.toLowerCase())) {
      return null;
    }
    reasons.push(`name contains '${nameStr}'`);
  }

  // Match by step name (regex)
  if (pattern.name_regex != null) {
    const regex = safeRegex(String(pattern.name_regex), 'i');
    if (!regex) {
      // Unusable pattern: fail closed for a blocking policy, skip otherwise.
      if (!failsClosed) return null;
      reasons.push(`name_regex '${pattern.name_regex}' is unusable — failing closed`);
    } else if (!regex.test(step.name)) {
      return null;
    } else {
      reasons.push(`name matches /${pattern.name_regex}/`);
    }
  }

  // Match by input field values.
  if (pattern.input_contains != null) {
    const needle = containsNeedle(pattern.input_contains);
    if (needle == null) {
      if (!failsClosed) return null;
      reasons.push(`input_contains '${String(pattern.input_contains)}' is unusable — failing closed`);
    } else if (!searchableText(step.input).includes(needle)) {
      return null;
    } else {
      reasons.push(`input contains '${pattern.input_contains}'`);
    }
  }

  // Match by output pattern (same needle handling as input_contains).
  if (pattern.output_contains != null) {
    const needle = containsNeedle(pattern.output_contains);
    if (needle == null) {
      if (!failsClosed) return null;
      reasons.push(`output_contains '${String(pattern.output_contains)}' is unusable — failing closed`);
    } else if (!searchableText(step.output ?? '').includes(needle)) {
      return null;
    } else {
      reasons.push(`output contains '${pattern.output_contains}'`);
    }
  }

  if (reasons.length === 0) {
    // The pattern carries keys, but not one the matcher recognizes — a typo like
    // `nmae_contains` or `tool_name`. The author clearly meant to filter on
    // something, and the policy can never match anything, so a deny stored this
    // way was a kill-switch that silently never fired while `guard list` showed
    // it active. `guard add` rejects this, but `addPolicy` (used by the seed
    // data and any non-CLI caller) and a direct insert bypass that validation.
    // Fail closed for a blocking policy, like every other unusable-pattern
    // branch above.
    //
    // A genuinely EMPTY pattern is deliberately left inert, even for a deny:
    // it expresses no intent to filter, and blocking every step in the session
    // would be far worse than the misconfiguration it signals.
    if (failsClosed && Object.keys(pattern).length > 0) {
      return 'policy has no usable match criteria — failing closed';
    }
    return null;
  }

  return reasons.join(', ');
}

