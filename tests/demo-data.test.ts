import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoData } from '../src/demo/seed-data.js';
import { listTraces, getTrace } from '../src/services/trace-service.js';
import { listPolicies } from '../src/services/guard-service.js';
import { customerServiceHallucination } from '../src/demo/scenarios/customer-service-hallucination.js';
import { codeAgentError } from '../src/demo/scenarios/code-agent-error.js';
import { ragContextPollution } from '../src/demo/scenarios/rag-context-pollution.js';
import { successfulBooking } from '../src/demo/scenarios/successful-booking.js';
import { guardrailViolation } from '../src/demo/scenarios/guardrail-violation.js';
import { bookingRegression } from '../src/demo/scenarios/booking-regression.js';
import { validateTraceInput } from '../src/utils/validators.js';

let db: Database.Database;
const now = new Date();

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

// ── Individual scenario validation ───────────────────────────────────────

describe('scenario data validation', () => {
  const scenarios = [
    { name: 'customerServiceHallucination', fn: customerServiceHallucination },
    { name: 'codeAgentError', fn: codeAgentError },
    { name: 'ragContextPollution', fn: ragContextPollution },
    { name: 'successfulBooking', fn: successfulBooking },
    { name: 'guardrailViolation', fn: guardrailViolation },
    { name: 'bookingRegression', fn: bookingRegression },
  ];

  for (const { name, fn } of scenarios) {
    it(`${name} produces valid IngestTraceInput`, () => {
      const data = fn(now);
      const result = validateTraceInput(data);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.log(`${name} errors:`, result.errors);
      }
    });

    it(`${name} has required fields`, () => {
      const data = fn(now);
      expect(data.agent_name).toBeTruthy();
      expect(data.status).toBeTruthy();
      expect(data.steps).toBeDefined();
      expect(data.steps!.length).toBeGreaterThan(0);
    });

    it(`${name} has sequential step numbers`, () => {
      const data = fn(now);
      for (let i = 0; i < data.steps!.length; i++) {
        expect(data.steps![i].step_number).toBe(i + 1);
      }
    });

    it(`${name} keeps every step inside its own trace window`, () => {
      // The sibling of the token invariant below, for the other hand-written
      // number. A step timestamped before its trace started (or after it ended)
      // renders as a run that did work before it began — `show`'s timeline and
      // `list`'s ordering both read from these. The importers carry the same
      // assertion for the same reason; the demo data is written by hand, so a
      // typo'd offset is exactly how it would break.
      const data = fn(now);
      const start = Date.parse(data.started_at as string);
      const end = data.ended_at ? Date.parse(data.ended_at as string) : null;
      expect(Number.isNaN(start)).toBe(false);
      for (const step of data.steps!) {
        if (!step.started_at) continue;
        const at = Date.parse(step.started_at);
        expect(Number.isNaN(at), `${name} step ${step.step_number} has an unparseable started_at`).toBe(false);
        expect(at, `${name} step ${step.step_number} starts before its trace`).toBeGreaterThanOrEqual(start);
        if (end != null) {
          expect(at, `${name} step ${step.step_number} starts after its trace ended`).toBeLessThanOrEqual(end);
        }
      }
    });

    it(`${name} declares a total_tokens that equals the sum of its steps`, () => {
      // Otherwise `show` (which prints the stored total_tokens) and `replay`
      // (which re-sums step tokens_used) display different token counts for the
      // same demo trace — a contradiction the first-time user would notice.
      const data = fn(now);
      const stepSum = data.steps!.reduce((sum, s) => sum + (s.tokens_used ?? 0), 0);
      expect(data.total_tokens).toBe(stepSum);
    });
  }
});

// ── Specific scenario characteristics ────────────────────────────────────

describe('scenario characteristics', () => {
  it('customerServiceHallucination is failed with 8 steps', () => {
    const data = customerServiceHallucination(now);
    expect(data.status).toBe('failed');
    expect(data.steps).toHaveLength(8);
    expect(data.agent_name).toBe('customer-service-bot');
  });

  it('codeAgentError is failed with 7 steps', () => {
    const data = codeAgentError(now);
    expect(data.status).toBe('failed');
    expect(data.steps).toHaveLength(7);
    expect(data.error).toBeTruthy();
  });

  it('ragContextPollution is timeout with 9 steps', () => {
    const data = ragContextPollution(now);
    expect(data.status).toBe('timeout');
    expect(data.steps).toHaveLength(9);
    expect(data.total_tokens).toBeGreaterThan(10000);
  });

  it('successfulBooking is completed with 10 steps', () => {
    const data = successfulBooking(now);
    expect(data.status).toBe('completed');
    expect(data.steps).toHaveLength(10);
    expect(data.error).toBeNull();
  });

  it('guardrailViolation is completed with 8 steps', () => {
    const data = guardrailViolation(now);
    expect(data.status).toBe('completed');
    expect(data.steps).toHaveLength(8);
    expect(data.tags).toContain('guardrail-triggered');
  });
});

