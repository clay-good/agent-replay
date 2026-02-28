import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchemaV1 } from '../src/db/schema.js';
import {
  ingestTrace,
  appendStep,
  getTrace,
  listTraces,
  updateTrace,
  deleteTrace,
  getStepSnapshot,
  createEval,
} from '../src/services/trace-service.js';
import { diffTraces } from '../src/services/diff-service.js';
import { forkTrace } from '../src/services/fork-service.js';
import { runEval, runCustomRubric } from '../src/services/eval-service.js';
import type { IngestTraceInput } from '../src/models/types.js';

let db: Database.Database;

function makeTrace(overrides: Partial<IngestTraceInput> = {}): IngestTraceInput {
  return {
    agent_name: 'test-agent',
    agent_version: '1.0.0',
    trigger: 'manual',
    status: 'completed',
    input: { task: 'test' },
    output: { result: 'done' },
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    total_duration_ms: 1000,
    total_tokens: 500,
    total_cost_usd: 0.01,
    tags: ['test'],
    metadata: {},
    steps: [
      {
        step_number: 1,
        step_type: 'thought',
        name: 'think',
        input: { q: 'hello' },
        output: { a: 'world' },
        duration_ms: 200,
        tokens_used: 100,
      },
      {
        step_number: 2,
        step_type: 'tool_call',
        name: 'do_something',
        input: { action: 'run' },
        output: { success: true },
        duration_ms: 500,
        tokens_used: 200,
        snapshot: {
          context_window: { messages: 2, total_tokens: 300 },
          environment: { workspace: '/tmp' },
          tool_state: { connected: true },
          token_count: 300,
        },
      },
      {
        step_number: 3,
        step_type: 'output',
        name: 'respond',
        input: { message: 'done' },
        output: { delivered: true },
        duration_ms: 100,
        tokens_used: 50,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchemaV1(db);
});

afterEach(() => {
  db.close();
});

// ── Ingest ────────────────────────────────────────────────────────────────

describe('ingestTrace', () => {
  it('inserts a trace with steps and returns it', () => {
    const trace = ingestTrace(db, makeTrace());
    expect(trace.id).toMatch(/^trc_/);
    expect(trace.agent_name).toBe('test-agent');
    expect(trace.status).toBe('completed');
    expect(trace.tags).toEqual(['test']);
  });

  it('inserts steps correctly', () => {
    const trace = ingestTrace(db, makeTrace());
    const full = getTrace(db, trace.id);
    expect(full).not.toBeNull();
    expect(full!.steps).toHaveLength(3);
    expect(full!.steps[0].step_type).toBe('thought');
    expect(full!.steps[1].step_type).toBe('tool_call');
    expect(full!.steps[2].step_type).toBe('output');
  });

  it('inserts snapshots for steps that have them', () => {
    const trace = ingestTrace(db, makeTrace());
    const snap = getStepSnapshot(db, trace.id, 2);
    expect(snap).not.toBeNull();
    expect(snap!.token_count).toBe(300);

    const noSnap = getStepSnapshot(db, trace.id, 1);
    expect(noSnap).toBeNull();
  });

  it('defaults status to running when no ended_at', () => {
    const trace = ingestTrace(db, makeTrace({ status: undefined, ended_at: undefined }));
    expect(trace.status).toBe('running');
  });

  it('defaults status to completed when ended_at present', () => {
    const trace = ingestTrace(db, makeTrace({ status: undefined, ended_at: new Date().toISOString() }));
    expect(trace.status).toBe('completed');
  });

  it('inserts a trace with no steps', () => {
    const trace = ingestTrace(db, makeTrace({ steps: [] }));
    const full = getTrace(db, trace.id);
    expect(full!.steps).toHaveLength(0);
  });
});

// ── appendStep ────────────────────────────────────────────────────────────

describe('appendStep', () => {
  it('appends a step to a running trace', () => {
    const trace = ingestTrace(db, makeTrace({ status: 'running', steps: [] }));
    const step = appendStep(db, trace.id, {
      step_number: 1,
      step_type: 'thought',
      name: 'new_step',
      input: { x: 1 },
      output: { y: 2 },
    });
    expect(step.id).toMatch(/^stp_/);
    expect(step.name).toBe('new_step');
  });

  it('throws when trace is not running', () => {
    const trace = ingestTrace(db, makeTrace({ status: 'completed', steps: [] }));
    expect(() =>
      appendStep(db, trace.id, { step_number: 1, step_type: 'thought', name: 'x' }),
    ).toThrow(/status 'completed'/);
  });

  it('throws for nonexistent trace', () => {
    expect(() =>
      appendStep(db, 'nonexistent', { step_number: 1, step_type: 'thought', name: 'x' }),
    ).toThrow(/not found/);
  });
});

// ── getTrace ──────────────────────────────────────────────────────────────

describe('getTrace', () => {
  it('returns null for nonexistent trace', () => {
    expect(getTrace(db, 'nonexistent')).toBeNull();
  });

  it('supports prefix matching', () => {
    const trace = ingestTrace(db, makeTrace());
    const prefix = trace.id.slice(0, 8);
    const found = getTrace(db, prefix);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(trace.id);
  });

  it('includes evals in response', () => {
    const trace = ingestTrace(db, makeTrace());
    createEval(db, trace.id, {
      evaluator_type: 'rubric',
      evaluator_name: 'test-eval',
      score: 0.85,
      passed: true,
      details: { note: 'ok' },
    });
    const full = getTrace(db, trace.id);
    expect(full!.evals).toHaveLength(1);
    expect(full!.evals[0].score).toBe(0.85);
  });
});

// ── listTraces ────────────────────────────────────────────────────────────

describe('listTraces', () => {
  it('lists all traces', () => {
    ingestTrace(db, makeTrace());
    ingestTrace(db, makeTrace({ agent_name: 'other-agent' }));
    const { items, total } = listTraces(db);
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
  });

  it('filters by status', () => {
    ingestTrace(db, makeTrace({ status: 'completed' }));
    ingestTrace(db, makeTrace({ status: 'failed' }));
    const { items } = listTraces(db, { status: 'failed' });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('failed');
  });

  it('filters by agent_name', () => {
    ingestTrace(db, makeTrace({ agent_name: 'alpha-bot' }));
    ingestTrace(db, makeTrace({ agent_name: 'beta-bot' }));
    const { items } = listTraces(db, { agent_name: 'alpha' });
    expect(items).toHaveLength(1);
    expect(items[0].agent_name).toBe('alpha-bot');
  });

  it('filters by tag', () => {
    ingestTrace(db, makeTrace({ tags: ['production', 'v2'] }));
    ingestTrace(db, makeTrace({ tags: ['staging'] }));
    const { items } = listTraces(db, { tag: 'production' });
    expect(items).toHaveLength(1);
    expect(items[0].tags).toContain('production');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      ingestTrace(db, makeTrace({ agent_name: `agent-${i}` }));
    }
    const { items, total } = listTraces(db, { limit: 2, offset: 1 });
    expect(total).toBe(5);
    expect(items).toHaveLength(2);
  });

  it('sorts by different fields', () => {
    ingestTrace(db, makeTrace({ total_tokens: 100 }));
    ingestTrace(db, makeTrace({ total_tokens: 500 }));
    const { items } = listTraces(db, { sort_by: 'tokens', sort_order: 'asc' });
    expect(items[0].total_tokens).toBeLessThanOrEqual(items[1].total_tokens!);
  });
});

// ── updateTrace ───────────────────────────────────────────────────────────

describe('updateTrace', () => {
  it('updates status', () => {
    const trace = ingestTrace(db, makeTrace({ status: 'running', steps: [] }));
    const updated = updateTrace(db, trace.id, { status: 'completed' });
    expect(updated.status).toBe('completed');
  });

  it('returns unchanged trace when no fields provided', () => {
    const trace = ingestTrace(db, makeTrace());
    const same = updateTrace(db, trace.id, {});
    expect(same.id).toBe(trace.id);
  });

  it('throws for nonexistent trace', () => {
    expect(() => updateTrace(db, 'nonexistent', { status: 'failed' })).toThrow(/not found/);
  });
});

// ── deleteTrace ───────────────────────────────────────────────────────────

describe('deleteTrace', () => {
  it('deletes a trace and cascades to steps', () => {
    const trace = ingestTrace(db, makeTrace());
    deleteTrace(db, trace.id);
    expect(getTrace(db, trace.id)).toBeNull();
  });

  it('throws for nonexistent trace', () => {
    expect(() => deleteTrace(db, 'nonexistent')).toThrow(/not found/);
  });
});

// ── diffTraces ────────────────────────────────────────────────────────────

describe('diffTraces', () => {
  it('finds no diffs between identical traces', () => {
    const input = makeTrace();
    const a = ingestTrace(db, input);
    const b = ingestTrace(db, input);
    const result = diffTraces(db, a.id, b.id);
    // Steps have same structure so step_type and name should match.
    // input/output will differ because IDs are regenerated, but the JSON values
    // are the same so they'll match in the DB TEXT comparison.
    expect(result.divergence_step).toBeNull();
    expect(result.diffs).toHaveLength(0);
  });

  it('detects divergence when step types differ', () => {
    const a = ingestTrace(db, makeTrace());
    const b = ingestTrace(db, makeTrace({
      steps: [
        { step_number: 1, step_type: 'thought', name: 'think', input: { q: 'hello' }, output: { a: 'world' } },
        { step_number: 2, step_type: 'llm_call', name: 'generate', input: {}, output: {} },
        { step_number: 3, step_type: 'output', name: 'respond', input: {}, output: {} },
      ],
    }));
    const result = diffTraces(db, a.id, b.id);
    expect(result.divergence_step).toBe(2);
    expect(result.diffs.some(d => d.field === 'step_type')).toBe(true);
  });

  it('detects missing steps', () => {
    const a = ingestTrace(db, makeTrace());
    const b = ingestTrace(db, makeTrace({
      steps: [
        { step_number: 1, step_type: 'thought', name: 'think', input: { q: 'hello' }, output: { a: 'world' } },
      ],
    }));
    const result = diffTraces(db, a.id, b.id);
    expect(result.left_step_count).toBe(3);
    expect(result.right_step_count).toBe(1);
    expect(result.diffs.some(d => d.field === 'missing_right')).toBe(true);
  });
});

// ── forkTrace ─────────────────────────────────────────────────────────────

describe('forkTrace', () => {
  it('forks a trace at a given step', () => {
    const trace = ingestTrace(db, makeTrace());
    const result = forkTrace(db, trace.id, 2);
    expect(result.original_trace_id).toBe(trace.id);
    expect(result.forked_trace_id).toMatch(/^trc_/);
    expect(result.forked_from_step).toBe(2);
    expect(result.steps_copied).toBe(2);

    const forked = getTrace(db, result.forked_trace_id);
    expect(forked).not.toBeNull();
    expect(forked!.steps).toHaveLength(2);
    expect(forked!.parent_trace_id).toBe(trace.id);
    expect(forked!.forked_from_step).toBe(2);
    expect(forked!.status).toBe('running');
  });

  it('copies snapshots during fork', () => {
    const trace = ingestTrace(db, makeTrace());
    const result = forkTrace(db, trace.id, 2);
    const snap = getStepSnapshot(db, result.forked_trace_id, 2);
    expect(snap).not.toBeNull();
    expect(snap!.token_count).toBe(300);
  });

  it('applies modified input', () => {
    const trace = ingestTrace(db, makeTrace());
    const result = forkTrace(db, trace.id, 1, { task: 'modified' });
    const forked = getTrace(db, result.forked_trace_id);
    expect(forked!.input).toEqual({ task: 'modified' });
  });

  it('throws for nonexistent trace', () => {
    expect(() => forkTrace(db, 'nonexistent', 1)).toThrow(/not found/);
  });
});

// ── Eval ──────────────────────────────────────────────────────────────────

describe('eval', () => {
  it('createEval stores and returns an eval result', () => {
    const trace = ingestTrace(db, makeTrace());
    const evalResult = createEval(db, trace.id, {
      evaluator_type: 'rubric',
      evaluator_name: 'test',
      score: 0.9,
      passed: true,
      details: { note: 'good' },
    });
    expect(evalResult.id).toMatch(/^evl_/);
    expect(evalResult.score).toBe(0.9);
    expect(evalResult.passed).toBe(true);
  });

  it('runEval with hallucination-check preset', () => {
    const trace = ingestTrace(db, makeTrace());
    const result = runEval(db, trace.id, 'hallucination-check');
    expect(result.evaluator_name).toBe('hallucination-check');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(typeof result.passed).toBe('boolean');
  });

  it('runEval with safety-check preset', () => {
    const trace = ingestTrace(db, makeTrace());
    const result = runEval(db, trace.id, 'safety-check');
    expect(result.evaluator_name).toBe('safety-check');
    // Our test trace has no dangerous patterns, should pass
    expect(result.passed).toBe(true);
  });

  it('runEval with completeness-check preset', () => {
    const trace = ingestTrace(db, makeTrace());
    const result = runEval(db, trace.id, 'completeness-check');
    expect(result.evaluator_name).toBe('completeness-check');
    // Our trace has an output step and completes normally
    expect(result.passed).toBe(true);
  });

  it('runEval detects dangerous tool calls', () => {
    const trace = ingestTrace(db, makeTrace({
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'delete_users', input: { action: 'delete' }, output: null },
        { step_number: 2, step_type: 'error', name: 'abort', input: {}, output: {} },
      ],
    }));
    const result = runEval(db, trace.id, 'safety-check');
    expect(result.score).toBeLessThan(1);
  });

  it('runEval throws for unknown preset', () => {
    const trace = ingestTrace(db, makeTrace());
    expect(() => runEval(db, trace.id, 'nonexistent')).toThrow(/Unknown eval preset/);
  });

  it('runCustomRubric with pattern matching', () => {
    const trace = ingestTrace(db, makeTrace({
      output: { message: 'Hello world from the agent' },
    }));
    const result = runCustomRubric(db, trace.id, {
      name: 'custom-check',
      threshold: 0.5,
      criteria: [
        { name: 'has_hello', pattern: 'hello', expected: true, weight: 1 },
        { name: 'no_error', pattern: 'error|fail', expected: false, weight: 1 },
      ],
    });
    expect(result.evaluator_name).toBe('custom-check');
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });
});
