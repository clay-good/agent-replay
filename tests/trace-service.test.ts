import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import {
  ingestTrace,
  appendStep,
  getTrace,
  listTraces,
  updateTrace,
  deleteTrace,
  getStepSnapshot,
  createEval,
  startTrace,
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
  runMigrations(db);
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

  // Regression: nothing rejects a plain-string input/output — validateTraceInput
  // accepts it and the event protocol never type-checks these fields — and the
  // encode helper passed any string through unquoted into a JSON TEXT column.
  // parseJson then failed on the way back out, so the prompt and the answer read
  // as `{}` / `null` from every consumer (show, diff, export, the golden gate),
  // silently, with exit 0.
  it('preserves a plain-string input/output instead of reading it back as {}', () => {
    const trace = ingestTrace(db, {
      agent_name: 'strbot',
      status: 'completed',
      input: 'summarize the quarterly report' as unknown as Record<string, unknown>,
      output: 'here is the summary' as unknown as Record<string, unknown>,
      steps: [{
        step_number: 1,
        step_type: 'tool_call',
        name: 'search',
        input: 'query text' as unknown as Record<string, unknown>,
      }],
    });
    const full = getTrace(db, trace.id)!;
    expect(full.input).toBe('summarize the quarterly report');
    expect(full.output).toBe('here is the summary');
    expect(full.steps[0].input).toBe('query text');
  });

  it('still passes an already-serialized JSON string through unchanged', () => {
    const trace = ingestTrace(db, {
      agent_name: 'strbot',
      status: 'completed',
      input: '{"task":"pre-serialized"}' as unknown as Record<string, unknown>,
      steps: [{ step_number: 1, step_type: 'output', name: 'o' }],
    });
    expect(getTrace(db, trace.id)!.input).toEqual({ task: 'pre-serialized' });
  });

  // The live event protocol doesn't type-check tags, so a producer could store
  // a non-array in a column every reader treats as one. `fork --tag` then threw
  // on `tags.push` AFTER its fork had already committed, reporting "Fork
  // failed" for a fork that existed but whose id was never printed.
  it('coerces a non-array tags value to an empty array', () => {
    const live = startTrace(db, { agent_name: 'bot', tags: { weird: true } as never });
    expect(getTrace(db, live.id)!.tags).toEqual([]);
    const raw = (db.prepare('SELECT tags FROM agent_traces WHERE id = ?').get(live.id) as { tags: string }).tags;
    expect(JSON.parse(raw)).toEqual([]);
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

  it('treats a blank trace id as not found, not a wildcard match', () => {
    // `id LIKE ''||'%'` would match every row; a blank id must resolve to null
    // so commands report "not found" instead of an arbitrary trace.
    ingestTrace(db, makeTrace());
    expect(getTrace(db, '')).toBeNull();
    expect(getTrace(db, '   ')).toBeNull();
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

  it('rejects a duplicate step_number and stores nothing (transaction rollback)', () => {
    // Spec: the UNIQUE(trace_id, step_number) constraint fails the insert; the
    // whole ingest transaction rolls back so no partial trace is left behind.
    expect(() =>
      ingestTrace(db, {
        agent_name: 'dupe',
        steps: [
          { step_number: 1, step_type: 'thought', name: 'a' },
          { step_number: 1, step_type: 'output', name: 'b' },
        ],
      }),
    ).toThrow();
    expect(listTraces(db, {}).total).toBe(0);
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

  it('persists a structured error object as JSON text instead of throwing', () => {
    // The live record/SDK path is fed untyped JSON, so a producer can put a
    // structured error ({message, code}) in a field typed as string. Binding it
    // raw would throw and (swallowed by record's per-event catch) drop the whole
    // step — so it must be coerced to text, like output.
    const trace = ingestTrace(db, makeTrace({ status: 'running', steps: [] }));
    const step = appendStep(db, trace.id, {
      step_number: 1, step_type: 'error', name: 'boom',
      error: { message: 'failed', code: 500 } as unknown as string,
    });
    expect(step.error).toBe('{"message":"failed","code":500}');
    // A plain-string error is stored unchanged (not JSON-double-quoted).
    const step2 = appendStep(db, trace.id, { step_number: 2, step_type: 'error', name: 'b', error: 'plain' });
    expect(step2.error).toBe('plain');
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

  it('prefers an exact id over a longer trace it merely prefixes', () => {
    // `trc_abc` is both an exact id and a prefix of `trc_abcdef`. The lookup must
    // return the exact match, not let the longer sibling shadow it.
    startTrace(db, { agent_name: 'long', status: 'completed' }, { id: 'trc_abcdef' });
    startTrace(db, { agent_name: 'exact', status: 'completed' }, { id: 'trc_abc' });
    const found = getTrace(db, 'trc_abc');
    expect(found!.id).toBe('trc_abc');
    expect(found!.agent_name).toBe('exact');
  });

  it('refuses an ambiguous prefix instead of picking one', () => {
    // It used to resolve to whichever id sorted first, silently — so the read
    // commands answered about a trace the user did not name, and `fork`, which
    // WRITES, derived a new trace from one. Deterministic ordering made that
    // stable, not correct.
    startTrace(db, { agent_name: 'x', status: 'completed' }, { id: 'trc_pfx_bbb' });
    startTrace(db, { agent_name: 'y', status: 'completed' }, { id: 'trc_pfx_aaa' });
    expect(() => getTrace(db, 'trc_pfx_')).toThrow(/Ambiguous trace id/);
    // The message names candidates, so the user can lengthen the prefix.
    expect(() => getTrace(db, 'trc_pfx_')).toThrow(/trc_pfx_aaa/);
    // An unambiguous prefix still resolves.
    expect(getTrace(db, 'trc_pfx_a')!.id).toBe('trc_pfx_aaa');
  });

  it('treats LIKE metacharacters in a partial id as literal (no wildcard match)', () => {
    // nanoid's default alphabet includes `_`, so a real id can contain it. An
    // unescaped `_` in the lookup would act as "any char" and resolve to an
    // unrelated trace; `%` would match everything. Both must stay literal.
    startTrace(db, { agent_name: 'real', status: 'completed' }, { id: 'trc_abXc001' });
    // `trc_ab_c` would wildcard-match `trc_abXc001` if `_` were not escaped.
    expect(getTrace(db, 'trc_ab_c')).toBeNull();
    // `%` would otherwise match every row and return an arbitrary trace.
    expect(getTrace(db, '%')).toBeNull();
    // A correct literal prefix still resolves.
    expect(getTrace(db, 'trc_abXc')!.id).toBe('trc_abXc001');
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

  it('populates step_count for the list view', () => {
    ingestTrace(db, makeTrace()); // makeTrace has 3 steps
    ingestTrace(db, makeTrace({ agent_name: 'no-steps', steps: [] }));
    const { items } = listTraces(db, { sort_by: 'agent_name', sort_order: 'asc' });
    const byAgent = Object.fromEntries(items.map((t) => [t.agent_name, t.step_count]));
    expect(byAgent['no-steps']).toBe(0);
    expect(byAgent['test-agent']).toBe(3);
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

  it('treats a LIKE metacharacter in the agent_name term as a literal', () => {
    // A snake_case agent name contains `_`, which unescaped matches any char.
    // The substring filter must match the literal underscore, not "travel-bot".
    ingestTrace(db, makeTrace({ agent_name: 'travel_bot' }));
    ingestTrace(db, makeTrace({ agent_name: 'travel-bot' }));
    const { items, total } = listTraces(db, { agent_name: 'travel_bot' });
    expect(total).toBe(1);
    expect(items[0].agent_name).toBe('travel_bot');
  });

  it('filters by tag', () => {
    ingestTrace(db, makeTrace({ tags: ['production', 'v2'] }));
    ingestTrace(db, makeTrace({ tags: ['staging'] }));
    const { items } = listTraces(db, { tag: 'production' });
    expect(items).toHaveLength(1);
    expect(items[0].tags).toContain('production');
  });

  it('filters by session_id as a literal prefix, not a LIKE wildcard', () => {
    // A session id commonly contains an underscore. Unescaped, `LIKE 'sess_1%'`
    // treats the `_` as "any char" and over-matches "sessX1". The filter must
    // return only sessions that literally start with the requested string.
    ingestTrace(db, makeTrace({ agent_name: 'want', session_id: 'sess_1' }));
    ingestTrace(db, makeTrace({ agent_name: 'nope', session_id: 'sessX1' }));
    ingestTrace(db, makeTrace({ agent_name: 'prefix', session_id: 'sess_1_child' }));
    const { items, total } = listTraces(db, { session_id: 'sess_1' });
    const names = items.map((t) => t.agent_name).sort();
    expect(total).toBe(2); // exact "sess_1" and prefix "sess_1_child"
    expect(names).toEqual(['prefix', 'want']);
    expect(names).not.toContain('nope');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      ingestTrace(db, makeTrace({ agent_name: `agent-${i}` }));
    }
    const { items, total } = listTraces(db, { limit: 2, offset: 1 });
    expect(total).toBe(5);
    expect(items).toHaveLength(2);
  });

  it('orders tied sort keys deterministically by id (stable pagination)', () => {
    // All five share an identical started_at, so the primary sort key ties for
    // every row. Without a unique tiebreaker the order among ties is
    // unspecified — a row could repeat on one page and be skipped on the next.
    // The id tiebreaker makes the order a stable total order (id ascending).
    const ts = '2026-05-01T00:00:00.000Z';
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(ingestTrace(db, makeTrace({ started_at: ts })).id);

    const ordered = listTraces(db, { limit: 100 }).items.map((t) => t.id);
    expect(ordered).toEqual([...ids].sort());

    // Paging covers every trace exactly once, no repeats across page boundaries.
    const paged = [
      ...listTraces(db, { limit: 2, offset: 0 }).items,
      ...listTraces(db, { limit: 2, offset: 2 }).items,
      ...listTraces(db, { limit: 2, offset: 4 }).items,
    ].map((t) => t.id);
    expect(new Set(paged).size).toBe(5);
  });

  it('sorts by different fields', () => {
    ingestTrace(db, makeTrace({ total_tokens: 100 }));
    ingestTrace(db, makeTrace({ total_tokens: 500 }));
    const { items } = listTraces(db, { sort_by: 'tokens', sort_order: 'asc' });
    expect(items[0].total_tokens).toBeLessThanOrEqual(items[1].total_tokens!);
  });

  it('rejects an unknown sort field instead of silently defaulting', () => {
    expect(() => listTraces(db, { sort_by: 'nonsense' })).toThrow(/Invalid sort field/);
  });

  it('rejects an unknown status instead of silently matching nothing', () => {
    ingestTrace(db, makeTrace({ status: 'failed' }));
    expect(() => listTraces(db, { status: 'faield' })).toThrow(/Invalid status/);
    // Valid statuses still filter.
    expect(listTraces(db, { status: 'failed' }).total).toBe(1);
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

  it('coerces an unknown status to completed instead of violating the CHECK', () => {
    // The live `record` path types trace_end.status as a free string, so a
    // producer value like "success" must not crash the status CHECK and abort
    // the whole finalization (which would drop output/tokens and leave the trace
    // stuck `running`). An unknown terminal status maps to `completed`.
    const trace = ingestTrace(db, makeTrace({ status: 'running', steps: [] }));
    const updated = updateTrace(db, trace.id, { status: 'success', total_tokens: 900 });
    expect(updated.status).toBe('completed');
    expect(updated.total_tokens).toBe(900);
    // An empty-string status coerces the same way (not left as "").
    expect(updateTrace(db, trace.id, { status: '' }).status).toBe('completed');
  });

  it('coerces a structured error object to JSON text on finalization', () => {
    // A trace_end from the live path can carry a structured error; binding it raw
    // would throw and lose the whole finalization (status/output/tokens).
    const trace = ingestTrace(db, makeTrace({ status: 'running', steps: [] }));
    const updated = updateTrace(db, trace.id, {
      status: 'failed', total_tokens: 42, error: { message: 'crashed' } as unknown as string,
    });
    expect(updated.status).toBe('failed');
    expect(updated.total_tokens).toBe(42);
    expect(updated.error).toBe('{"message":"crashed"}');
  });
});

describe('startTrace', () => {
  it('coerces an unknown trigger to manual instead of aborting trace creation', () => {
    // trigger is a free string on the live `record` path; a producer's own
    // vocabulary ("scheduled") must not violate the trigger CHECK — which the
    // recorder swallows as a warning, losing the entire trace.
    const trace = startTrace(db, { agent_name: 'a', status: 'running', trigger: 'scheduled' });
    expect(trace.trigger).toBe('manual');
    // A valid trigger is preserved.
    expect(startTrace(db, { agent_name: 'a', status: 'running', trigger: 'cron' }).trigger).toBe('cron');
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

  // Regression: only step_type/name/input/output/model were compared — no step
  // `error` and no trace-level field at all. So a run that failed and a run that
  // succeeded, identical otherwise, produced zero diffs: the renderer printed
  // "Traces are identical." directly under a header showing COMPLETED beside
  // FAILED. This is the flagship "it worked before, what changed?" case.
  it('reports a step error that differs between the two runs', () => {
    const ok = ingestTrace(db, {
      agent_name: 'bot', status: 'completed', input: { q: 1 }, output: { a: 'done' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'call_api', input: { u: 1 }, output: { r: 1 } }],
    });
    const bad = ingestTrace(db, {
      agent_name: 'bot', status: 'completed', input: { q: 1 }, output: { a: 'done' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'call_api', input: { u: 1 }, output: { r: 1 }, error: 'HTTP 500' }],
    });
    const result = diffTraces(db, ok.id, bad.id);
    const err = result.diffs.find((d) => d.field === 'error')!;
    expect(err).toBeTruthy();
    expect(err.step_number).toBe(1);
    expect(err.right_value).toBe('HTTP 500');
    // A step-level difference still pins the divergence point.
    expect(result.divergence_step).toBe(1);
  });

  it('reports a trace-level status/error difference with a null step number', () => {
    const steps = [{ step_number: 1, step_type: 'output' as const, name: 'respond', output: { t: 'x' } }];
    const ok = ingestTrace(db, { agent_name: 'bot', status: 'completed', input: { q: 1 }, steps });
    const bad = ingestTrace(db, { agent_name: 'bot', status: 'failed', input: { q: 1 }, error: 'Agent aborted', steps });

    const result = diffTraces(db, ok.id, bad.id);
    const status = result.diffs.find((d) => d.field === 'status')!;
    expect(status.left_value).toBe('completed');
    expect(status.right_value).toBe('failed');
    expect(status.step_number).toBeNull();
    expect(result.diffs.find((d) => d.field === 'trace_error')?.right_value).toBe('Agent aborted');
    // A trace-level field belongs to no step, so it must not pin a divergence
    // step (which means "the first step that went different").
    expect(result.divergence_step).toBeNull();
  });

  it('does not report a phantom input/output diff when only key order differs', () => {
    // Two traces carrying the same step data serialized with different object
    // key order (e.g. an OTLP trace vs. a hook-recorded one) must compare equal:
    // a raw JSON-TEXT compare would flag a diff and mis-pin divergence_step.
    const a = ingestTrace(db, makeTrace({
      steps: [{ step_number: 1, step_type: 'tool_call', name: 't', input: { a: 1, b: 2 }, output: { x: 9, y: 8 } }],
    }));
    const b = ingestTrace(db, makeTrace({
      steps: [{ step_number: 1, step_type: 'tool_call', name: 't', input: { b: 2, a: 1 }, output: { y: 8, x: 9 } }],
    }));
    const result = diffTraces(db, a.id, b.id);
    expect(result.diffs.some((d) => d.field === 'input' || d.field === 'output')).toBe(false);
    expect(result.divergence_step).toBeNull();
  });

  it('still reports a genuine input diff (not masked by normalization)', () => {
    const a = ingestTrace(db, makeTrace({
      steps: [{ step_number: 1, step_type: 'tool_call', name: 't', input: { a: 1 }, output: {} }],
    }));
    const b = ingestTrace(db, makeTrace({
      steps: [{ step_number: 1, step_type: 'tool_call', name: 't', input: { a: 2 }, output: {} }],
    }));
    const result = diffTraces(db, a.id, b.id);
    expect(result.diffs.some((d) => d.field === 'input')).toBe(true);
    expect(result.divergence_step).toBe(1);
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

  it('aligns steps by step_number, not array index, when numbers have a gap', () => {
    // Step numbers can have holes (validation only requires each be a positive
    // integer). Pairing by array index would compare L's step 4 against R's step
    // 3 — emitting phantom step_type/name diffs labeled "step 4" and pinning the
    // divergence there. A merge-join on step_number must instead see steps
    // 1/2/4 as identical and R's step 3 as the only (right-only) difference.
    const a = ingestTrace(db, makeTrace({
      steps: [
        { step_number: 1, step_type: 'llm_call', name: 'a', input: {}, output: {} },
        { step_number: 2, step_type: 'tool_call', name: 'b', input: {}, output: {} },
        { step_number: 4, step_type: 'output', name: 'd', input: {}, output: {} },
      ],
    }));
    const b = ingestTrace(db, makeTrace({
      steps: [
        { step_number: 1, step_type: 'llm_call', name: 'a', input: {}, output: {} },
        { step_number: 2, step_type: 'tool_call', name: 'b', input: {}, output: {} },
        { step_number: 3, step_type: 'tool_call', name: 'c', input: {}, output: {} },
        { step_number: 4, step_type: 'output', name: 'd', input: {}, output: {} },
      ],
    }));
    const result = diffTraces(db, a.id, b.id);
    expect(result.divergence_step).toBe(3);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({ step_number: 3, field: 'missing_left', right_value: 'c' });
    // No phantom diffs on the correctly-matched step 4.
    expect(result.diffs.some((d) => d.step_number === 4)).toBe(false);
  });

  it('flags a swapped model (the "changed the model and it broke" case)', () => {
    const steps = [{ step_number: 1, step_type: 'llm_call', name: 'gen', input: {}, output: {}, model: 'gpt-4' }];
    const a = ingestTrace(db, makeTrace({ steps }));
    const b = ingestTrace(db, makeTrace({ steps: [{ ...steps[0], model: 'gpt-5.4-nano' }] }));
    const result = diffTraces(db, a.id, b.id);
    const modelDiff = result.diffs.find((d) => d.field === 'model');
    expect(modelDiff).toBeTruthy();
    expect(modelDiff!.left_value).toBe('gpt-4');
    expect(modelDiff!.right_value).toBe('gpt-5.4-nano');
    expect(result.divergence_step).toBe(1);
  });
});

// ── forkTrace ─────────────────────────────────────────────────────────────

describe('forkTrace', () => {
  // Regression: fork replaced metadata wholesale with the provenance keys, so
  // everything a producer had attached (run/session correlation, cost tags,
  // harness info) was dropped from every fork — while steps, decisions,
  // snapshots, tags and session_id were all copied faithfully.
  it('preserves the original metadata and layers fork provenance on top', () => {
    const t = ingestTrace(db, makeTrace({ metadata: { custom: 'keepme', run_id: 'r-42' } }));
    const f = forkTrace(db, t.id, 1);
    const forked = getTrace(db, f.forked_trace_id)!;
    expect(forked.metadata).toMatchObject({
      custom: 'keepme',
      run_id: 'r-42',
      forked_from: t.id,
      forked_at_step: 1,
    });
  });

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

  it('applies --modify-context by creating a snapshot when the fork step has none', () => {
    // Snapshots are optional, so the fork point usually has none. The modified
    // context must still land (previously it was silently dropped) — in a new
    // snapshot at the fork point, in the context_window field.
    const trace = ingestTrace(db, {
      agent_name: 'ctx', status: 'completed',
      steps: [
        { step_number: 1, step_type: 'thought', name: 'a' },
        { step_number: 2, step_type: 'tool_call', name: 'b' },
      ],
    });
    const result = forkTrace(db, trace.id, 2, undefined, { region: 'eu-west' });
    const snap = getStepSnapshot(db, result.forked_trace_id, 2);
    expect(snap).not.toBeNull();
    expect(snap!.context_window).toEqual({ region: 'eu-west' });
  });

  it('applies --modify-context to context_window while preserving the copied snapshot fields', () => {
    const trace = ingestTrace(db, makeTrace()); // step 2 carries a snapshot (token_count 300)
    const result = forkTrace(db, trace.id, 2, undefined, { region: 'us-east' });
    const snap = getStepSnapshot(db, result.forked_trace_id, 2)!;
    expect(snap.context_window).toEqual({ region: 'us-east' }); // modified
    expect(snap.token_count).toBe(300); // preserved from the original snapshot
  });

  it('throws for nonexistent trace', () => {
    expect(() => forkTrace(db, 'nonexistent', 1)).toThrow(/not found/);
  });

  it('rejects forking at a step number that does not exist (gapped steps)', () => {
    // step_number may have gaps, so `fromStep <= maxStep` is not enough. Forking
    // [1, 3] at step 2 must fail loudly, not silently copy step 1 and drop the
    // --modify-context (whose target step 2 never gets created).
    const trace = ingestTrace(db, {
      agent_name: 'gap', status: 'completed',
      steps: [
        { step_number: 1, step_type: 'thought', name: 'a', output: {} },
        { step_number: 3, step_type: 'output', name: 'c', output: {} },
      ],
    });
    expect(() => forkTrace(db, trace.id, 2, undefined, { region: 'eu' })).toThrow(/no step 2/);
    // A real fork point still works.
    expect(forkTrace(db, trace.id, 3).steps_copied).toBe(2);
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

describe('diffTraces compares the trace input', () => {
  it('reports a modified input, the thing fork --modify-input changes', () => {
    // Trace-level comparison covered status/error/output but not input, so the
    // one field `fork --modify-input` changes was invisible — and `fork` closes
    // by telling the user to run exactly this diff. Two separately-ingested
    // traces differing only in their prompt compared as identical.
    const left = ingestTrace(db, {
      agent_name: 'inp', status: 'completed', input: { prompt: 'summarize the doc' },
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    });
    const right = ingestTrace(db, {
      agent_name: 'inp', status: 'completed', input: { prompt: 'TOTALLY DIFFERENT PROMPT' },
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    });

    const diff = diffTraces(db, left.id, right.id);
    const inputDiff = diff.diffs.find((d) => d.field === 'trace_input');
    expect(inputDiff).toBeDefined();
    expect(inputDiff!.step_number).toBeNull(); // trace-level: must not pin divergence_step
    expect(diff.divergence_step).toBeNull();

    // Identical inputs still produce no such row.
    const same = ingestTrace(db, {
      agent_name: 'inp', status: 'completed', input: { prompt: 'summarize the doc' },
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    });
    expect(diffTraces(db, left.id, same.id).diffs.find((d) => d.field === 'trace_input')).toBeUndefined();
  });
});

describe('listTraces --since compares instants, not bytes', () => {
  // Regression: `started_at` is TEXT and the filter used a plain `>=`, so the
  // comparison was byte-wise. Nothing constrains the format a producer writes
  // (ingest, record and both importers pass a timestamp through verbatim), and
  // the byte order is not the time order — so a `check --since 1d` CI gate
  // skipped traces it should have checked while examining ones it shouldn't.
  const at = (name: string, started_at: string): IngestTraceInput => ({
    agent_name: name,
    status: 'completed',
    started_at,
    steps: [],
  });

  it('places an offset timestamp by its real instant', () => {
    // 14:00+02:00 IS 12:00Z — an hour *before* the cutoff — yet it sorted above
    // it byte-wise and was the one trace the old filter returned.
    ingestTrace(db, at('offset-before', '2026-08-16T14:00:00+02:00'));
    ingestTrace(db, at('utc-before', '2026-08-16T12:30:00.000Z'));
    ingestTrace(db, at('offset-after', '2026-08-16T16:00:00+02:00')); // = 14:00Z

    const names = listTraces(db, { since: '2026-08-16T13:00:00.000Z' })
      .items.map((t) => t.agent_name)
      .sort();
    expect(names).toEqual(['offset-after']);
  });

  it('includes a space-separated timestamp, which sorted below every window', () => {
    // SQLite's own datetime() form. `' '` sorts below `'T'`, so this was
    // excluded from EVERY --since window regardless of when it happened.
    ingestTrace(db, at('spacey', '2026-08-16 13:30:00'));
    const names = listTraces(db, { since: '2026-08-16T13:00:00.000Z' }).items.map((t) => t.agent_name);
    expect(names).toEqual(['spacey']);
  });

  it('still returns a row whose timestamp cannot be parsed at all', () => {
    // julianday() gives NULL for these; they fall back to the old byte compare
    // so the fix can never drop a row the previous behaviour returned.
    ingestTrace(db, at('unparseable', 'sometime-on-tuesday'));
    const names = listTraces(db, { since: '2026-08-16T13:00:00.000Z' }).items.map((t) => t.agent_name);
    expect(names).toEqual(['unparseable']);
  });

  it('orders by instant too, not just filters by it', () => {
    // The window was parsed but the ORDER BY still compared bytes, so `list`
    // ranked these by spelling: the newest trace was shown last, and it is the
    // first row a `--limit` (or the dashboard's LIMIT 30) drops.
    ingestTrace(db, at('newest', '2026-08-16 23:00:00')); // 23:00Z, sorts LAST byte-wise
    ingestTrace(db, at('oldest', '2026-08-16T09:00:00Z'));
    ingestTrace(db, at('middle', '2026-08-16T22:00:00+02:00')); // = 20:00Z

    expect(listTraces(db, {}).items.map((t) => t.agent_name)).toEqual(['newest', 'middle', 'oldest']);
    expect(listTraces(db, { sort_order: 'asc' }).items.map((t) => t.agent_name)).toEqual(['oldest', 'middle', 'newest']);
    // A --limit keeps the genuinely newest rows.
    expect(listTraces(db, { limit: 1 }).items.map((t) => t.agent_name)).toEqual(['newest']);
  });
});


describe('listTraces --sort duration matches the displayed duration', () => {
  it('orders by the effective duration, not the raw column', () => {
    // Regression: the sort mapped to `total_duration_ms` while `list`/`show`
    // display `effectiveDurationMs`, which falls back to ended_at - started_at.
    // The hook finalizer sets ONLY ended_at, so every hook-captured trace has a
    // null total_duration_ms and sorted last as a NULL — `list --sort -duration`
    // visibly ended with its longest rows, and "my slowest traces" returned the
    // wrong set.
    ingestTrace(db, {
      agent_name: 'explicit', status: 'completed', total_duration_ms: 35_000,
      started_at: '2026-08-16T00:00:00.000Z', steps: [],
    } as never);
    ingestTrace(db, {
      // 30 minutes, expressed only as a start/end pair — the hook shape.
      agent_name: 'derived', status: 'completed',
      started_at: '2026-08-16T00:00:00.000Z', ended_at: '2026-08-16T00:30:00.000Z',
      steps: [],
    } as never);

    const desc = listTraces(db, { sort_by: 'duration', sort_order: 'desc' })
      .items.map((t) => t.agent_name);
    expect(desc[0]).toBe('derived'); // 30m is the longest, and must come first
    expect(desc).toEqual(['derived', 'explicit']);
  });
});


describe('token totals fall back to the steps that carry them', () => {
  it('displays and sorts by the effective token count', () => {
    // Regression: the trace-level column is set only when a producer reports a
    // total, while ingest/record/OTel/importers all populate per-step
    // tokens_used — so `list` showed "-" for a measured trace and
    // `--sort -tokens` ranked a 50,000-token trace BELOW a 7-token one:
    // "my most expensive runs" returned the cheapest. `stats` and `replay`
    // already derived from the steps, so the tool disagreed with itself.
    ingestTrace(db, {
      agent_name: 'big-steps', status: 'completed',
      steps: [{ step_number: 1, step_type: 'llm_call', name: 'x', tokens_used: 50_000 }],
    } as never);
    ingestTrace(db, {
      agent_name: 'small-total', status: 'completed', total_tokens: 7,
      steps: [{ step_number: 1, step_type: 'llm_call', name: 'y' }],
    } as never);

    const byTokens = listTraces(db, { sort_by: 'tokens', sort_order: 'desc' }).items;
    expect(byTokens.map((t) => t.agent_name)).toEqual(['big-steps', 'small-total']);
    expect(byTokens[0].effective_tokens).toBe(50_000);
    // A producer-reported total still wins over the steps' sum.
    expect(byTokens[1].effective_tokens).toBe(7);
    // The stored column is untouched — this is a display value.
    expect(byTokens[0].total_tokens).toBeNull();
  });
});
