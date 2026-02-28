import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchemaV1 } from '../src/db/schema.js';
import { seedDemoData } from '../src/demo/seed-data.js';
import { listTraces, getTrace } from '../src/services/trace-service.js';
import { listPolicies } from '../src/services/guard-service.js';
import { customerServiceHallucination } from '../src/demo/scenarios/customer-service-hallucination.js';
import { codeAgentError } from '../src/demo/scenarios/code-agent-error.js';
import { ragContextPollution } from '../src/demo/scenarios/rag-context-pollution.js';
import { successfulBooking } from '../src/demo/scenarios/successful-booking.js';
import { guardrailViolation } from '../src/demo/scenarios/guardrail-violation.js';
import { validateTraceInput } from '../src/utils/validators.js';

let db: Database.Database;
const now = new Date();

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchemaV1(db);
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
  it('inserts 5 traces into the database', () => {
    seedDemoData(db);
    const { total } = listTraces(db);
    expect(total).toBe(5);
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
    expect(statuses).toEqual(['completed', 'completed', 'failed', 'failed', 'timeout']);
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
    // Policies have UNIQUE name constraint, so re-seeding throws
    expect(() => seedDemoData(db)).toThrow(/UNIQUE constraint/);
  });
});
