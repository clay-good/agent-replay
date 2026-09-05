/**
 * Ordering traces by the instant their timestamp MEANS, for every timestamp
 * format a producer actually writes.
 *
 * `started_at` is TEXT and nothing constrains its format, so ordering it by
 * bytes ranks traces by spelling. Schema v4 fixed that by indexing and ordering
 * on `julianday(started_at)` — but `julianday()` returns NULL for an ISO-8601
 * *basic*-format offset (`+0200`), which is what `date +%FT%T%z` emits and what
 * `ingest` stores verbatim. Those rows had no instant to sort by, so they
 * clustered at one end of the result and were ranked among themselves by bytes
 * again: `list` printed the newest trace LAST, `list --limit 1` returned the
 * wrong trace, and `watch` attached to the wrong running run.
 *
 * Schema v5 indexes the repaired expression (`julianDayExpr`), so these queries
 * are both correct and still keyed. Both halves matter and both are asserted:
 * ordering the rows correctly is useless if it costs a full scan of the store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { SCHEMA_VERSION, getSchemaVersion, applySchemaV1, applySchemaV2, applySchemaV3, applySchemaV4 } from '../src/db/schema.js';
import { listTraces, getMostRecentRunningTrace } from '../src/services/trace-service.js';
import { recentTraces } from '../src/ui/dashboard-data.js';
import { julianDayExpr } from '../src/utils/time.js';
import { applyHookPayload } from '../src/services/hook-adapter.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => db.close());

/** Insert a trace directly, so the raw timestamp text is preserved verbatim. */
function trace(id: string, startedAt: string, status = 'completed') {
  db.prepare(
    `INSERT INTO agent_traces (id, agent_name, trigger, status, input, started_at, tags, metadata, created_at)
     VALUES (?, ?, 'manual', ?, '{}', ?, '[]', '{}', '2026-01-01T00:00:00.000Z')`,
  ).run(id, id, status, startedAt);
}

/** Newest to oldest by real instant: basic_new (12:00Z) > zulu (11:00Z) > basic_old (10:00Z). */
function mixedFormats() {
  trace('basic_new', '2026-08-20T14:00:00+0200'); // 12:00Z — the NEWEST
  trace('zulu', '2026-08-20T11:00:00Z');
  trace('basic_old', '2026-08-20T08:00:00-0200'); // 10:00Z — the OLDEST
  trace('space_form', '2026-08-20 10:30:00'); // 10:30Z — SQLite's own form
}

describe('traces are ordered by instant, whatever the timestamp format', () => {
  it('puts the newest trace first even when its offset is basic-format', () => {
    mixedFormats();
    const ids = listTraces(db, {}).items.map((t) => t.id);
    expect(ids).toEqual(['basic_new', 'zulu', 'space_form', 'basic_old']);
  });

  it('returns the actual newest trace under --limit 1', () => {
    // The user-visible consequence: a LIMIT applied to a wrong order drops the
    // wrong rows, and one row is where it is most obvious.
    mixedFormats();
    expect(listTraces(db, { limit: 1 }).items.map((t) => t.id)).toEqual(['basic_new']);
  });

  it('puts the oldest trace first when sorting ascending', () => {
    mixedFormats();
    const ids = listTraces(db, { sort_by: 'started_at', sort_order: 'asc' }).items.map((t) => t.id);
    expect(ids).toEqual(['basic_old', 'space_form', 'zulu', 'basic_new']);
  });

  it('attaches watch to the newest RUNNING trace, not the best-spelled one', () => {
    trace('old_run', '2026-08-22T10:00:00Z', 'running');
    trace('new_run', '2026-08-22T14:00:00+0200', 'running'); // 12:00Z — newer
    expect(getMostRecentRunningTrace(db)?.id).toBe('new_run');
  });

  it('orders the dashboard recent-traces panel the same way', () => {
    mixedFormats();
    expect(recentTraces(db, 2).map((r) => r.id)).toEqual(['basic_new', 'zulu']);
  });

  it('still places a timestamp no format can parse, without dropping it', () => {
    // Deliberate fail-open: an unparseable timestamp keeps the byte-order
    // tiebreak rather than vanishing from the list.
    mixedFormats();
    trace('unparseable', 'not-a-timestamp');
    const ids = listTraces(db, {}).items.map((t) => t.id);
    expect(ids).toContain('unparseable');
    expect(ids).toHaveLength(5);
  });
});

