import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import {
  startTrace,
  appendStep,
  getStepsAfter,
  getMostRecentRunningTrace,
  isPossiblyAbandoned,
  updateTrace,
} from '../src/services/trace-service.js';
import { renderStepLine } from '../src/commands/watch.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

// ── getStepsAfter (live tail core, task 7.3) ──────────────────────────────

describe('getStepsAfter', () => {
  it('returns only steps beyond the cursor, in step order', () => {
    const t = startTrace(db, { agent_name: 'tail' });
    // Insert out of natural order to prove sorting.
    appendStep(db, t.id, { step_number: 2, step_type: 'tool_call', name: 'b' });
    appendStep(db, t.id, { step_number: 1, step_type: 'thought', name: 'a' });
    appendStep(db, t.id, { step_number: 3, step_type: 'output', name: 'c' });

    expect(getStepsAfter(db, t.id, 0).map((s) => s.step_number)).toEqual([1, 2, 3]);
    expect(getStepsAfter(db, t.id, 1).map((s) => s.name)).toEqual(['b', 'c']);
    expect(getStepsAfter(db, t.id, 3)).toEqual([]);
  });

  it('sees steps appended after an initial read (incremental tail)', () => {
    const t = startTrace(db, { agent_name: 'tail' });
    appendStep(db, t.id, { step_number: 1, step_type: 'thought', name: 'a' });
    let seen = getStepsAfter(db, t.id, 0);
    let cursor = seen.at(-1)!.step_number;
    expect(cursor).toBe(1);

    appendStep(db, t.id, { step_number: 2, step_type: 'output', name: 'b' });
    const fresh = getStepsAfter(db, t.id, cursor);
    expect(fresh.map((s) => s.step_number)).toEqual([2]);
  });
});

// ── getMostRecentRunningTrace ─────────────────────────────────────────────

describe('getMostRecentRunningTrace', () => {
  it('returns the newest running trace, ignoring finished ones', () => {
    startTrace(db, { agent_name: 'old', started_at: '2026-01-01T00:00:00Z' });
    const newer = startTrace(db, { agent_name: 'new', started_at: '2026-06-01T00:00:00Z' });
    const done = startTrace(db, { agent_name: 'done', started_at: '2026-07-01T00:00:00Z' });
    updateTrace(db, done.id, { status: 'completed' });

    const running = getMostRecentRunningTrace(db)!;
    expect(running.id).toBe(newer.id);
  });

  it('returns null when nothing is running', () => {
    const t = startTrace(db, { agent_name: 'x' });
    updateTrace(db, t.id, { status: 'completed' });
    expect(getMostRecentRunningTrace(db)).toBeNull();
  });
});

// ── isPossiblyAbandoned (task 7.2) ────────────────────────────────────────

describe('isPossiblyAbandoned', () => {
  const now = Date.parse('2026-07-18T12:00:00Z');

  it('flags a running trace older than the threshold', () => {
    expect(isPossiblyAbandoned({ status: 'running', started_at: '2026-07-18T11:00:00Z' }, 30 * 60 * 1000, now)).toBe(true);
  });

  it('does not flag a fresh running trace', () => {
    expect(isPossiblyAbandoned({ status: 'running', started_at: '2026-07-18T11:50:00Z' }, 30 * 60 * 1000, now)).toBe(false);
  });

  it('never flags finished traces', () => {
    expect(isPossiblyAbandoned({ status: 'completed', started_at: '2020-01-01T00:00:00Z' }, 30 * 60 * 1000, now)).toBe(false);
  });
});

// ── renderStepLine ────────────────────────────────────────────────────────

describe('renderStepLine', () => {
  it('includes the step number, name, and error', () => {
    const line = renderStepLine({
      id: 's', trace_id: 't', step_number: 5, step_type: 'error', name: 'boom',
      input: {}, output: null, started_at: '', ended_at: null, duration_ms: null,
      tokens_used: null, model: null, error: 'kaboom', metadata: {},
      parent_step_number: null, caused_by_step_number: null,
    });
    // Strip ANSI for a stable assertion.
    const plain = line.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('#5');
    expect(plain).toContain('"boom"');
    expect(plain).toContain('kaboom');
  });
});
