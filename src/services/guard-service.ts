import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { GuardrailPolicy, TraceStep } from '../models/types.js';
import type { GuardAction } from '../models/enums.js';
import { safeRegex } from '../utils/json.js';

function generateId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

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

/**
 * Test all enabled guardrail policies against each step of a trace.
 * Returns which policies would trigger on which steps.
 */
export function testPolicies(
  db: Database.Database,
  traceId: string,
): StepPolicyResult[] {
  const policies = db
    .prepare('SELECT * FROM guardrail_policies WHERE enabled = 1 ORDER BY priority DESC')
    .all() as Record<string, unknown>[];

  const steps = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number',
    )
    .all(traceId) as Record<string, unknown>[];

  if (steps.length === 0) {
    throw new Error(`Trace ${traceId} not found or has no steps`);
  }

  const parsedPolicies = policies.map(rowToPolicy);

  const results: StepPolicyResult[] = [];

  for (const rawStep of steps) {
    const step = rowToTraceStep(rawStep);
    const matches: PolicyMatch[] = [];

    for (const policy of parsedPolicies) {
      const match = matchesPolicy(step, policy);
      if (match) {
        matches.push({
          policy,
          action: policy.action,
          reason: match,
        });
      }
    }

    results.push({ step, matches });
  }

  return results;
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

function rowToTraceStep(row: Record<string, unknown>): TraceStep {
  return {
    id: row.id as string,
    trace_id: row.trace_id as string,
    step_number: row.step_number as number,
    step_type: row.step_type as TraceStep['step_type'],
    name: row.name as string,
    input: parseJson(row.input as string),
    output: row.output ? parseJson(row.output as string) : null,
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    tokens_used: (row.tokens_used as number) ?? null,
    model: (row.model as string) ?? null,
    error: (row.error as string) ?? null,
    metadata: parseJson(row.metadata as string),
  };
}
