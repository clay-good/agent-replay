import type Database from 'better-sqlite3';
import { TRACE_STATUSES } from '../models/enums.js';
import { SINCE_PREDICATE, sinceParams } from '../utils/time.js';

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
  const p = since ? sinceParams(since) : [];
  // Trace-level: a leading WHERE or an appended AND, depending on whether the
  // query already has a WHERE. Steps/evals: window by the parent trace's start.
  const traceWhere = since ? `WHERE ${SINCE_PREDICATE}` : '';
  const traceAnd = since ? `AND ${SINCE_PREDICATE}` : '';
  const childWhere = since
    ? `WHERE trace_id IN (SELECT id FROM agent_traces WHERE ${SINCE_PREDICATE})`
    : '';
  const count = (sql: string, params: unknown[] = []) => (db.prepare(sql).get(...params) as { cnt: number }).cnt;
  const scalar = (sql: string, params: unknown[] = []) => (db.prepare(sql).get(...params) as { v: number | null }).v;
  return {
    traces: count(`SELECT COUNT(*) as cnt FROM agent_traces ${traceWhere}`, p),
    steps: count(`SELECT COUNT(*) as cnt FROM agent_trace_steps ${childWhere}`, p),
    evals: count(`SELECT COUNT(*) as cnt FROM agent_trace_evals ${childWhere}`, p),
    // Active policies are current config, not historical events — never windowed.
    policies: count('SELECT COUNT(*) as cnt FROM guardrail_policies WHERE enabled = 1'),
    // Mirror effectiveDurationMs (utils/time.ts) in SQL: fall back to
    // ended_at - started_at when the explicit total wasn't recorded. Averaging
    // total_duration_ms alone disagreed with what `list` and `show` display,
    // because the hook finalizer sets only ended_at — so on a store built the
    // normal way (`hook` / `record`) every trace showed a duration in `list`
    // while `stats` reported "Avg duration: -". AVG already skips NULLs, so the
    // CASE yielding NULL for an unusable pair excludes that trace, as before.
    avgDurationMs: scalar(
      `SELECT ROUND(AVG(COALESCE(
         total_duration_ms,
         CASE WHEN ended_at IS NOT NULL AND julianday(ended_at) >= julianday(started_at)
              THEN (julianday(ended_at) - julianday(started_at)) * 86400000.0 END
       ))) as v FROM agent_traces ${traceWhere}`,
      p,
    ),
    // Same fallback the average duration above needs, for the same reason: the
    // trace-level total is only set when the producer sends one (`trace_end`
    // totals, or an ingested `total_tokens`), while `ingest`, `record`, the OTel
    // mapper and the importers all populate per-step `tokens_used`. Summing the
    // column alone reported "Total tokens: -" — and `null` in the --json a CI
    // job reads — for a store plainly holding tokens.
    totalTokens: scalar(
      `SELECT SUM(COALESCE(
         total_tokens,
         (SELECT SUM(s.tokens_used) FROM agent_trace_steps s WHERE s.trace_id = agent_traces.id)
       )) as v FROM agent_traces ${traceWhere}`,
      p,
    ),
    totalCost: scalar(`SELECT SUM(total_cost_usd) as v FROM agent_traces WHERE total_cost_usd IS NOT NULL ${traceAnd}`, p),
  };
}

/** One entry per trace status (in TRACE_STATUSES order), for the bar chart. */
export function statusCounts(db: Database.Database, opts: StatsFilter = {}): { titles: string[]; data: number[] } {
  const since = opts.since;
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM agent_traces WHERE status = ?${since ? ` AND ${SINCE_PREDICATE}` : ''}`);
  const titles: string[] = [];
  const data: number[] = [];
  for (const status of TRACE_STATUSES) {
    titles.push(status);
    const params = since ? [status, ...sinceParams(since)] : [status];
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
       ${since ? `WHERE ${SINCE_PREDICATE}` : ''}
       GROUP BY agent_name
       ORDER BY count DESC, agent_name ASC`,
    )
    .all(...(since ? sinceParams(since) : [])) as AgentStatRow[];
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
