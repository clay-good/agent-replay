import type Database from 'better-sqlite3';
import { TRACE_STATUSES } from '../models/enums.js';
import { SINCE_PREDICATE, sinceParams, DURATION_MS_EXPR, julianDayExpr } from '../utils/time.js';

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
  /**
   * How many traces the average duration was actually computed over.
   *
   * `AVG` skips NULLs, and a duration is NULL whenever it cannot be measured —
   * a trace still `running`, a clock-skewed `ended_at`, a timestamp no format
   * parses. So the average could describe one trace out of a hundred while
   * `traces` reported a hundred, and nothing said so. This is the denominator,
   * reported alongside the number, which is what the rest of this tool does
   * everywhere else: never present a figure without saying what it measured.
   */
  avgDurationSample: number;
  totalTokens: number | null;
  /**
   * How many traces contributed to `totalTokens` — and, below, to `totalCost`.
   *
   * The same reasoning as `avgDurationSample`, for the two figures beside it.
   * Both are SUMs over whatever subset happens to record the value, and neither
   * said so: a store of 100 traces where 3 carry a cost reported "Total cost:
   * $0.19" as if it were the store's spend, directly under a "Traces: 100" and
   * directly *below* an average that does state its scope. A partial sum
   * presented as a total is the same defect the denominator above was added to
   * fix; these are its twins.
   */
  totalTokensSample: number;
  totalCost: number | null;
  totalCostSample: number;
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
  //
  // Forks are excluded from every total. A fork is a never-executed COPY of a
  // step prefix, tokens and all, so counting it reported spend that never
  // happened: one `fork` of a 2-step 3000-token trace doubled `steps` and
  // `totalTokens`. Every other fork-aware surface — golden export, `check`,
  // `watch`, the hook's open-trace lookup and the OTel merge — already filters
  // on lineage; the store roll-up was the one that did not.
  const notFork = 'parent_trace_id IS NULL';
  const traceWhere = since ? `WHERE ${notFork} AND ${SINCE_PREDICATE}` : `WHERE ${notFork}`;
  const traceAnd = since ? `AND ${notFork} AND ${SINCE_PREDICATE}` : `AND ${notFork}`;
  const childWhere = since
    ? `WHERE trace_id IN (SELECT id FROM agent_traces WHERE ${notFork} AND ${SINCE_PREDICATE})`
    : `WHERE trace_id IN (SELECT id FROM agent_traces WHERE ${notFork})`;
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
      `SELECT ROUND(AVG(${DURATION_MS_EXPR})) as v FROM agent_traces ${traceWhere}`,
      p,
    ),
    // COUNT of the same expression AVG used: COUNT(expr) counts non-NULLs, so
    // this is exactly the set the average was taken over.
    avgDurationSample:
      count(`SELECT COUNT(${DURATION_MS_EXPR}) as cnt FROM agent_traces ${traceWhere}`, p),
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
    // COUNT of the same expression the SUM used, exactly as the duration
    // denominator above does: COUNT skips NULLs, so this is the set summed.
    totalTokensSample: count(
      `SELECT COUNT(COALESCE(
         total_tokens,
         (SELECT SUM(s.tokens_used) FROM agent_trace_steps s WHERE s.trace_id = agent_traces.id)
       )) as cnt FROM agent_traces ${traceWhere}`,
      p,
    ),
    totalCost: scalar(`SELECT SUM(total_cost_usd) as v FROM agent_traces WHERE total_cost_usd IS NOT NULL ${traceAnd}`, p),
    totalCostSample: count(`SELECT COUNT(total_cost_usd) as cnt FROM agent_traces ${traceWhere}`, p),
  };
}

/** One entry per trace status (in TRACE_STATUSES order), for the bar chart. */
export function statusCounts(db: Database.Database, opts: StatsFilter = {}): { titles: string[]; data: number[] } {
  const since = opts.since;
  // Forks excluded, exactly as in dashboardStats above. This breakdown is
  // printed directly under that headline count, so counting a never-executed
  // copy here made the parts sum to more than the whole ("Traces: 5" over a
  // by_status summing to 6), and `stats --json | jq .by_status.running` alerted
  // on a `fork` — a debugging action, not a run.
  const stmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM agent_traces WHERE parent_trace_id IS NULL AND status = ?${since ? ` AND ${SINCE_PREDICATE}` : ''}`,
  );
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
  /**
   * Failed AND timed-out traces. Named for what it counts: as `failed` it
   * contradicted its own document — `stats --json` reported
   * `by_status: {failed: 0, timeout: 1}` next to `by_agent: [{failed: 1}]`, and
   * a CI job alerting on the per-agent number fired on timeouts. The human
   * output already says "failed or timed out".
   */
  failed_or_timeout: number;
}

/**
 * Per-agent trace counts (with a failed/timeout tally), most traces first.
 * Forks excluded, like every other aggregate here: each fork of an agent's
 * trace otherwise inflated that agent's count by one.
 * Powers the non-interactive `stats` command; a plain aggregation with no
 * terminal dependency, like the rest of this module.
 */
export function agentStats(db: Database.Database, opts: StatsFilter = {}): AgentStatRow[] {
  const since = opts.since;
  return db
    .prepare(
      `SELECT agent_name,
              COUNT(*) as count,
              SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) as failed_or_timeout
       FROM agent_traces
       WHERE parent_trace_id IS NULL${since ? ` AND ${SINCE_PREDICATE}` : ''}
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

/**
 * Most recent traces, newest first, for the trace table. Ordered by the parsed
 * instant (with the byte order as a fallback for an unparseable timestamp), the
 * same way `list` sorts — ordering the raw TEXT column ranked timestamps by
 * spelling, so a trace written as `2026-08-16 23:00:00` sorted below an older
 * `…T09:00:00Z` one and was the first thing the LIMIT dropped.
 */
export function recentTraces(db: Database.Database, limit = 30): DashboardTraceRow[] {
  return db
    .prepare(
      `SELECT id, agent_name, status, started_at FROM agent_traces
        ORDER BY ${julianDayExpr('started_at')} DESC, started_at DESC LIMIT ?`,
    )
    .all(limit) as DashboardTraceRow[];
}

export interface EvalPoint {
  score: number;
  evaluated_at: string;
}

/** Most recent eval scores, oldest first so the line chart reads left→right in time. */
export function recentEvalScores(db: Database.Database, limit = 20): EvalPoint[] {
  // Exclude an evaluator that was skipped as not applicable: it is stored with
  // score 1.0 so it can't fail a gate, but it measured nothing, and plotting it
  // put a fabricated 100% on the score trend.
  const rows = db
    .prepare(
      `SELECT score, evaluated_at FROM agent_trace_evals
        WHERE COALESCE(json_extract(details, '$.skipped'), 0) = 0
        ORDER BY evaluated_at DESC LIMIT ?`,
    )
    .all(limit) as EvalPoint[];
  rows.reverse();
  return rows;
}
