import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace } from '../src/services/trace-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { checkGolden, inputHash, stableStringify } from '../src/services/check-service.js';
import type { GoldenEntry } from '../src/services/export-service.js';
import type { IngestTraceInput, TraceWithDetails } from '../src/models/types.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

const baseline: IngestTraceInput = {
  agent_name: 'travel-bot',
  status: 'completed',
  input: { task: 'book a flight', dest: 'JFK' },
  steps: [
    { step_number: 1, step_type: 'thought', name: 'plan' },
    { step_number: 2, step_type: 'tool_call', name: 'search_flights', input: { origin: 'SFO', dest: 'JFK' } },
    { step_number: 3, step_type: 'output', name: 'confirm' },
  ],
};

/** Ingest the baseline and return the golden dataset built from it. */
function makeGolden(): GoldenEntry[] {
  ingestTrace(db, baseline);
  return JSON.parse(exportTraces(db, { agent_name: 'travel-bot' }, 'golden')) as GoldenEntry[];
}

function candidate(input: IngestTraceInput): TraceWithDetails {
  const t = ingestTrace(db, input);
  return getTrace(db, t.id)!;
}

// ── Hashing ────────────────────────────────────────────────────────────────

describe('input hashing', () => {
  it('is stable regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
  });
});

// ── Golden check ─────────────────────────────────────────────────────────

describe('checkGolden', () => {
  it('passes a structurally identical run', () => {
    const golden = makeGolden();
    const report = checkGolden(golden, [candidate(baseline)]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('fails and names the divergent field when a tool input changes', () => {
    const golden = makeGolden();
    const altered: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 2, step_type: 'tool_call', name: 'search_flights', input: { origin: 'SFO', dest: 'LAX' } },
        { step_number: 3, step_type: 'output', name: 'confirm' },
      ],
    };
    const report = checkGolden(golden, [candidate(altered)]);
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    const div = report.results[0].divergences.find((d) => d.field === 'tool_inputs')!;
    expect(div).toBeTruthy();
    expect(div.step_number).toBe(2);
  });

  it('detects a changed step sequence', () => {
    const golden = makeGolden();
    const altered: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 2, step_type: 'tool_call', name: 'search_hotels', input: { origin: 'SFO', dest: 'JFK' } },
        { step_number: 3, step_type: 'output', name: 'confirm' },
      ],
    };
    const report = checkGolden(golden, [candidate(altered)]);
    expect(report.results[0].divergences.some((d) => d.field === 'step_names')).toBe(true);
  });

  it('flags a final-status regression', () => {
    const golden = makeGolden();
    const failed: IngestTraceInput = { ...baseline, status: 'failed' };
    const report = checkGolden(golden, [candidate(failed)]);
    expect(report.results[0].divergences.some((d) => d.field === 'status')).toBe(true);
  });

  it('reports unmatched candidates as pass unless --strict', () => {
    const golden = makeGolden();
    const other = candidate({ ...baseline, input: { task: 'totally different' } });
    expect(checkGolden(golden, [other]).ok).toBe(true);
    expect(checkGolden(golden, [other]).unmatched).toBe(1);
    expect(checkGolden(golden, [other], { strict: true }).ok).toBe(false);
  });

  it('honors a --fields allowlist (ignoring status when excluded)', () => {
    const golden = makeGolden();
    const failed = candidate({ ...baseline, status: 'failed' });
    const report = checkGolden(golden, [failed], { fields: ['step_count', 'step_names'] });
    expect(report.ok).toBe(true);
  });
});
