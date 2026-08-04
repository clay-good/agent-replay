import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, createEval } from '../src/services/trace-service.js';
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

  it('pairs distinct candidates that share an agent+input key without false regressions', () => {
    // Two runs of the same agent with the same input but different shapes — an
    // original and its fork, say. A plain golden index kept only the last, so
    // the other candidate matched the wrong entry and "regressed".
    const shapeA: IngestTraceInput = { agent_name: 'dup', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'output', name: 'a' }] };
    const shapeB: IngestTraceInput = { agent_name: 'dup', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'thought', name: 'x' }, { step_number: 2, step_type: 'output', name: 'b' }] };
    ingestTrace(db, shapeA);
    ingestTrace(db, shapeB);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'dup' }, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(2);

    const report = checkGolden(golden, [candidate(shapeA), candidate(shapeB)]);
    expect(report.ok).toBe(true); // each candidate matched its own counterpart
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
  });

  it('passes every candidate that reproduces one baseline when the bucket holds other shapes', () => {
    // A golden bucket holds two known-good shapes (A and B) for one agent+input.
    // Two candidates that both reproduce shape A must BOTH pass: a candidate is
    // good if it matches ANY baseline. The greedy version consumed A's entry for
    // the first candidate and forced the second onto B, falsely "regressing" a
    // trace that exactly reproduces a known-good run.
    const shapeA: IngestTraceInput = { agent_name: 'dup2', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'output', name: 'a' }] };
    const shapeB: IngestTraceInput = { agent_name: 'dup2', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'thought', name: 'x' }, { step_number: 2, step_type: 'output', name: 'b' }] };
    ingestTrace(db, shapeA);
    ingestTrace(db, shapeB);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'dup2' }, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(2);

    const report = checkGolden(golden, [candidate(shapeA), candidate(shapeA)]);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(true);
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

  it('catches a tool-input regression even when the candidate renumbers its steps', () => {
    // step_types/step_names align positionally, so tool_inputs must too. A valid
    // candidate can number its steps differently from the golden (step_number
    // need only be >= 1 and may be gapped — e.g. an OTLP-assembled or imported
    // trace). Aligning tool_inputs by absolute step_number made the candidate's
    // tool_call miss its golden counterpart, so a real regression slipped through
    // while the positional checks reported a perfect match.
    const golden = makeGolden(); // baseline: tool_call at step 2, input dest: JFK
    const renumbered: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 3, step_type: 'tool_call', name: 'search_flights', input: { origin: 'SFO', dest: 'LAX' } },
        { step_number: 5, step_type: 'output', name: 'confirm' },
      ],
    };
    const report = checkGolden(golden, [candidate(renumbered)]);
    expect(report.ok).toBe(false);
    expect(report.results[0].divergences.some((d) => d.field === 'tool_inputs')).toBe(true);
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

  it('catches a model change only when model is opted into via --fields', () => {
    const withModel: IngestTraceInput = {
      agent_name: 'travel-bot',
      status: 'completed',
      input: { task: 'book a flight', dest: 'JFK' },
      steps: [{ step_number: 1, step_type: 'llm_call', name: 'gen', model: 'gpt-4' }],
    };
    ingestTrace(db, withModel);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'travel-bot' }, 'golden')) as GoldenEntry[];
    const swapped = candidate({ ...withModel, steps: [{ ...withModel.steps![0], model: 'gpt-5.4-nano' }] });

    // Default fields ignore model → passes despite the swap.
    expect(checkGolden(golden, [swapped]).ok).toBe(true);
    // Opt in → the swap is a divergence.
    const report = checkGolden(golden, [swapped], { fields: ['model'] });
    expect(report.ok).toBe(false);
    expect(report.results[0].divergences[0].field).toBe('model');
  });

  it('rejects an unknown --fields value instead of silently passing', () => {
    const golden = makeGolden();
    expect(() => checkGolden(golden, [candidate(baseline)], { fields: ['bogus'] })).toThrow(/Unknown --fields/);
  });
});

describe('exportTraces formats', () => {
  it('exports JSONL with one JSON object per line', () => {
    ingestTrace(db, { agent_name: 'e1', status: 'completed', input: { a: 1 }, steps: [{ step_number: 1, step_type: 'output', name: 'x' }] });
    ingestTrace(db, { agent_name: 'e2', status: 'completed', input: { b: 2 }, steps: [{ step_number: 1, step_type: 'output', name: 'y' }] });
    const lines = exportTraces(db, {}, 'jsonl').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.map((l) => JSON.parse(l).agent_name).sort()).toEqual(['e1', 'e2']);
  });

  it('carries a trace\'s eval_criteria into the golden export', () => {
    const t = ingestTrace(db, { agent_name: 'g', status: 'completed', input: { a: 1 }, steps: [{ step_number: 1, step_type: 'output', name: 'x' }] });
    createEval(db, t.id, { evaluator_type: 'rubric', evaluator_name: 'quality', score: 0.9, passed: true, details: {} });
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];
    expect(golden[0].eval_criteria).toEqual([{ evaluator_name: 'quality', score: 0.9, passed: true }]);
  });
});