describe('schema v5 keeps the corrected ordering indexed', () => {
  it('serves the default list ordering from an index, not a temp B-tree', () => {
    // If a future edit changes the ORDER BY expression without changing the
    // index to match, ordering stays correct but every list full-scans and
    // sorts. That regression is invisible in behavior, so assert the plan.
    mixedFormats();
    // Built from julianDayExpr, so the assertion tracks the source expression
    // rather than a copy of it that could drift out of sync.
    const orderBy = `${julianDayExpr('started_at')} DESC, started_at DESC`;
    const plan = (
      db
        .prepare(`EXPLAIN QUERY PLAN SELECT id FROM agent_traces ORDER BY ${orderBy} LIMIT 25`)
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toMatch(/USING INDEX idx_agent_traces_started_instant_v2/);
    expect(plan).not.toMatch(/USE TEMP B-TREE/);
  });

  it('migrates a v4 store up to v5 and creates the index', () => {
    const old = new Database(':memory:');
    try {
      applySchemaV1(old);
      applySchemaV2(old);
      applySchemaV3(old);
      applySchemaV4(old);
      expect(getSchemaVersion(old)).toBe(4);

      expect(runMigrations(old)).toBe(SCHEMA_VERSION);
      // Tracks the constant rather than a literal: this test is about the v5
      // INDEXES surviving the upgrade, not about which version is current, and
      // hard-coding the number made every later migration fail it spuriously.
      expect(getSchemaVersion(old)).toBe(SCHEMA_VERSION);
      const idx = old
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_agent_traces_started_instant%'")
        .all() as { name: string }[];
      // Both: v5's index serves the ORDER BY, v4's still serves SINCE_PREDICATE.
      expect(idx.map((r) => r.name).sort()).toEqual([
        'idx_agent_traces_started_instant',
        'idx_agent_traces_started_instant_v2',
      ]);
    } finally {
      old.close();
    }
  });
});


describe('the same repair applies to every path that ranks by time', () => {
  // The first pass fixed `list`, `watch` and the dashboard. Three more callers
  // ordered by a bare `julianday(started_at)` and one by raw bytes — including
  // the hook adapter, whose own comment pointed at `getMostRecentRunningTrace`
  // as the reason to parse rather than compare bytes. A miss there is worse
  // than a display bug: the hook WRITES, so a step lands on the wrong run.
  it('the hook adapter resolves a session to its newest trace by instant', () => {
    trace('old_ext', '2026-08-20T11:00:00Z', 'running');
    trace('new_basic', '2026-08-20T14:00:00+0200', 'running'); // 12:00Z — newer
    db.prepare("UPDATE agent_traces SET session_id = 'sess-mix'").run();

    applyHookPayload(db, {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-mix',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    const landed = db
      .prepare('SELECT DISTINCT trace_id FROM agent_trace_steps')
      .all() as { trace_id: string }[];
    expect(landed.map((r) => r.trace_id)).toEqual(['new_basic']);
  });

  it('a closing hook event resolves to the same trace the opening one did', () => {
    // `SESSION_TRACE_SQL` has no status filter, so a mis-ranked closing event
    // writes the tool RESULT onto an unrelated run and leaves the real step
    // open forever.
    trace('old_ext', '2026-08-20T11:00:00Z', 'running');
    trace('new_basic', '2026-08-20T14:00:00+0200', 'running');
    db.prepare("UPDATE agent_traces SET session_id = 'sess-mix'").run();

    applyHookPayload(db, {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-mix',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    applyHookPayload(db, {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-mix',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a b c' },
    });

    const rows = db
      .prepare('SELECT trace_id, output FROM agent_trace_steps')
      .all() as { trace_id: string; output: string | null }[];
    expect(new Set(rows.map((r) => r.trace_id))).toEqual(new Set(['new_basic']));
    // The result landed on the step it belongs to, rather than opening a second.
    expect(rows.some((r) => r.output != null)).toBe(true);
  });
});
