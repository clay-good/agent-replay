import type Database from 'better-sqlite3';

/**
 * Full SQLite schema for agent-replay.
 *
 * Adapted from proxilion-managed-main/migrations/011_agent_traces.sql with:
 *   - UUID → TEXT (IDs generated in application code via nanoid)
 *   - JSONB → TEXT (store JSON strings)
 *   - TIMESTAMPTZ → TEXT (ISO 8601 strings)
 *   - TEXT[] → TEXT (JSON array strings)
 *   - Removed org_id, tenant_id (no multi-tenancy for standalone CLI)
 *   - Removed RLS policies
 *   - Added parent_trace_id + forked_from_step to agent_traces for fork tracking
 *   - Added guardrail_policies table (adapted from 002_policies.sql policy_rules)
 */

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
-- ============================================================================
-- Schema version tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- Agent traces — top-level container for one agent execution
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_traces (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    agent_version TEXT,
    trigger TEXT NOT NULL DEFAULT 'manual'
        CHECK (trigger IN ('manual', 'user_message', 'cron', 'webhook', 'api', 'event')),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed', 'timeout')),
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    total_duration_ms INTEGER,
    total_tokens INTEGER,
    total_cost_usd REAL,
    error TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    parent_trace_id TEXT REFERENCES agent_traces(id) ON DELETE SET NULL,
    forked_from_step INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_status ON agent_traces(status);
CREATE INDEX IF NOT EXISTS idx_agent_traces_agent_name ON agent_traces(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_traces_started_at ON agent_traces(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_traces_parent ON agent_traces(parent_trace_id);

-- ============================================================================
-- Agent trace steps — individual actions within a trace
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_trace_steps (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    step_type TEXT NOT NULL
        CHECK (step_type IN ('thought', 'tool_call', 'llm_call', 'retrieval', 'output', 'decision', 'error', 'guard_check')),
    name TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    output TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    duration_ms INTEGER,
    tokens_used INTEGER,
    model TEXT,
    error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    UNIQUE(trace_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_steps_trace ON agent_trace_steps(trace_id, step_number);
CREATE INDEX IF NOT EXISTS idx_agent_trace_steps_type ON agent_trace_steps(trace_id, step_type);

-- ============================================================================
-- Agent trace snapshots — frozen state at a specific step
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_trace_snapshots (
    id TEXT PRIMARY KEY,
    step_id TEXT NOT NULL REFERENCES agent_trace_steps(id) ON DELETE CASCADE,
    context_window TEXT NOT NULL DEFAULT '[]',
    environment TEXT NOT NULL DEFAULT '{}',
    tool_state TEXT NOT NULL DEFAULT '{}',
    token_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_snapshots_step ON agent_trace_snapshots(step_id);

-- ============================================================================
-- Agent trace evals — evaluation results for traces
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_trace_evals (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
    evaluator_type TEXT NOT NULL
        CHECK (evaluator_type IN ('rubric', 'llm_judge', 'policy_check')),
    evaluator_name TEXT NOT NULL,
    score REAL NOT NULL,
    passed INTEGER NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_trace_evals_trace ON agent_trace_evals(trace_id);

-- ============================================================================
-- Guardrail policies — kill-switch rules
-- Adapted from proxilion-managed-main/migrations/002_policies.sql policy_rules
-- ============================================================================
CREATE TABLE IF NOT EXISTS guardrail_policies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    action TEXT NOT NULL
        CHECK (action IN ('allow', 'deny', 'warn', 'require_review')),
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    match_pattern TEXT NOT NULL DEFAULT '{}',
    action_params TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guardrail_policies_action ON guardrail_policies(action);
CREATE INDEX IF NOT EXISTS idx_guardrail_policies_enabled ON guardrail_policies(enabled);
`;

/** Apply schema v1 to the database. */
export function applySchemaV1(db: Database.Database): void {
  db.exec(SCHEMA_V1);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
}

/** Get the current schema version, or 0 if no schema exists. */
export function getSchemaVersion(db: Database.Database): number {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();

  if (!tableExists) return 0;

  const row = db
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null } | undefined;

  return row?.version ?? 0;
}
