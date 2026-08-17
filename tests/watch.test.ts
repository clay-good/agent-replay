import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import {
  startTrace,
  appendStep,
  getStepsAfter,
  getMostRecentRunningTrace,
  getTrace,
  isPossiblyAbandoned,
  updateTrace,
  updateStep,
} from '../src/services/trace-service.js';
import { forkTrace } from '../src/services/fork-service.js';
import { runWatch, renderStepLine, unseenSteps } from '../src/commands/watch.js';

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

// ── unseenSteps (live tail cursor — out-of-order safety) ──────────────────

describe('unseenSteps', () => {
  it('does not drop a step written after a higher-numbered one', () => {
    const t = startTrace(db, { agent_name: 'tail' });
    const seen = new Set<number>();

    // Poll 1: the producer has written step 2 first.
    appendStep(db, t.id, { step_number: 2, step_type: 'tool_call', name: 'b' });
    let batch = unseenSteps(getStepsAfter(db, t.id, 0), seen);
    batch.forEach((s) => seen.add(s.step_number));
    expect(batch.map((s) => s.step_number)).toEqual([2]);

    // Poll 2: step 1 arrives late (a lower number). A max-step-number cursor
    // (`getStepsAfter(id, 2)`) would filter it out and silently drop it; the
    // seen-set surfaces it.
    appendStep(db, t.id, { step_number: 1, step_type: 'thought', name: 'a' });
    batch = unseenSteps(getStepsAfter(db, t.id, 0), seen);
    batch.forEach((s) => seen.add(s.step_number));
    expect(batch.map((s) => s.step_number)).toEqual([1]);

    // Poll 3: nothing new.
    expect(unseenSteps(getStepsAfter(db, t.id, 0), seen)).toEqual([]);
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

  // "Most recent" must be the parsed instant. This resolver ranks traces from
  // different producers, each writing started_at in whatever form it received,
  // and byte order is not time order: SQLite's space form sorts below every
  // `T`-separated timestamp, and a negative offset sorts above the UTC instant it
  // precedes. Bare `watch` then tailed an older run and showed nothing happening.
  it('ranks by the parsed instant, not the byte order of started_at', () => {
    const cases: [string, string][] = [
      // space form (SQLite's own) is later but sorts below every `T` form
      ['2026-08-17T10:00:00Z', '2026-08-17 16:00:00'],
      // 09:10-07:00 is 16:10Z — later than 16:00Z, but sorts below it
      ['2026-08-17T16:00:00Z', '2026-08-17T09:10:00-07:00'],
    ];
    for (const [earlier, later] of cases) {
      db.exec('DELETE FROM agent_traces');
      startTrace(db, { agent_name: 'earlier', started_at: earlier });
      const newest = startTrace(db, { agent_name: 'later', started_at: later });
      expect(getMostRecentRunningTrace(db)!.id).toBe(newest.id);
    }
  });

  it('still returns a trace whose timestamp julianday cannot parse', () => {
    const t = startTrace(db, { agent_name: 'odd', started_at: 'whenever' });
    expect(getMostRecentRunningTrace(db)!.id).toBe(t.id);
  });

  it('ignores forks, which open as running with a newer start time', () => {
    // `watch` with no trace id follows this. A fork is a static what-if copy, so
    // attaching to one shows nothing happening while the live run scrolls by.
    const live = startTrace(db, { agent_name: 'live', started_at: '2026-01-01T00:00:00Z' });
    appendStep(db, live.id, { step_number: 1, step_type: 'thought', name: 'a' });
    const fork = forkTrace(db, live.id, 1);

    expect(getMostRecentRunningTrace(db)!.id).toBe(live.id);
    // The fork is still `running` and still newer — it is skipped by lineage, not by status.
    expect(getTrace(db, fork.forked_trace_id)!.status).toBe('running');
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

// ── runWatch completion-race drain ────────────────────────────────────────

describe('runWatch drains the tail on completion', () => {
  it('prints a step committed in the race window between the poll and the status check', () => {
    // The producer is a separate process; it can commit a final step AND flip
    // status to completed in the gap between a tick's step read (printNew) and
    // its status read. finish() must drain once more, or that step is dropped
    // from the tail even though `show` displays it.
    const dir = mkdtempSync(join(tmpdir(), 'ar-watch-'));
    const db = ensureDatabase(resolve(dir, 'traces.db')); // same singleton runWatch will open
    const t = startTrace(db, { agent_name: 'w', status: 'running' }, { id: 'trc_watchrace' });
    appendStep(db, t.id, { step_number: 1, step_type: 'thought', name: 'first' });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m ?? '')); });

    // Interpose on the tick's status read: reading the status also commits the
    // final step and completes the trace, reproducing the cross-process race.
    const realPrepare = db.prepare.bind(db);
    let raced = false;
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes('SELECT status')) {
        const realGet = stmt.get.bind(stmt);
        (stmt as unknown as { get: (...a: unknown[]) => unknown }).get = (...args: unknown[]) => {
          if (!raced) {
            raced = true;
            appendStep(db, t.id, { step_number: 2, step_type: 'output', name: 'raced-final' });
            updateTrace(db, t.id, { status: 'completed' });
          }
          return realGet(...args);
        };
      }
      return stmt;
    }) as typeof db.prepare);

    vi.useFakeTimers();
    try {
      runWatch(t.id, { dir, interval: '20' });
      vi.advanceTimersByTime(20); // one poll → race → completion → finish()
    } finally {
      vi.useRealTimers();
      prepareSpy.mockRestore();
      logSpy.mockRestore();
      process.removeAllListeners('SIGINT');
      rmSync(dir, { recursive: true, force: true });
    }

    const plain = logs.map((l) => l.replace(/\x1B\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('first');        // the pre-race step
    expect(plain).toContain('raced-final');  // the step committed at completion — dropped before the fix
    expect(plain).toContain('finished');     // the completion badge still printed
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

// ── runWatch reflects step_end ────────────────────────────────────────────

describe('runWatch shows a step\'s outcome, not just its start', () => {
  it('prints a closing line when a two-phase step ends', () => {
    // Under the documented two-phase protocol (`step_start` → `step_end`) a step
    // is FIRST SEEN open: duration, tokens and error are all still null. Printing
    // each step exactly once meant the live tail never showed any of them — a
    // failing run announced "trace finished: FAILED" with no error text, while
    // `show` on the same trace printed it.
    const dir = mkdtempSync(join(tmpdir(), 'ar-watch-end-'));
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const t = startTrace(db, { agent_name: 'w', status: 'running' }, { id: 'trc_watchend' });
    appendStep(db, t.id, { step_number: 1, step_type: 'tool_call', name: 'slow_tool' });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m ?? '')); });

    vi.useFakeTimers();
    try {
      runWatch(t.id, { dir, interval: '20' });
      // The step closes between polls, exactly as a separate producer process
      // would close it.
      updateStep(db, t.id, 1, {
        ended_at: new Date().toISOString(), duration_ms: 2900, tokens_used: 999, error: 'TOOL BLEW UP',
      });
      vi.advanceTimersByTime(20);
      updateTrace(db, t.id, { status: 'failed' });
      vi.advanceTimersByTime(20);
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      process.removeAllListeners('SIGINT');
      rmSync(dir, { recursive: true, force: true });
    }

    const plain = logs.map((l) => l.replace(/\x1B\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('slow_tool');      // the opening line
    expect(plain).toContain('TOOL BLEW UP');   // the outcome — withheld before the fix
    expect(plain).toContain('2.9s');
    expect(plain).toContain('999 tok');
    // And it closes exactly once, however many polls follow.
    expect(plain.match(/TOOL BLEW UP/g)).toHaveLength(1);
  });

  it('shows WHY a run failed, not just that it did', () => {
    // The step-level fix covers a failure a STEP recorded. The two most common
    // failure paths write a TRACE-level error and no step error at all: `run`
    // finalizing a non-zero child exit, and a `trace_end` event carrying `error`.
    // So the one view open at the moment a run died said "FAILED" and nothing
    // else, while `show` on the same trace printed the reason.
    const dir = mkdtempSync(join(tmpdir(), 'ar-watch-err-'));
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const t = startTrace(db, { agent_name: 'w', status: 'running' }, { id: 'trc_watcherr' });
    appendStep(db, t.id, { step_number: 1, step_type: 'tool_call', name: 'fetch' });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m ?? '')); });

    vi.useFakeTimers();
    try {
      runWatch(t.id, { dir, interval: '20' });
      updateTrace(db, t.id, { status: 'failed', error: 'child exited with code 3' });
      vi.advanceTimersByTime(20);
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      process.removeAllListeners('SIGINT');
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }

    const plain = logs.map((l) => l.replace(/\x1B\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('FAILED');
    expect(plain).toContain('child exited with code 3');
  });

  it('does not add a closing line for a single-phase step', () => {
    // A producer that writes a complete step in one event already showed
    // everything on its first line; a second line would be noise.
    const dir = mkdtempSync(join(tmpdir(), 'ar-watch-one-'));
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const t = startTrace(db, { agent_name: 'w', status: 'running' }, { id: 'trc_watchone' });
    appendStep(db, t.id, {
      step_number: 1, step_type: 'tool_call', name: 'quick', ended_at: new Date().toISOString(),
      duration_ms: 5, tokens_used: 3,
    });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m ?? '')); });
    vi.useFakeTimers();
    try {
      runWatch(t.id, { dir, interval: '20' });
      vi.advanceTimersByTime(60);
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      process.removeAllListeners('SIGINT');
      rmSync(dir, { recursive: true, force: true });
    }
    const plain = logs.map((l) => l.replace(/\x1B\[[0-9;]*m/g, '')).join('\n');
    expect(plain).toContain('quick');
    expect(plain).not.toContain('done');
  });
});
