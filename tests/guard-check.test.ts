import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { addPolicy, evaluateStep, verdictForMatches, resolveGuardExit, testPolicies, removePolicy } from '../src/services/guard-service.js';
import { startTrace, ingestTrace } from '../src/services/trace-service.js';
import type { TraceStep } from '../src/models/types.js';
import type { StepType } from '../src/models/enums.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

function makeStep(over: Partial<TraceStep> & { step_type: StepType; name: string }): TraceStep {
  return {
    id: '', trace_id: '', step_number: 1,
    input: {}, output: null, started_at: '', ended_at: null, duration_ms: null,
    tokens_used: null, model: null, error: null, metadata: {},
    parent_step_number: null, caused_by_step_number: null,
    ...over,
  };
}

// ── evaluateStep + verdictForMatches ──────────────────────────────────────

describe('single-step evaluation', () => {
  it('allows when no policy matches', () => {
    addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'search_flights' })));
    expect(v.action).toBe('allow');
    expect(v.policy).toBeNull();
  });

  it('denies a matching tool call', () => {
    addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_user' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('no-delete');
    expect(v.reason).toContain('delete');
  });

  it('matches name_contains case-insensitively, so casing cannot bypass a policy', () => {
    addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    for (const name of ['DELETE_USER', 'Delete_User', 'deLeTe_records']) {
      const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name })));
      expect(v.action, name).toBe('deny');
    }
  });

  it('warns without blocking', () => {
    addPolicy(db, { name: 'token-warn', action: 'warn', match_pattern: { step_type: 'llm_call' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'llm_call', name: 'generate' })));
    expect(v.action).toBe('warn');
  });

  it('matches a destructive command in the tool input via input_contains (case-insensitive)', () => {
    addPolicy(db, { name: 'no-rm-rf', action: 'deny', match_pattern: { input_contains: 'rm -rf' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', input: { cmd: 'RM -RF /data' } })));
    expect(v.action).toBe('deny');
  });

  it('matches on step output via output_contains (case-insensitive)', () => {
    addPolicy(db, { name: 'no-urls', action: 'deny', match_pattern: { output_contains: 'http' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'fetch', output: { body: 'go to HTTP://evil.example' } })));
    expect(v.action).toBe('deny');
  });

  it('matches by name_regex and lets non-matching names through', () => {
    addPolicy(db, { name: 'destructive', action: 'deny', match_pattern: { name_regex: '^(delete|drop|truncate)_' } });
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'drop_table' }))).action).toBe('deny');
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_table' }))).action).toBe('allow');
  });

  it('requires every pattern field to match (AND semantics)', () => {
    addPolicy(db, { name: 'combo', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    // Right name but wrong step_type → the policy does not fire.
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'llm_call', name: 'delete_it' }))).action).toBe('allow');
  });

  it('treats an empty match pattern as inert (a misconfigured policy blocks nothing)', () => {
    addPolicy(db, { name: 'empty', action: 'deny', match_pattern: {} });
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' }))).action).toBe('allow');
  });

  it('picks the most restrictive action when several match, regardless of priority', () => {
    // A high-priority warn and a low-priority deny both match the same step.
    addPolicy(db, { name: 'warn-high', action: 'warn', priority: 100, match_pattern: { step_type: 'tool_call' } });
    addPolicy(db, { name: 'deny-low', action: 'deny', priority: 1, match_pattern: { name_contains: 'wire' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'wire_transfer' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('deny-low');
  });
});

// ── resolveGuardExit (exit-code contract, TTY vs non-TTY) ──────────────────

describe('resolveGuardExit', () => {
  it('maps allow and warn to exit 0', () => {
    expect(resolveGuardExit('allow', { isTty: false }).exitCode).toBe(0);
    expect(resolveGuardExit('warn', { isTty: false }).exitCode).toBe(0);
  });

  it('maps deny to exit 2', () => {
    expect(resolveGuardExit('deny', { isTty: false })).toEqual({ final: 'deny', exitCode: 2 });
  });

  it('require_review fails closed without a TTY', () => {
    expect(resolveGuardExit('require_review', { isTty: false })).toEqual({ final: 'deny', exitCode: 2 });
  });

  it('require_review honors the confirmation when a TTY is present', () => {
    expect(resolveGuardExit('require_review', { isTty: true, confirmed: true })).toEqual({ final: 'allow', exitCode: 0 });
    expect(resolveGuardExit('require_review', { isTty: true, confirmed: false })).toEqual({ final: 'deny', exitCode: 2 });
  });
});

// ── testPolicies error-message accuracy ────────────────────────────────────

describe('testPolicies messages', () => {
  it('distinguishes a missing trace from an empty one', () => {
    const empty = startTrace(db, { agent_name: 'e' }); // real trace, no steps
    expect(() => testPolicies(db, empty.id)).toThrow(/has no steps to test/);
    expect(() => testPolicies(db, 'trc_missing')).toThrow(/not found/);
  });
});

describe('removePolicy', () => {
  const count = () => (db.prepare('SELECT COUNT(*) as c FROM guardrail_policies').get() as { c: number }).c;

  it('removes a policy by name or by id and leaves the others intact', () => {
    addPolicy(db, { name: 'a', action: 'deny', match_pattern: { name_contains: 'x' } });
    const b = addPolicy(db, { name: 'b', action: 'deny', match_pattern: { name_contains: 'y' } });
    expect(count()).toBe(2);

    removePolicy(db, 'a'); // by name
    expect(count()).toBe(1);

    removePolicy(db, b.id); // by id
    expect(count()).toBe(0);
  });

  it('throws when the policy does not exist', () => {
    expect(() => removePolicy(db, 'nope')).toThrow(/not found/);
  });
});

describe('testPolicies pre-flight matching', () => {
  it('reports the deny/warn matches per step, leaving safe steps unflagged', () => {
    addPolicy(db, { name: 'no-del', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    addPolicy(db, { name: 'llm-warn', action: 'warn', match_pattern: { step_type: 'llm_call' } });
    const t = ingestTrace(db, {
      agent_name: 'mix',
      status: 'completed',
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'search', input: { q: 'x' } },
        { step_number: 2, step_type: 'tool_call', name: 'delete_records', input: { table: 'logs' } },
        { step_number: 3, step_type: 'llm_call', name: 'generate' },
        { step_number: 4, step_type: 'output', name: 'done' },
      ],
    });

    const results = testPolicies(db, t.id);
    const byStep = (n: number) => results.find((r) => r.step.step_number === n)!;
    expect(byStep(1).matches).toHaveLength(0); // safe tool call
    expect(byStep(2).matches.map((m) => m.action)).toEqual(['deny']);
    expect(byStep(2).matches[0].policy.name).toBe('no-del');
    expect(byStep(3).matches.map((m) => m.action)).toEqual(['warn']);
    expect(byStep(4).matches).toHaveLength(0); // output step
  });
});
