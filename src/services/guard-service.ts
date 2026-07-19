import type Database from 'better-sqlite3';
import type { GuardrailPolicy, TraceStep } from '../models/types.js';
import type { GuardAction } from '../models/enums.js';
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
  const result = db
    .prepare('DELETE FROM guardrail_policies WHERE id = ? OR name = ?')
    .run(policyId, policyId);
  if (result.changes === 0) {
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
  const rows = db
    .prepare('SELECT * FROM guardrail_policies WHERE enabled = 1 ORDER BY priority DESC')
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
    throw new Error(`Trace ${traceId} not found or has no steps`);
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

function matchesPolicy(step: TraceStep, policy: GuardrailPolicy): string | null {
  const pattern = policy.match_pattern;
  const reasons: string[] = [];

  // Match by step_type (exact)
  if (pattern.step_type && step.step_type !== pattern.step_type) {
    return null; // step_type filter doesn't match — skip
  }
  if (pattern.step_type) {
    reasons.push(`step_type=${step.step_type}`);
  }

  // Match by step name (contains)
  if (pattern.name_contains) {
    const nameStr = typeof pattern.name_contains === 'string' ? pattern.name_contains : '';
    if (!step.name.toLowerCase().includes(nameStr.toLowerCase())) {
      return null;
    }
    reasons.push(`name contains '${nameStr}'`);
  }

  // Match by step name (regex)
  if (pattern.name_regex) {
    const regex = safeRegex(pattern.name_regex as string, 'i');
    if (!regex || !regex.test(step.name)) {
      return null;
    }
    reasons.push(`name matches /${pattern.name_regex}/`);
  }

  // Match by input field values
  if (pattern.input_contains) {
    const inputStr = JSON.stringify(step.input).toLowerCase();
    const searchStr = (pattern.input_contains as string).toLowerCase();
    if (!inputStr.includes(searchStr)) {
      return null;
    }
    reasons.push(`input contains '${pattern.input_contains}'`);
  }

  // Match by output pattern
  if (pattern.output_contains) {
    const outputStr = JSON.stringify(step.output ?? '').toLowerCase();
    const searchStr = (pattern.output_contains as string).toLowerCase();
    if (!outputStr.includes(searchStr)) {
      return null;
    }
    reasons.push(`output contains '${pattern.output_contains}'`);
  }

  // If we had any filter criteria and all matched (none returned null), it's a match
  if (reasons.length === 0) {
    return null; // empty pattern matches nothing
  }

  return reasons.join(', ');
}

