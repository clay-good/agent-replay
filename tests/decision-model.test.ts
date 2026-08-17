import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchemaV1, applySchemaV2, SCHEMA_VERSION } from '../src/db/schema.js';
import { runMigrations } from '../src/db/migrations.js';
import { getSchemaVersion } from '../src/db/schema.js';
import { ingestTrace, getTrace, listTraces, attachDecision } from '../src/services/trace-service.js';
import { forkTrace } from '../src/services/fork-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { listDecisions, causalWalk } from '../src/services/decision-service.js';
import { validateTraceInput } from '../src/utils/validators.js';
import type { IngestTraceInput } from '../src/models/types.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

// ── 1. Migration (task 1.3) ───────────────────────────────────────────────

describe('v1 → v2 migration', () => {
  it('migrates a v1 database to v2 and preserves existing rows', () => {
    // Build a real v1 database and populate it directly.
    applySchemaV1(db);
    expect(getSchemaVersion(db)).toBe(1);

    db.prepare(
      `INSERT INTO agent_traces (id, agent_name, status, input, started_at, tags, metadata, created_at)
       VALUES ('trc_legacy', 'legacy-agent', 'completed', '{}', '2026-01-01T00:00:00Z', '[]', '{}', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_trace_steps (id, trace_id, step_number, step_type, name, input, metadata)
       VALUES ('stp_legacy', 'trc_legacy', 1, 'thought', 'legacy_step', '{}', '{}')`,
    ).run();

    const after = runMigrations(db);
    expect(after).toBe(SCHEMA_VERSION);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // The pre-existing trace and step survive, with new columns defaulting to NULL.
    const trace = getTrace(db, 'trc_legacy');
    expect(trace).not.toBeNull();
    expect(trace!.agent_name).toBe('legacy-agent');
    expect(trace!.session_id).toBeNull();
    expect(trace!.steps).toHaveLength(1);
    expect(trace!.steps[0].parent_step_number).toBeNull();
    expect(trace!.steps[0].caused_by_step_number).toBeNull();

    // The new decisions table now exists.
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_trace_decisions'")
      .get();
    expect(tbl).toBeTruthy();
  });

  it('brings a fresh database straight to the current version', () => {
    expect(runMigrations(db)).toBe(SCHEMA_VERSION);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is idempotent when already current', () => {
    runMigrations(db);
    expect(runMigrations(db)).toBe(SCHEMA_VERSION);
  });

  it('does not crash re-applying v2 when the columns already exist (upgrade race)', () => {
    // Simulate a concurrent upgrade: the winning process already applied v2 —
    // the new columns exist — but this process still sees the recorded version
    // as 1 (its read lost the race). Re-running the v2 migration must be a
    // no-op, not a `duplicate column name` crash that (under `hook`) silently
    // drops a step.
    applySchemaV1(db);
    applySchemaV2(db); // "winner": columns added, version bumped to 2
    db.prepare('DELETE FROM schema_version WHERE version = 2').run(); // "loser" still reads 1
    expect(getSchemaVersion(db)).toBe(1);

    expect(() => runMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('adds the v3 lookup indexes, and they are actually used', () => {
    // v3 is additive (indexes only, no columns or data), so an older binary
    // opening a v3 store is unaffected. Both queries were full scans: the OTel
    // merge lookup re-scanned the whole trace table once per incoming batch, so
    // a long-running `otel serve` got steadily slower as the store grew, and
    // the dashboard sorted the entire evals table on every 5s refresh.
    applySchemaV1(db);
    applySchemaV2(db);
    expect(getSchemaVersion(db)).toBe(2);
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const plan = (sql: string, ...params: unknown[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');

    expect(plan("SELECT id FROM agent_traces WHERE json_extract(metadata, '$.otel_trace_id') = ? LIMIT 1", 'x'))
      .toContain('idx_agent_traces_otel_trace');
    const evalPlan = plan('SELECT score, evaluated_at FROM agent_trace_evals ORDER BY evaluated_at DESC LIMIT ?', 20);
    expect(evalPlan).toContain('idx_agent_trace_evals_evaluated_at');
    expect(evalPlan).not.toContain('TEMP B-TREE'); // the index supplies the order
  });
});

// ── 2. Validators (task 2.3) ──────────────────────────────────────────────

describe('structural + decision validation', () => {
  const base = (steps: unknown[]): unknown => ({ agent_name: 'a', steps });

  it('accepts valid parent/causal references and a decision block', () => {
    const input = base([
      { step_number: 1, step_type: 'tool_call', name: 'search' },
      {
        step_number: 2,
        step_type: 'decision',
        name: 'choose',
        caused_by_step: 1,
        decision: {
          options: [{ option: 'a', score: 0.9 }, { option: 'b' }],
          chosen: 'a',
          confidence: 0.9,
          decided_by: 'agent',
        },
      },
      { step_number: 3, step_type: 'tool_call', name: 'act', parent_step: 2, caused_by_step: 2 },
    ]);
    expect(validateTraceInput(input).valid).toBe(true);
  });

  it('rejects a parent_step that points forward', () => {
    const input = base([
      { step_number: 1, step_type: 'thought', name: 'x', parent_step: 2 },
      { step_number: 2, step_type: 'thought', name: 'y' },
    ]);
    const r = validateTraceInput(input);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'steps[0].parent_step')).toBe(true);
  });

  it('rejects a caused_by_step referencing a missing step', () => {
    const input = base([
      { step_number: 1, step_type: 'thought', name: 'x' },
      { step_number: 2, step_type: 'thought', name: 'y', caused_by_step: 9 },
    ]);
    const r = validateTraceInput(input);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'steps[1].caused_by_step')).toBe(true);
  });

  it('accepts a decision block on a non-decision step, as every other layer does', () => {
    // This assertion was inverted deliberately. It used to require
    // step_type === 'decision', but nothing else maintains that invariant: the
    // live recorder and the SDK attach a decision to whatever step is being
    // written, the writers insert it unconditionally, and the readers were all
    // corrected to surface it wherever it sits (see "lists a decision attached
    // to a non-decision step" below, whose comment names this asymmetry). The
    // validator was rejecting the tool's own output — a decision captured live
    // and written by `export` could not be re-ingested, so a backup could not
    // be restored. The record's shape is still validated.
    const input = base([
      { step_number: 1, step_type: 'tool_call', name: 'x', decision: { chosen: 'a' } },
    ]);
    expect(validateTraceInput(input).valid).toBe(true);

    // A malformed decision is still rejected, wherever it is attached.
    const bad = base([
      { step_number: 1, step_type: 'tool_call', name: 'x', decision: { chosen: 'a', confidence: 1.5 } },
    ]);
    expect(validateTraceInput(bad).valid).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    const input = base([
      { step_number: 1, step_type: 'decision', name: 'd', decision: { chosen: 'a', confidence: 1.5 } },
    ]);
    const r = validateTraceInput(input);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'steps[0].decision.confidence')).toBe(true);
  });

  it('rejects an unknown decided_by', () => {
    const input = base([
      { step_number: 1, step_type: 'decision', name: 'd', decision: { chosen: 'a', decided_by: 'robot' } },
    ]);
    const r = validateTraceInput(input);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'steps[0].decision.decided_by')).toBe(true);
  });

  it('requires chosen when a decision block is present', () => {
    const input = base([
      { step_number: 1, step_type: 'decision', name: 'd', decision: { options: [{ option: 'a' }] } },
    ]);
    const r = validateTraceInput(input);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'steps[0].decision.chosen')).toBe(true);
  });

  it('rejects a non-string session_id', () => {
    const r = validateTraceInput({ agent_name: 'a', session_id: 42 });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'session_id')).toBe(true);
  });
});

