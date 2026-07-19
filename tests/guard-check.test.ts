import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { addPolicy, evaluateStep, verdictForMatches, resolveGuardExit, testPolicies } from '../src/services/guard-service.js';
import { startTrace } from '../src/services/trace-service.js';
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