// ── seedDemoData ─────────────────────────────────────────────────────────

describe('seedDemoData', () => {
  it('inserts 6 traces into the database', () => {
    seedDemoData(db);
    const { total } = listTraces(db);
    expect(total).toBe(6);
  });

  it('seeds two runs of ONE agent on the same input, so diff and check have something to compare', () => {
    // Five traces from five different agents left `diff <a> <b>` — which the
    // demo itself suggests running next — comparing unrelated runs, and made a
    // `check --golden` regression impossible to demonstrate: every baseline had
    // exactly one candidate, which matched it trivially.
    seedDemoData(db);
    const { items } = listTraces(db, { limit: 25 });
    const travel = items.filter((t) => t.agent_name === 'travel-assistant');
    expect(travel).toHaveLength(2);
    const inputs = travel.map((t) => JSON.stringify(t.input));
    expect(inputs[0]).toBe(inputs[1]);
    // Same shape, different decision and different tool arguments: the silent
    // kind of regression, which the default structural fields cannot see.
    const full = travel.map((t) => getTrace(db, t.id)!);
    expect(full[0].steps.length).toBe(full[1].steps.length);
    expect(full.map((f) => f.steps.map((s) => s.name).join(','))).toEqual([
      full[0].steps.map((s) => s.name).join(','),
      full[0].steps.map((s) => s.name).join(','),
    ]);
    const chosen = full.map((f) => f.steps.find((s) => s.step_type === 'decision')?.decision?.chosen);
    expect(new Set(chosen).size).toBe(2);
  });

  it('inserts 3 guardrail policies', () => {
    seedDemoData(db);
    const policies = listPolicies(db);
    expect(policies).toHaveLength(3);
  });

  it('creates traces with expected statuses', () => {
    seedDemoData(db);
    const { items } = listTraces(db, { limit: 25 });
    const statuses = items.map(t => t.status).sort();
    expect(statuses).toEqual(['completed', 'completed', 'completed', 'failed', 'failed', 'timeout']);
  });

  it('all seeded traces have steps', () => {
    seedDemoData(db);
    const { items } = listTraces(db, { limit: 25 });
    for (const trace of items) {
      const full = getTrace(db, trace.id);
      expect(full).not.toBeNull();
      expect(full!.steps.length).toBeGreaterThan(0);
    }
  });

  it('seeded policies have expected names', () => {
    seedDemoData(db);
    const policies = listPolicies(db);
    const names = policies.map(p => p.name).sort();
    expect(names).toEqual(['no-delete-operations', 'no-external-urls', 'token-limit-warning']);
  });

  it('throws on duplicate seed due to unique policy names', () => {
    seedDemoData(db);
    // Policy names are UNIQUE, so re-seeding still throws — but with a message
    // that names the policy and what to do, rather than the raw constraint text
    // ("UNIQUE constraint failed: guardrail_policies.name"), which named a
    // column instead of the thing the user can act on.
    expect(() => seedDemoData(db)).toThrow(/already exists/);
  });
});

describe('every demo decision step carries a decision record', () => {
  // The demo is what a first run shows, and `decisions` / `why` /
  // `check --fields decisions` all read the RECORD, not the step's prose
  // output. Two of the three demo decision points had no record, so the
  // showcase answered "(no structured decision record)" for the feature it
  // exists to showcase — and no demo baseline could exercise
  // `--fields decisions` for those agents.
  it('has no decision-typed step without one', () => {
    const bare: string[] = [];
    for (const fn of [customerServiceHallucination, codeAgentError, ragContextPollution, successfulBooking, guardrailViolation, bookingRegression]) {
      const scenario = fn(now);
      for (const step of scenario.steps ?? []) {
        if (step.step_type === 'decision' && !step.decision) bare.push(`${scenario.agent_name}:${step.name}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('records a chosen option that is one of the options offered', () => {
    for (const fn of [customerServiceHallucination, codeAgentError, ragContextPollution, successfulBooking, guardrailViolation, bookingRegression]) {
      for (const step of fn(now).steps ?? []) {
        if (!step.decision) continue;
        const offered = (step.decision.options ?? []).map((o) => (o as { option: string }).option);
        expect(offered).toContain(step.decision.chosen);
      }
    }
  });
});
