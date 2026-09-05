import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applySchemaV1, getSchemaVersion, SCHEMA_VERSION } from '../src/db/schema.js';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace, listTraces, ingestTrace } from '../src/services/trace-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import type { GoldenEntry } from '../src/services/export-service.js';

/**
 * A store written by an older build still works after it upgrades.
 *
 * The migration tests here check the SCHEMA — that the version bumps, the
 * indexes appear, and re-running a step is a no-op. None checked the DATA,
 * which is what the README actually promises: "every existing row is preserved
 * with the new fields defaulting to null". Upgrades are one-way and run
 * automatically the first time a new build opens an old store, so a mistake
 * here is silent and unrecoverable — the worst shape a bug can have in a tool
 * whose whole job is not losing the record of what happened.
 *
 * This writes real v1 rows through v1's own columns, upgrades, and then reads
 * them back the way every command does.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-upgrade-'));
});

afterEach(() => {
  resetConnection();
  rmSync(dir, { recursive: true, force: true });
});

/** A v1-era store holding one completed trace with three steps. */
function v1Store(path: string): void {
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    applySchemaV1(db);
    expect(getSchemaVersion(db)).toBe(1);

    db.prepare(
      `INSERT INTO agent_traces
         (id, agent_name, agent_version, trigger, status, input, output, started_at, ended_at,
          total_duration_ms, total_tokens, total_cost_usd, error, tags, metadata, created_at)
       VALUES ('trc_v1', 'legacy-bot', '0.9', 'api', 'completed', ?, ?, '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:05.000Z', 5000, 900, 0.25, NULL, ?, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(
      JSON.stringify({ task: 'the original question' }),
      JSON.stringify({ result: 'the original answer' }),
      JSON.stringify(['production', 'v1']),
      JSON.stringify({ source: 'ancient' }),
    );

    const step = db.prepare(
      `INSERT INTO agent_trace_steps
         (id, trace_id, step_number, step_type, name, input, output, started_at, ended_at,
          duration_ms, tokens_used, model, error, metadata)
       VALUES (?, 'trc_v1', ?, ?, ?, ?, ?, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z',
               1000, ?, ?, ?, '{}')`,
    );
    step.run('stp_1', 1, 'tool_call', 'search', JSON.stringify({ q: 'x' }), JSON.stringify({ hits: 3 }), 100, null, null);
    step.run('stp_2', 2, 'llm_call', 'answer', '{}', JSON.stringify({ text: 'because' }), 700, 'gpt-x', null);
    step.run('stp_3', 3, 'output', 'done', '{}', JSON.stringify({ result: 'the original answer' }), 100, null, 'it broke');
  } finally {
    db.close();
  }
}

describe('a store written by an older build survives the upgrade', () => {
  it('preserves every row, with the newer columns defaulting to null', () => {
    const path = resolve(dir, 'traces.db');
    v1Store(path);

    // What every command does on open.
    const db = ensureDatabase(path);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const trace = getTrace(db, 'trc_v1')!;
    expect(trace).toBeTruthy();
    // Trace-level data, untouched.
    expect(trace.agent_name).toBe('legacy-bot');
    expect(trace.agent_version).toBe('0.9');
    expect(trace.status).toBe('completed');
    expect(trace.input).toEqual({ task: 'the original question' });
    expect(trace.output).toEqual({ result: 'the original answer' });
    expect(trace.total_duration_ms).toBe(5000);
    expect(trace.total_tokens).toBe(900);
    expect(trace.total_cost_usd).toBe(0.25);
    expect(trace.tags).toEqual(['production', 'v1']);
    expect(trace.metadata).toEqual({ source: 'ancient' });

    // Columns that did not exist in v1 read as null, not as garbage.
    expect(trace.session_id).toBeNull();
    expect(trace.parent_trace_id).toBeNull();

    // Steps, in order, with their payloads.
    expect(trace.steps.map((s) => s.name)).toEqual(['search', 'answer', 'done']);
    expect(trace.steps[0].input).toEqual({ q: 'x' });
    expect(trace.steps[1].model).toBe('gpt-x');
    expect(trace.steps[2].error).toBe('it broke');
    // v2 added the decision model and the causal columns.
    expect(trace.steps[0].parent_step_number).toBeNull();
    expect(trace.steps[0].caused_by_step_number).toBeNull();
    // `decision` is declared optional — "present only for decision steps that
    // carry a record" — so it is absent rather than null here.
    expect(trace.steps[0].decision).toBeUndefined();
  });

  it('still lists, exports and re-ingests what the old build recorded', () => {
    const path = resolve(dir, 'traces.db');
    v1Store(path);
    const db = ensureDatabase(path);

    const { items, total } = listTraces(db, {});
    expect(total).toBe(1);
    expect(items[0].agent_name).toBe('legacy-bot');

    // The round trip the golden gate depends on: a trace recorded by an old
    // build must still export and re-ingest cleanly after the upgrade.
    const exported = JSON.parse(exportTraces(db, {}, 'json')) as Parameters<typeof ingestTrace>[1][];
    expect(exported).toHaveLength(1);

    const fresh = new Database(':memory:');
    try {
      fresh.pragma('foreign_keys = ON');
      runMigrations(fresh);
      const back = getTrace(fresh, ingestTrace(fresh, exported[0]).id)!;
      expect(back.steps).toHaveLength(3);
      expect(back.input).toEqual({ task: 'the original question' });
    } finally {
      fresh.close();
    }

    // ...and it can still serve as a golden baseline.
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(1);
    expect(golden[0].agent_name).toBe('legacy-bot');
    expect(golden[0].steps_summary.map((s) => s.name)).toEqual(['search', 'answer', 'done']);
    // The failure flag the gate reads is derived from the old rows correctly.
    expect(golden[0].steps_summary.map((s) => s.failed)).toEqual([false, false, true]);
  });

  it('is idempotent — opening an already-current store changes nothing', () => {
    const path = resolve(dir, 'traces.db');
    v1Store(path);
    const first = ensureDatabase(path);
    const afterFirst = getSchemaVersion(first);
    resetConnection();

    const second = ensureDatabase(path);
    expect(getSchemaVersion(second)).toBe(afterFirst);
    expect(getTrace(second, 'trc_v1')!.steps).toHaveLength(3);
  });
});