// ── 3. Round-trip ingest + fork (tasks 3.1–3.3) ───────────────────────────

function branchingTrace(): IngestTraceInput {
  return {
    agent_name: 'brancher',
    status: 'completed',
    session_id: 'sess_abc123',
    steps: [
      { step_number: 1, step_type: 'thought', name: 'plan' },
      {
        step_number: 2,
        step_type: 'decision',
        name: 'pick_tool',
        caused_by_step: 1,
        decision: {
          options: [{ option: 'search', score: 0.8 }, { option: 'ask' }],
          chosen: 'search',
          rationale: 'query is specific',
          confidence: 0.8,
          decided_by: 'agent',
        },
      },
      { step_number: 3, step_type: 'tool_call', name: 'search', parent_step: 2, caused_by_step: 2 },
      { step_number: 4, step_type: 'output', name: 'answer', caused_by_step: 3 },
    ],
  };
}

describe('ingest / getTrace round-trip', () => {
  beforeEach(() => runMigrations(db));

  it('persists hierarchy, causality, decision, and session', () => {
    const t = ingestTrace(db, branchingTrace());
    expect(t.session_id).toBe('sess_abc123');

    const full = getTrace(db, t.id)!;
    const s3 = full.steps.find((s) => s.step_number === 3)!;
    expect(s3.parent_step_number).toBe(2);
    expect(s3.caused_by_step_number).toBe(2);

    const s2 = full.steps.find((s) => s.step_number === 2)!;
    expect(s2.decision).toBeTruthy();
    expect(s2.decision!.chosen).toBe('search');
    expect(s2.decision!.confidence).toBe(0.8);
    expect(s2.decision!.decided_by).toBe('agent');
    expect(s2.decision!.options).toHaveLength(2);

    // Steps that are not decisions carry no record.
    expect(full.steps.find((s) => s.step_number === 1)!.decision ?? null).toBeNull();
  });

  it('survives a real exportTraces → ingest round-trip with decisions, causality, and snapshots', () => {
    ingestTrace(db, {
      agent_name: 'rt',
      session_id: 'rt1',
      status: 'completed',
      total_tokens: 250,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 2, step_type: 'decision', name: 'pick', caused_by_step: 1, decision: { chosen: 'fast', rationale: 'deadline', confidence: 0.9, decided_by: 'agent', options: [{ option: 'fast', score: 0.9 }, { option: 'slow' }] } },
        { step_number: 3, step_type: 'llm_call', name: 'gen', parent_step: 2, caused_by_step: 2, model: 'gpt-4', tokens_used: 250, snapshot: { context_window: { messages: 5 }, token_count: 300 } },
      ],
    });

    // Round-trip through the real exporter's output, not a hand-built shape.
    const exported = JSON.parse(exportTraces(db, {}, 'json', { withSnapshots: true })) as IngestTraceInput[];
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    runMigrations(db2);
    const re = getTrace(db2, ingestTrace(db2, exported[0]).id)!;
    db2.close();

    expect(re.session_id).toBe('rt1');
    expect(re.total_tokens).toBe(250);
    const dec = re.steps.find((s) => s.step_type === 'decision')!;
    expect(dec.decision!.chosen).toBe('fast');
    expect(dec.decision!.decided_by).toBe('agent');
    expect(dec.decision!.options).toHaveLength(2);
    expect(dec.caused_by_step_number).toBe(1);
    const llm = re.steps.find((s) => s.step_type === 'llm_call')!;
    expect(llm.parent_step_number).toBe(2);
    expect(llm.caused_by_step_number).toBe(2);
    expect(llm.model).toBe('gpt-4');
  });

  it('fork preserves step references and decision records', () => {
    const t = ingestTrace(db, branchingTrace());
    const fork = forkTrace(db, t.id, 3);
    expect(fork.steps_copied).toBe(3);

    const forked = getTrace(db, fork.forked_trace_id)!;
    expect(forked.session_id).toBe('sess_abc123');
    const fs3 = forked.steps.find((s) => s.step_number === 3)!;
    expect(fs3.parent_step_number).toBe(2);
    expect(fs3.caused_by_step_number).toBe(2);
    const fs2 = forked.steps.find((s) => s.step_number === 2)!;
    expect(fs2.decision!.chosen).toBe('search');
  });
});

