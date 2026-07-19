import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, createEval } from '../src/services/trace-service.js';
import { addPolicy } from '../src/services/guard-service.js';
import { dashboardStats, statusCounts, recentTraces, recentEvalScores } from '../src/ui/dashboard-data.js';
import type { IngestTraceInput } from '../src/models/types.js';

/**
 * The dashboard TUI can't be exercised headlessly, but its data layer can:
 * these lock the numbers the dashboard renders (aggregate stats, per-status
 * counts, recent traces, recent eval scores).
 */

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

const trace = (over: Partial<IngestTraceInput>): IngestTraceInput => ({
  agent_name: 'bot',
  status: 'completed',
  steps: [{ step_number: 1, step_type: 'output', name: 'out' }],
  ...over,
});

describe('dashboardStats', () => {
  it('aggregates counts, average duration, and token/cost totals', () => {
    ingestTrace(db, trace({ status: 'completed', total_duration_ms: 1000, total_tokens: 100, total_cost_usd: 0.01 }));
    ingestTrace(db, trace({
      status: 'failed',
      total_duration_ms: 3000,
      total_tokens: 300,
      total_cost_usd: 0.03,
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 't' },
        { step_number: 2, step_type: 'output', name: 'o' },
      ],
    }));
    // A trace with no duration/tokens/cost must not skew the averages/sums.
    ingestTrace(db, trace({ status: 'running' }));
    addPolicy(db, { name: 'p', action: 'deny', match_pattern: { name_contains: 'x' } });

    const s = dashboardStats(db);
    expect(s.traces).toBe(3);
    expect(s.steps).toBe(4); // 1 + 2 + 1
    expect(s.policies).toBe(1);
    expect(s.avgDurationMs).toBe(2000); // (1000 + 3000) / 2, the null one excluded
    expect(s.totalTokens).toBe(400);
    expect(s.totalCost).toBeCloseTo(0.04, 6);
  });

  it('returns null totals when there is nothing to aggregate', () => {
    const s = dashboardStats(db);
    expect(s).toMatchObject({ traces: 0, steps: 0, evals: 0, policies: 0, avgDurationMs: null, totalTokens: null, totalCost: null });
  });

  it('counts only enabled policies', () => {
    addPolicy(db, { name: 'on', action: 'deny', match_pattern: { name_contains: 'x' } });
    const off = addPolicy(db, { name: 'off', action: 'deny', match_pattern: { name_contains: 'y' } });
    db.prepare('UPDATE guardrail_policies SET enabled = 0 WHERE id = ?').run(off.id);
    expect(dashboardStats(db).policies).toBe(1);
  });
});

describe('statusCounts', () => {
  it('reports one entry per status in a stable order', () => {
    ingestTrace(db, trace({ status: 'completed' }));
    ingestTrace(db, trace({ status: 'completed' }));
    ingestTrace(db, trace({ status: 'failed' }));

    const { titles, data } = statusCounts(db);
    expect(titles).toContain('completed');
    expect(titles).toContain('failed');
    expect(titles.length).toBe(data.length);
    const byStatus = Object.fromEntries(titles.map((t, i) => [t, data[i]]));
    expect(byStatus.completed).toBe(2);
    expect(byStatus.failed).toBe(1);
    expect(byStatus.timeout).toBe(0); // absent statuses still get a zero bar
  });
});

describe('recentTraces', () => {
  it('returns newest first and respects the limit', () => {
    ingestTrace(db, trace({ agent_name: 'old', started_at: '2026-07-01T00:00:00Z' }));
    ingestTrace(db, trace({ agent_name: 'new', started_at: '2026-07-10T00:00:00Z' }));
    const rows = recentTraces(db, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBe('new');
  });
});

describe('recentEvalScores', () => {
  it('returns oldest-first points and respects the limit', () => {
    const t = ingestTrace(db, trace({}));
    for (let i = 0; i < 25; i++) {
      createEval(db, t.id, { evaluator_type: 'rubric', evaluator_name: `e${i}`, score: i / 100, passed: true });
    }
    const pts = recentEvalScores(db, 20);
    expect(pts).toHaveLength(20); // limited to the 20 most recent
    expect(dashboardStats(db).evals).toBe(25); // but all are counted in stats
    // oldest-first: within the most-recent-20 window, evaluated_at is ascending.
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].evaluated_at >= pts[i - 1].evaluated_at).toBe(true);
    }
  });
});
