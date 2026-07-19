import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type {
  Trace,
  TraceStep,
  TraceSnapshot,
  EvalResult,
  TraceWithDetails,
  IngestTraceInput,
  IngestStepInput,
  IngestSnapshotInput,
  IngestDecisionInput,
  DecisionRecord,
  DecisionOption,
  UpdateTraceInput,
  CreateEvalInput,
  ListTracesFilter,
} from '../models/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

function now(): string {
  return new Date().toISOString();
}

function jsonStr(val: unknown): string {
  if (val === undefined || val === null) return '{}';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

function jsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

/** Parse a JSON TEXT column back into an object. */
function parseJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Map a raw SQLite row into a Trace object. */
function rowToTrace(row: Record<string, unknown>): Trace {
  return {
    id: row.id as string,
    agent_name: row.agent_name as string,
    agent_version: (row.agent_version as string) ?? null,
    trigger: row.trigger as Trace['trigger'],
    status: row.status as Trace['status'],
    input: parseJson(row.input as string) ?? {},
    output: parseJson(row.output as string | null),
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    total_duration_ms: (row.total_duration_ms as number) ?? null,
    total_tokens: (row.total_tokens as number) ?? null,
    total_cost_usd: (row.total_cost_usd as number) ?? null,
    error: (row.error as string) ?? null,
    tags: parseJsonArray(row.tags as string),
    metadata: parseJson(row.metadata as string) ?? {},
    parent_trace_id: (row.parent_trace_id as string) ?? null,
    forked_from_step: (row.forked_from_step as number) ?? null,
    session_id: (row.session_id as string) ?? null,
    created_at: row.created_at as string,
  };
}

export function rowToStep(row: Record<string, unknown>): TraceStep {
  return {
    id: row.id as string,
    trace_id: row.trace_id as string,
    step_number: row.step_number as number,
    step_type: row.step_type as TraceStep['step_type'],
    name: row.name as string,
    input: parseJson(row.input as string) ?? {},
    output: parseJson(row.output as string | null),
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    tokens_used: (row.tokens_used as number) ?? null,
    model: (row.model as string) ?? null,
    error: (row.error as string) ?? null,
    metadata: parseJson(row.metadata as string) ?? {},
    parent_step_number: (row.parent_step_number as number) ?? null,
    caused_by_step_number: (row.caused_by_step_number as number) ?? null,
  };
}

export function rowToDecision(row: Record<string, unknown>): DecisionRecord {
  const rawOptions = parseJson(row.options as string | null);
  const options = Array.isArray(rawOptions) ? (rawOptions as DecisionOption[]) : [];
  return {
    id: row.id as string,
    step_id: row.step_id as string,
    options,
    chosen: row.chosen as string,
    rationale: (row.rationale as string) ?? null,
    confidence: (row.confidence as number) ?? null,
    decided_by: (row.decided_by as DecisionRecord['decided_by']) ?? 'agent',
  };
}

/** Insert a decision record for a step. Assumes the step is type `decision`. */
function insertDecision(
  db: Database.Database,
  stepId: string,
  decision: IngestDecisionInput,
): void {
  db.prepare(
    `INSERT INTO agent_trace_decisions
      (id, step_id, options, chosen, rationale, confidence, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    generateId('dec'),
    stepId,
    JSON.stringify(decision.options ?? []),
    decision.chosen,
    decision.rationale ?? null,
    decision.confidence ?? null,
    decision.decided_by ?? 'agent',
  );
}

function rowToEval(row: Record<string, unknown>): EvalResult {
  return {
    id: row.id as string,
    trace_id: row.trace_id as string,
    evaluator_type: row.evaluator_type as EvalResult['evaluator_type'],
    evaluator_name: row.evaluator_name as string,
    score: row.score as number,
    passed: !!(row.passed as number),
    details: parseJson(row.details as string) ?? {},
    evaluated_at: row.evaluated_at as string,
  };
}

function rowToSnapshot(row: Record<string, unknown>): TraceSnapshot {
  return {
    id: row.id as string,
    step_id: row.step_id as string,
    context_window: row.context_window ? JSON.parse(row.context_window as string) : null,
    environment: parseJson(row.environment as string) ?? {},
    tool_state: parseJson(row.tool_state as string) ?? {},
    token_count: row.token_count as number,
  };
}

// ── 1. ingestTrace ────────────────────────────────────────────────────────

/** Insert the trace row (no steps). Shared by ingestTrace and startTrace. */
function insertTraceRow(
  db: Database.Database,
  traceId: string,
  input: IngestTraceInput,
  status: string,
  timestamp: string,
): void {
  db.prepare(
    `INSERT INTO agent_traces
      (id, agent_name, agent_version, trigger, status, input, output,
       started_at, ended_at, total_duration_ms, total_tokens, total_cost_usd,
       error, tags, metadata, parent_trace_id, forked_from_step, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    traceId,
    input.agent_name,
    input.agent_version ?? null,
    input.trigger ?? 'manual',
    status,
    jsonStr(input.input),
    jsonOrNull(input.output),
    input.started_at ?? timestamp,
    input.ended_at ?? null,
    input.total_duration_ms ?? null,
    input.total_tokens ?? null,
    input.total_cost_usd ?? null,
    input.error ?? null,
    JSON.stringify(input.tags ?? []),
    jsonStr(input.metadata),
    null, // parent_trace_id
    null, // forked_from_step
    input.session_id ?? null,
    timestamp,
  );
}

export function ingestTrace(
  db: Database.Database,
  input: IngestTraceInput,
): Trace {
  const traceId = generateId('trc');
  const timestamp = now();

  const status =
    input.status ??
    (input.ended_at ? 'completed' : 'running');

  const ingest = db.transaction(() => {
    insertTraceRow(db, traceId, input, status, timestamp);

    // Insert steps and snapshots
    for (const step of input.steps ?? []) {
      const stepId = generateId('stp');
      db.prepare(
        `INSERT INTO agent_trace_steps
          (id, trace_id, step_number, step_type, name, input, output,
           started_at, ended_at, duration_ms, tokens_used, model, error, metadata,
           parent_step_number, caused_by_step_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stepId,
        traceId,
        step.step_number,
        step.step_type,
        step.name,
        jsonStr(step.input),
        jsonOrNull(step.output),
        step.started_at ?? timestamp,
        step.ended_at ?? null,
        step.duration_ms ?? null,
        step.tokens_used ?? null,
        step.model ?? null,
        step.error ?? null,
        jsonStr(step.metadata),
        step.parent_step ?? null,
        step.caused_by_step ?? null,
      );

      if (step.decision) {
        insertDecision(db, stepId, step.decision);
      }

      if (step.snapshot) {
        const snapId = generateId('snp');
        db.prepare(
          `INSERT INTO agent_trace_snapshots
            (id, step_id, context_window, environment, tool_state, token_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          snapId,
          stepId,
          jsonStr(step.snapshot.context_window),
          jsonStr(step.snapshot.environment),
          jsonStr(step.snapshot.tool_state),
          step.snapshot.token_count ?? 0,
        );
      }
    }

    return db
      .prepare('SELECT * FROM agent_traces WHERE id = ?')
      .get(traceId) as Record<string, unknown>;
  });

  return rowToTrace(ingest());
}

/**
 * Open a new trace with no steps, defaulting to status `running`. Used by the
 * live recorder for `trace_start` events; honors a client-supplied `id` so the
 * producer can stamp the same `trace_id` on every subsequent event.
 */
export function startTrace(
  db: Database.Database,
  input: IngestTraceInput,
  opts: { id?: string } = {},
): Trace {
  const traceId = opts.id ?? generateId('trc');
  const timestamp = now();
  const status = input.status ?? (input.ended_at ? 'completed' : 'running');
  insertTraceRow(db, traceId, input, status, timestamp);
  const row = db
    .prepare('SELECT * FROM agent_traces WHERE id = ?')
    .get(traceId) as Record<string, unknown>;
  return rowToTrace(row);
}

// ── 2. appendStep ─────────────────────────────────────────────────────────

export function appendStep(
  db: Database.Database,
  traceId: string,
  input: IngestStepInput,
): TraceStep {
  // Verify trace exists and is running
  const trace = db
    .prepare('SELECT id, status FROM agent_traces WHERE id = ?')
    .get(traceId) as { id: string; status: string } | undefined;

  if (!trace) {
    throw new Error(`Trace ${traceId} not found`);
  }
  if (trace.status !== 'running') {
    throw new Error(
      `Cannot append steps to a trace with status '${trace.status}'`,
    );
  }

  const stepId = generateId('stp');
  const timestamp = now();

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_trace_steps
        (id, trace_id, step_number, step_type, name, input, output,
         started_at, ended_at, duration_ms, tokens_used, model, error, metadata,
         parent_step_number, caused_by_step_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      stepId,
      traceId,
      input.step_number,
      input.step_type,
      input.name,
      jsonStr(input.input),
      jsonOrNull(input.output),
      input.started_at ?? timestamp,
      input.ended_at ?? null,
      input.duration_ms ?? null,
      input.tokens_used ?? null,
      input.model ?? null,
      input.error ?? null,
      jsonStr(input.metadata),
      input.parent_step ?? null,
      input.caused_by_step ?? null,
    );

    if (input.decision) {
      insertDecision(db, stepId, input.decision);
    }

    if (input.snapshot) {
      const snapId = generateId('snp');
      db.prepare(
        `INSERT INTO agent_trace_snapshots
          (id, step_id, context_window, environment, tool_state, token_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        snapId,
        stepId,
        jsonStr(input.snapshot.context_window),
        jsonStr(input.snapshot.environment),
        jsonStr(input.snapshot.tool_state),
        input.snapshot.token_count ?? 0,
      );
    }

    return db
      .prepare('SELECT * FROM agent_trace_steps WHERE id = ?')
      .get(stepId) as Record<string, unknown>;
  });

  return rowToStep(insert());
}

// ── 2b. updateStep / attachDecision / attachSnapshot (live capture) ────────

export interface UpdateStepInput {
  output?: Record<string, unknown> | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  tokens_used?: number | null;
  model?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Patch an already-open step, matched by (trace_id, step_number). Used by the
 * recorder to close a step opened by a `step_start` event.
 */
export function updateStep(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
  patch: UpdateStepInput,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.output !== undefined) {
    sets.push('output = ?');
    params.push(jsonOrNull(patch.output));
  }
  if (patch.ended_at !== undefined) {
    sets.push('ended_at = ?');
    params.push(patch.ended_at);
  }
  if (patch.duration_ms !== undefined) {
    sets.push('duration_ms = ?');
    params.push(patch.duration_ms);
  }
  if (patch.tokens_used !== undefined) {
    sets.push('tokens_used = ?');
    params.push(patch.tokens_used);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  if (patch.metadata !== undefined) {
    sets.push('metadata = ?');
    params.push(jsonStr(patch.metadata));
  }

  if (sets.length === 0) return;

  params.push(traceId, stepNumber);
  const result = db
    .prepare(`UPDATE agent_trace_steps SET ${sets.join(', ')} WHERE trace_id = ? AND step_number = ?`)
    .run(...params);
  if (result.changes === 0) {
    throw new Error(`Step ${stepNumber} not found in trace ${traceId}`);
  }
}

/** Look up a step's row id within a trace, by step number. */
function resolveStepId(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
): string {
  const row = db
    .prepare('SELECT id FROM agent_trace_steps WHERE trace_id = ? AND step_number = ?')
    .get(traceId, stepNumber) as { id: string } | undefined;
  if (!row) throw new Error(`Step ${stepNumber} not found in trace ${traceId}`);
  return row.id;
}

/** Attach (or replace) a decision record on an existing step. */
export function attachDecision(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
  decision: IngestDecisionInput,
): void {
  const stepId = resolveStepId(db, traceId, stepNumber);
  db.prepare('DELETE FROM agent_trace_decisions WHERE step_id = ?').run(stepId);
  insertDecision(db, stepId, decision);
}

/** Attach (or replace) a snapshot on an existing step. */
export function attachSnapshot(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
  snapshot: IngestSnapshotInput,
): void {
  const stepId = resolveStepId(db, traceId, stepNumber);
  db.prepare('DELETE FROM agent_trace_snapshots WHERE step_id = ?').run(stepId);
  db.prepare(
    `INSERT INTO agent_trace_snapshots
      (id, step_id, context_window, environment, tool_state, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    generateId('snp'),
    stepId,
    jsonStr(snapshot.context_window),
    jsonStr(snapshot.environment),
    jsonStr(snapshot.tool_state),
    snapshot.token_count ?? 0,
  );
}

// ── 3. getTrace ───────────────────────────────────────────────────────────

export function getTrace(
  db: Database.Database,
  traceId: string,
): TraceWithDetails | null {
  // Support prefix-matching
  const traceRow = db
    .prepare('SELECT * FROM agent_traces WHERE id = ? OR id LIKE ? LIMIT 1')
    .get(traceId, `${traceId}%`) as Record<string, unknown> | undefined;

  if (!traceRow) return null;

  const resolvedId = traceRow.id as string;

  const stepRows = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number',
    )
    .all(resolvedId) as Record<string, unknown>[];

  const evalRows = db
    .prepare(
      'SELECT * FROM agent_trace_evals WHERE trace_id = ? ORDER BY evaluated_at DESC',
    )
    .all(resolvedId) as Record<string, unknown>[];

  // Decision records for this trace's steps, keyed by step_id
  const decisionRows = db
    .prepare(
      `SELECT d.* FROM agent_trace_decisions d
       JOIN agent_trace_steps s ON d.step_id = s.id
       WHERE s.trace_id = ?`,
    )
    .all(resolvedId) as Record<string, unknown>[];
  const decisionsByStep = new Map<string, DecisionRecord>();
  for (const row of decisionRows) {
    decisionsByStep.set(row.step_id as string, rowToDecision(row));
  }

  const steps = stepRows.map((row) => {
    const step = rowToStep(row);
    const decision = decisionsByStep.get(step.id);
    if (decision) step.decision = decision;
    return step;
  });

  const trace = rowToTrace(traceRow);
  return {
    ...trace,
    steps,
    evals: evalRows.map(rowToEval),
  };
}

// ── 3b. Live tail helpers (watch) ──────────────────────────────────────────

/** Steps of a trace with `step_number` greater than `afterStepNumber`, in order. */
export function getStepsAfter(
  db: Database.Database,
  traceId: string,
  afterStepNumber: number,
): TraceStep[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? AND step_number > ? ORDER BY step_number',
    )
    .all(traceId, afterStepNumber) as Record<string, unknown>[];
  return rows.map(rowToStep);
}

/** The most recently started trace still in status `running`, or null. */
export function getMostRecentRunningTrace(db: Database.Database): Trace | null {
  const row = db
    .prepare("SELECT * FROM agent_traces WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return row ? rowToTrace(row) : null;
}

/** How long a trace may stay `running` before `list` flags it as possibly abandoned. */
export const ABANDONED_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Whether a trace looks abandoned: still `running` and started longer ago than
 * the staleness threshold. `nowMs` is injectable for testing.
 */
export function isPossiblyAbandoned(
  trace: Pick<Trace, 'status' | 'started_at'>,
  thresholdMs: number = ABANDONED_THRESHOLD_MS,
  nowMs: number = Date.now(),
): boolean {
  if (trace.status !== 'running') return false;
  const started = Date.parse(trace.started_at);
  if (Number.isNaN(started)) return false;
  return nowMs - started > thresholdMs;
}

// ── 4. listTraces ─────────────────────────────────────────────────────────

export function listTraces(
  db: Database.Database,
  filter: ListTracesFilter = {},
): { items: Trace[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.agent_name) {
    conditions.push('agent_name LIKE ?');
    params.push(`%${filter.agent_name}%`);
  }
  if (filter.tag) {
    // SQLite JSON: check if the tags array contains the tag
    conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
    params.push(filter.tag);
  }
  if (filter.session_id) {
    // Session correlation key — prefix matching, like trace IDs
    conditions.push('(session_id = ? OR session_id LIKE ?)');
    params.push(filter.session_id, `${filter.session_id}%`);
  }
  if (filter.since) {
    // since is an ISO string or relative duration — callers should resolve to ISO
    conditions.push('started_at >= ?');
    params.push(filter.since);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort — whitelist column names to prevent SQL injection
  const sortMap: Record<string, string> = {
    started_at: 'started_at',
    duration: 'total_duration_ms',
    tokens: 'total_tokens',
    cost: 'total_cost_usd',
    agent_name: 'agent_name',
  };
  const allowedColumns = new Set(Object.values(sortMap));
  const sortCol = sortMap[filter.sort_by ?? 'started_at'] ?? 'started_at';
  if (!allowedColumns.has(sortCol)) {
    throw new Error(`Invalid sort column: ${filter.sort_by}`);
  }
  const sortDir = filter.sort_order === 'asc' ? 'ASC' : 'DESC';

  const limit = filter.limit ?? 25;
  const offset = filter.offset ?? 0;

  const countRow = db
    .prepare(`SELECT COUNT(*) as cnt FROM agent_traces ${whereClause}`)
    .get([...params]) as { cnt: number };

  const rows = db
    .prepare(
      `SELECT * FROM agent_traces ${whereClause} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
    )
    .all([...params, limit, offset]) as Record<string, unknown>[];

  return {
    items: rows.map(rowToTrace),
    total: countRow.cnt,
  };
}

// ── 5. updateTrace ────────────────────────────────────────────────────────

export function updateTrace(
  db: Database.Database,
  traceId: string,
  update: UpdateTraceInput,
): Trace {
  // Build SET clauses only for provided fields
  const sets: string[] = [];
  const params: unknown[] = [];

  if (update.status !== undefined) {
    sets.push('status = ?');
    params.push(update.status);
  }
  if (update.output !== undefined) {
    sets.push('output = ?');
    params.push(JSON.stringify(update.output));
  }
  if (update.ended_at !== undefined) {
    sets.push('ended_at = ?');
    params.push(update.ended_at);
  }
  if (update.total_duration_ms !== undefined) {
    sets.push('total_duration_ms = ?');
    params.push(update.total_duration_ms);
  }
  if (update.total_tokens !== undefined) {
    sets.push('total_tokens = ?');
    params.push(update.total_tokens);
  }
  if (update.total_cost_usd !== undefined) {
    sets.push('total_cost_usd = ?');
    params.push(update.total_cost_usd);
  }
  if (update.error !== undefined) {
    sets.push('error = ?');
    params.push(update.error);
  }

  if (sets.length === 0) {
    // Nothing to update — just return the existing trace
    const row = db.prepare('SELECT * FROM agent_traces WHERE id = ?').get(traceId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Trace ${traceId} not found`);
    return rowToTrace(row);
  }

  params.push(traceId);
  db.prepare(
    `UPDATE agent_traces SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);

  const row = db
    .prepare('SELECT * FROM agent_traces WHERE id = ?')
    .get(traceId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Trace ${traceId} not found`);
  return rowToTrace(row);
}

// ── 6. deleteTrace ────────────────────────────────────────────────────────

export function deleteTrace(
  db: Database.Database,
  traceId: string,
): void {
  const result = db
    .prepare('DELETE FROM agent_traces WHERE id = ?')
    .run(traceId);
  if (result.changes === 0) {
    throw new Error(`Trace ${traceId} not found`);
  }
}

// ── 7. getStepSnapshot ────────────────────────────────────────────────────

export function getStepSnapshot(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
): TraceSnapshot | null {
  const row = db
    .prepare(
      `SELECT s.* FROM agent_trace_snapshots s
       JOIN agent_trace_steps st ON s.step_id = st.id
       WHERE st.trace_id = ? AND st.step_number = ?`,
    )
    .get(traceId, stepNumber) as Record<string, unknown> | undefined;

  if (!row) return null;
  return rowToSnapshot(row);
}

// ── Bonus: createEval (needed by eval-service later) ──────────────────────

export function createEval(
  db: Database.Database,
  traceId: string,
  input: CreateEvalInput,
): EvalResult {
  const id = generateId('evl');
  const timestamp = now();

  db.prepare(
    `INSERT INTO agent_trace_evals
      (id, trace_id, evaluator_type, evaluator_name, score, passed, details, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    traceId,
    input.evaluator_type,
    input.evaluator_name,
    input.score,
    input.passed ? 1 : 0,
    jsonStr(input.details),
    timestamp,
  );

  const row = db
    .prepare('SELECT * FROM agent_trace_evals WHERE id = ?')
    .get(id) as Record<string, unknown>;

  return rowToEval(row);
}