// ── 4. decision-service (task 4.1, 4.3) ───────────────────────────────────

describe('decision-service', () => {
  beforeEach(() => runMigrations(db));

  it('lists decisions in step order', () => {
    const t = ingestTrace(db, {
      agent_name: 'd',
      steps: [
        { step_number: 1, step_type: 'decision', name: 'first', decision: { chosen: 'x' } },
        { step_number: 2, step_type: 'tool_call', name: 'act' },
        { step_number: 3, step_type: 'decision', name: 'second', decision: { chosen: 'y' } },
      ],
    });
    const res = listDecisions(db, t.id)!;
    expect(res.decisions.map((d) => d.step.name)).toEqual(['first', 'second']);
    expect(res.decisions[0].decision!.chosen).toBe('x');
  });

  it('lists a decision attached to a non-decision step, matching `why`', () => {
    // The live recorder / SDK (attachDecision) can attach a decision record to
    // a step of any type — no step_type guard, unlike the ingest validator.
    // `listDecisions` must surface it, or `decisions` omits a record that the
    // causal walk (`why`) shows on the same trace.
    const t = ingestTrace(db, {
      agent_name: 'live',
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'search_db' }],
    });
    attachDecision(db, t.id, 1, { chosen: 'use_cache', decided_by: 'policy' });

    const res = listDecisions(db, t.id)!;
    expect(res.decisions.map((d) => d.step.name)).toEqual(['search_db']);
    expect(res.decisions[0].decision!.chosen).toBe('use_cache');

    // Consistent with the causal walk, which surfaces the same record.
    const hop = causalWalk(db, t.id, 1)!.chain.find((h) => h.step.step_number === 1)!;
    expect(hop.decision!.chosen).toBe('use_cache');
  });

  it('walks the causal chain back to the root and orders hops', () => {
    const t = ingestTrace(db, branchingTrace());
    const res = causalWalk(db, t.id, 4)!;
    // 4 ⟵(caused_by) 3 ⟵(caused_by) 2 ⟵(caused_by) 1
    expect(res.chain.map((h) => h.step.step_number)).toEqual([4, 3, 2, 1]);
    expect(res.chain[0].link).toBe('origin');
    expect(res.chain[2].link).toBe('caused_by');
    // The decision hop carries its record.
    const decisionHop = res.chain.find((h) => h.step.step_number === 2)!;
    expect(decisionHop.decision!.chosen).toBe('search');
  });

  it('falls back to parent then to the nearest earlier decision', () => {
    const t = ingestTrace(db, {
      agent_name: 'fallback',
      steps: [
        { step_number: 1, step_type: 'decision', name: 'root_decision', decision: { chosen: 'go' } },
        { step_number: 2, step_type: 'tool_call', name: 'nested', parent_step: 1 },
        { step_number: 3, step_type: 'output', name: 'end' }, // no refs → prior decision
      ],
    });
    // step 2 has parent but no caused_by → parent link
    const walk2 = causalWalk(db, t.id, 2)!;
    expect(walk2.chain.map((h) => h.step.step_number)).toEqual([2, 1]);
    expect(walk2.chain[1].link).toBe('parent');

    // step 3 has neither → prior decision fallback to step 1
    const walk3 = causalWalk(db, t.id, 3)!;
    expect(walk3.chain.map((h) => h.step.step_number)).toEqual([3, 1]);
    expect(walk3.chain[1].link).toBe('prior_decision');
  });

  it('falls back to a decision record attached to a non-decision step', () => {
    // The causal-walk fallback ("nearest earlier decision point") must recognize
    // a decision record on a tool_call/llm_call step, not only a decision-type
    // step — consistent with listDecisions, since the live path attaches records
    // to any step type.
    const t = ingestTrace(db, {
      agent_name: 'fb',
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'gather' },
        { step_number: 2, step_type: 'output', name: 'end' }, // no refs → prior-decision fallback
      ],
    });
    attachDecision(db, t.id, 1, { chosen: 'go', decided_by: 'agent' });
    const walk = causalWalk(db, t.id, 2)!;
    expect(walk.chain.map((h) => h.step.step_number)).toEqual([2, 1]);
    expect(walk.chain[1].link).toBe('prior_decision');
    expect(walk.chain[1].decision!.chosen).toBe('go');
  });

  it('returns an empty chain for an unknown step number', () => {
    const t = ingestTrace(db, branchingTrace());
    expect(causalWalk(db, t.id, 99)!.chain).toHaveLength(0);
  });
});

// ── 5. Session filter (task 4.2) ──────────────────────────────────────────

describe('listTraces session filter', () => {
  beforeEach(() => runMigrations(db));

  it('filters by session_id with prefix matching', () => {
    ingestTrace(db, { agent_name: 'a', session_id: 'd4c9-uuid-1' });
    ingestTrace(db, { agent_name: 'b', session_id: 'd4c9-uuid-1' });
    ingestTrace(db, { agent_name: 'c', session_id: 'other-uuid' });

    expect(listTraces(db, { session_id: 'd4c9-uuid-1' }).total).toBe(2);
    expect(listTraces(db, { session_id: 'd4c9' }).total).toBe(2); // prefix
    expect(listTraces(db, { session_id: 'other' }).total).toBe(1);
  });
});
