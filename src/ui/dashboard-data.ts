import type Database from 'better-sqlite3';
import { TRACE_STATUSES } from '../models/enums.js';

/**
 * Pure data queries behind the dashboard TUI. Kept separate from the blessed
 * rendering in dashboard-view.ts so the aggregation — the numbers users actually
 * read — is unit-testable without a terminal.
 */

export interface DashboardStats {
  traces: number;
  steps: number;
  evals: number;
  policies: number;
  avgDurationMs: number | null;
  totalTokens: number | null;
  totalCost: number | null;
}

/**
 * Optional aggregation filter. `since` is an ISO cutoff (from `parseSinceToIso`)
 * that windows every count to traces started at or after it — steps and evals by
 * their parent trace's start time, so a `--since` view is internally consistent.
 * The dashboard passes nothing and gets store-wide numbers, unchanged.
 */
export interface StatsFilter {
  since?: string;
}

export function dashboardStats(db: Database.Database, opts: StatsFilter = {}): DashboardStats {
  const since = opts.since;
  const p = since ? [since] : [];
  // Trace-level: a leading WHERE or an appended AND, depending on whether the
  // query already has a WHERE. Steps/evals: window by the parent trace's start.
  const traceWhere = since ? 'WHERE started_at >= ?' : '';
  const traceAnd = since ? 'AND started_at >= ?' : '';
  const childWhere = since ? 'WHERE trace_id IN (SELECT id FROM agent_traces WHERE started_at >= ?)' : '';
  const count = (sql: string, params: unknown[] = []) => (db.prepare(sql).get(...params) as { cnt: number }).cnt;
  const scalar = (sql: string, params: unknown[] = []) => (db.prepare(sql).get(...params) as { v: number | null }).v;
  return {
    traces: count(`SELECT COUNT(*) as cnt FROM agent_traces ${traceWhere}`, p),
    steps: count(`SELECT COUNT(*) as cnt FROM agent_trace_steps ${childWhere}`, p),
    evals: count(`SELECT COUNT(*) as cnt FROM agent_trace_evals ${childWhere}`, p),
    // Active policies are current config, not historical events — never windowed.
    policies: count('SELECT COUNT(*) as cnt FROM guardrail_policies WHERE enabled = 1'),
    avgDurationMs: scalar(`SELECT AVG(total_duration_ms) as v FROM agent_traces WHERE total_duration_ms IS NOT NULL ${traceAnd}`, p),
    totalTokens: scalar(`SELECT SUM(total_tokens) as v FROM agent_traces WHERE total_tokens IS NOT NULL ${traceAnd}`, p),
    totalCost: scalar(`SELECT SUM(total_cost_usd) as v FROM agent_traces WHERE total_cost_usd IS NOT NULL ${traceAnd}`, p),
  };
}

/** One entry per trace status (in TRACE_STATUSES order), for the bar chart. */
export function statusCounts(db: Database.Database, opts: StatsFilter = {}): { titles: string[]; data: number[] } {
  const since = opts.since;
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM agent_traces WHERE status = ?${since ? ' AND started_at >= ?' : ''}`);
  const titles: string[] = [];
  const data: number[] = [];
  for (const status of TRACE_STATUSES) {
    titles.push(status);
    const params = since ? [status, since] : [status];
    data.push((stmt.get(...params) as { cnt: number } | undefined)?.cnt ?? 0);
  }
  return { titles, data };
}

export interface AgentStatRow {
  agent_name: string;
  count: number;
  failed: number;
}

/**
 * Per-agent trace counts (with a failed/timeout tally), most traces first.
 * Powers the non-interactive `stats` command; a plain aggregation with no
 * terminal dependency, like the rest of this module.
 */
export function agentStats(db: Database.Database, opts: StatsFilter = {}): AgentStatRow[] {
  const since = opts.since;
  return db
    .prepare(
      `SELECT agent_name,
              COUNT(*) as count,
              SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) as failed
       FROM agent_traces
       ${since ? 'WHERE started_at >= ?' : ''}
       GROUP BY agent_name
       ORDER BY count DESC, agent_name ASC`,
    )
    .all(...(since ? [since] : [])) as AgentStatRow[];
}

export interface DashboardTraceRow {
  id: string;
  agent_name: string;
  status: string;
  started_at: string;
}

/** Most recent traces, newest first, for the trace table. */
export function recentTraces(db: Database.Database, limit = 30): DashboardTraceRow[] {
  return db
    .prepare('SELECT id, agent_name, status, started_at FROM agent_traces ORDER BY started_at DESC LIMIT ?')
    .all(limit) as DashboardTraceRow[];
}

export interface EvalPoint {
  score: number;
  evaluated_at: string;
}

/** Most recent eval scores, oldest first so the line chart reads left→right in time. */
export function recentEvalScores(db: Database.Database, limit = 20): EvalPoint[] {
  const rows = db
    .prepare('SELECT score, evaluated_at FROM agent_trace_evals ORDER BY evaluated_at DESC LIMIT ?')
    .all(limit) as EvalPoint[];
  rows.reverse();
  return rows;
}
