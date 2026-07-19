import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchemaV1 } from '../src/db/schema.js';
import { runMigrations } from '../src/db/migrations.js';
import { getSchemaVersion } from '../src/db/schema.js';
import { ingestTrace, getTrace, listTraces } from '../src/services/trace-service.js';
import { forkTrace } from '../src/services/fork-service.js';
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
    expect(after).toBe(2);
    expect(getSchemaVersion(db)).toBe(2);

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

  it('brings a fresh database straight to v2', () => {
    expect(runMigrations(db)).toBe(2);
    expect(getSchemaVersion(db)).toBe(2);
  });

  it('is idempotent when already at v2', () => {
    runMigrations(db);
    expect(runMigrations(db)).toBe(2);
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

  it('rejects a decision block on a non-decision step', () => {
    const input = base([
      { step_number: 1, step_type: 'tool_call', name: 'x', decision: { chosen: 'a' } },
    ]);
    const r = validateTraceInput(input);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'steps[0].decision')).toBe(true);
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
