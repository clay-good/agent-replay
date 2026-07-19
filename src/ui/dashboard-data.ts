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

export function dashboardStats(db: Database.Database): DashboardStats {
  const count = (sql: string) => (db.prepare(sql).get() as { cnt: number }).cnt;
  const scalar = (sql: string) => (db.prepare(sql).get() as { v: number | null }).v;
  return {
    traces: count('SELECT COUNT(*) as cnt FROM agent_traces'),
    steps: count('SELECT COUNT(*) as cnt FROM agent_trace_steps'),
    evals: count('SELECT COUNT(*) as cnt FROM agent_trace_evals'),
    policies: count('SELECT COUNT(*) as cnt FROM guardrail_policies WHERE enabled = 1'),
    avgDurationMs: scalar('SELECT AVG(total_duration_ms) as v FROM agent_traces WHERE total_duration_ms IS NOT NULL'),
    totalTokens: scalar('SELECT SUM(total_tokens) as v FROM agent_traces WHERE total_tokens IS NOT NULL'),
    totalCost: scalar('SELECT SUM(total_cost_usd) as v FROM agent_traces WHERE total_cost_usd IS NOT NULL'),
  };
}

/** One entry per trace status (in TRACE_STATUSES order), for the bar chart. */
export function statusCounts(db: Database.Database): { titles: string[]; data: number[] } {
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM agent_traces WHERE status = ?');
  const titles: string[] = [];
  const data: number[] = [];
  for (const status of TRACE_STATUSES) {
    titles.push(status);
    data.push((stmt.get(status) as { cnt: number } | undefined)?.cnt ?? 0);
  }
  return { titles, data };
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
