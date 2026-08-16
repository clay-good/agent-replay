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
import { DECIDED_BY, TRACE_STATUSES, TRIGGER_TYPES } from '../models/enums.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a snapshot's context_window, which may hold arbitrary JSON or an
 * unparseable raw string (the field type is `unknown`). Fall back to the raw
 * value rather than throwing on the read path.
 */
function parseContextWindow(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * A string bound to a JSON TEXT column is passed through only when it already
 * IS JSON — that passthrough exists for callers handing us a pre-serialized
 * payload. Anything else has to be encoded: raw text written into a JSON column
 * fails `parseJson` on the way back out, so every reader (show, diff, export,
 * replay, the golden gate) saw `{}` or `null` where the data used to be.
 *
 * Nothing validates that a producer sends an object — `validateTraceInput`
 * accepts `input: "summarize the doc"` and the event protocol never type-checks
 * `input`/`output` — so `ingest` and live `record`/`hook` capture all took a
 * plain-string prompt and silently dropped it, exit 0, no warning.
 */
function isJsonText(val: string): boolean {
  try {
    JSON.parse(val);
    return true;
  } catch {
    return false;
  }
}

function jsonStr(val: unknown): string {
  if (val === undefined || val === null) return '{}';
  if (typeof val === 'string') return isJsonText(val) ? val : JSON.stringify(val);
  return JSON.stringify(val);
}

/**
 * For the plain-TEXT `error` column, which is read back raw rather than through
 * `parseJson`: a string is stored as-is and a structured error is flattened to
 * JSON text. Do NOT use this for a JSON column — see `jsonColOrNull`.
 */
function jsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

/** `jsonStr`'s nullable form, for a nullable JSON column (`output`). */
function jsonColOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return isJsonText(val) ? val : JSON.stringify(val);
  return JSON.stringify(val);
}

/**
 * Coerce a producer value bound to a plain TEXT column.
 *
 * better-sqlite3 refuses to bind an object or array, and on the live `record`
 * path that throw is swallowed as a per-event warning — so a single malformed
 * scalar (`agent_version: {maj: 1}`, `model: {id: 'x'}`) destroyed the entire
 * trace or dropped the whole step, exit 0. The ingest path validates these
 * upstream, so this only ever fires on live-captured data. Same principle as
 * the `trigger` / `status` / `tags` coercions: one bad field must not cost the
 * run. A non-scalar is dropped to null rather than guessed at.
 */
function textOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return null;
}

/**
 * Coerce a producer value bound to a numeric column, for the same reason as
 * `textOrNull`. A numeric string is accepted (producers commonly emit
 * `"1234"`); anything non-finite or non-scalar becomes null, so a bad token
 * count can't cost the finalization that carries it.
 */
function numOrNull(val: unknown): number | null {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A step reference (`parent_step` / `caused_by_step`) that is safe to store:
 * a positive integer strictly earlier than the referring step, or null.
 */
function earlierRef(ref: unknown, stepNumber: number): number | null {
  const n = numOrNull(ref);
  if (n == null || !Number.isInteger(n) || n < 1 || n >= stepNumber) return null;
  return n;
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
    // Must actually be an array. The column is contracted to hold one, but a
    // legacy or directly-inserted row can hold any JSON, and returning that as
    // `string[]` is a type lie every consumer then trips over — `fork --tag`
    // crashed on `tags.push` after its fork had already been committed.
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
  // Coerce decided_by to a valid enum value so an out-of-range value from an
  // untrusted producer can't violate the CHECK constraint and abort the write.
  const decidedBy = (DECIDED_BY as readonly string[]).includes(decision.decided_by ?? '')
    ? decision.decided_by
    : 'agent';
  db.prepare(
    `INSERT INTO agent_trace_decisions
      (id, step_id, options, chosen, rationale, confidence, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    generateId('dec'),
    stepId,
    JSON.stringify(decision.options ?? []),
    decision.chosen,
    textOrNull(decision.rationale),
    numOrNull(decision.confidence),
    decidedBy,
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
    context_window: parseContextWindow(row.context_window as string | null),
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
    textOrNull(input.agent_version),
    // Coerce trigger to a valid enum value, like decided_by below. The live
    // `record` path types trigger as a free string, so a producer's own
    // vocabulary ("scheduled") would otherwise violate the CHECK constraint and
    // abort trace creation — which the recorder swallows as a warning, losing the
    // entire trace. (The ingest path already rejects a bad trigger upstream, so
    // this only ever coerces live-captured values.)
    (TRIGGER_TYPES as readonly string[]).includes(input.trigger as string) ? input.trigger : 'manual',
    status,
    jsonStr(input.input),
    jsonColOrNull(input.output),
    textOrNull(input.started_at) ?? timestamp,
    textOrNull(input.ended_at),
    numOrNull(input.total_duration_ms),
    numOrNull(input.total_tokens),
    numOrNull(input.total_cost_usd),
    jsonOrNull(input.error),
    // Coerce to an array at the boundary, like `trigger` and `status` above:
    // `ingest` validates tags, but the live event protocol doesn't type-check
    // them, so a producer's `tags: {...}` would otherwise be stored verbatim in
    // a column every reader treats as an array.
    JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
    jsonStr(input.metadata),
    null, // parent_trace_id
    null, // forked_from_step
    textOrNull(input.session_id),
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
        jsonColOrNull(step.output),
        textOrNull(step.started_at) ?? timestamp,
        textOrNull(step.ended_at),
        numOrNull(step.duration_ms),
        numOrNull(step.tokens_used),
        textOrNull(step.model),
        step.error ?? null,
        jsonStr(step.metadata),
        step.parent_step ?? step.parent_step_number ?? null,
        step.caused_by_step ?? step.caused_by_step_number ?? null,
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
          numOrNull(step.snapshot.token_count) ?? 0,
        );
      }
    }

    return db
      .prepare('SELECT * FROM agent_traces WHERE id = ?')
      .get(traceId) as Record<string, unknown>;
  });

  return rowToTrace(ingest());
}

// ── 1b. mergeBatchIntoTrace (cross-batch OTLP assembly) ────────────────────

/**
 * Append a further OTLP export batch (already mapped to an `IngestTraceInput`)
 * into an existing trace that shares its merge key — the OTel trace id, or the
 * emitter's session id for log-event batches. This assembles a single logical
 * trace whose spans or log events arrive across several export batches (the
 * common `BatchSpanProcessor` case, where completed child spans flush before
 * the root span ends) into one agent-replay trace instead of fragmenting it
 * into one trace per batch.
 *
 * New steps are renumbered after the existing steps, and their intra-batch
 * parent/caused-by references are offset to match; a step whose parent lives in
 * an earlier batch is re-linked by OTel span id, and — because a parent span
 * ends after its children and so can flush in a *later* batch — an existing
 * orphan is re-linked backward once the batch carrying its parent arrives.
 * Trace-level aggregates (time window, tokens, status) are recomputed, and a
 * rootless synthetic trace is upgraded in place (agent name, input/output,
 * `synthetic_trace` flag cleared) once the batch carrying the agent root finally
 * arrives. Duplicate deliveries of the same span are not de-duplicated —
 * localhost OTLP delivery is effectively exactly-once, and dedup would
 * complicate cross-batch parentage.
 */
export function mergeBatchIntoTrace(
  db: Database.Database,
  traceId: string,
  input: IngestTraceInput,
): Trace {
  const timestamp = now();

  const run = db.transaction(() => {
    const existing = rowToTrace(
      db.prepare('SELECT * FROM agent_traces WHERE id = ?').get(traceId) as Record<string, unknown>,
    );

    const existingSteps = db
      .prepare('SELECT step_number, parent_step_number, metadata FROM agent_trace_steps WHERE trace_id = ?')
      .all(traceId) as { step_number: number; parent_step_number: number | null; metadata: string | null }[];

    let maxStep = 0;
    const stepBySpan = new Map<string, number>();
    // Existing steps still missing a parent whose OTel parent span had not yet
    // arrived when they were stored — candidates for the backward re-link below.
    const orphans: { step_number: number; parentSpan: string }[] = [];
    for (const s of existingSteps) {
      if (s.step_number > maxStep) maxStep = s.step_number;
      const meta = parseJson(s.metadata);
      const spanId = meta?.otel_span_id;
      if (typeof spanId === 'string') stepBySpan.set(spanId, s.step_number);
      const parentSpan = meta?.otel_parent_span_id;
      if (s.parent_step_number == null && typeof parentSpan === 'string') {
        orphans.push({ step_number: s.step_number, parentSpan });
      }
    }

    for (const step of input.steps ?? []) {
      const newNumber = maxStep + step.step_number;
      const rawParent = step.parent_step ?? step.parent_step_number ?? null;
      const meta = step.metadata ?? {};
      const parentSpan = meta.otel_parent_span_id;
      const parent =
        rawParent != null
          ? maxStep + rawParent
          : typeof parentSpan === 'string' && stepBySpan.has(parentSpan)
            ? (stepBySpan.get(parentSpan) as number)
            : null;
      const rawCaused = step.caused_by_step ?? step.caused_by_step_number ?? null;
      const caused = rawCaused != null ? maxStep + rawCaused : null;

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
        newNumber,
        step.step_type,
        step.name,
        jsonStr(step.input),
        jsonColOrNull(step.output),
        textOrNull(step.started_at) ?? timestamp,
        textOrNull(step.ended_at),
        numOrNull(step.duration_ms),
        numOrNull(step.tokens_used),
        textOrNull(step.model),
        step.error ?? null,
        jsonStr(step.metadata),
        parent,
        caused,
      );

      if (step.decision) insertDecision(db, stepId, step.decision);

      // Register this span so a later step (this batch or the next) can parent
      // onto it by span id.
      const spanId = meta.otel_span_id;
      if (typeof spanId === 'string') stepBySpan.set(spanId, newNumber);
    }

    // Backward re-link: an OTel parent span ends *after* its children, so it can
    // flush in a *later* batch than a child it owns. Such a child was stored with
    // parent_step_number null (its parent span hadn't arrived yet) but kept its
    // otel_parent_span_id. Now that this batch may carry that parent, resolve any
    // orphan whose parent span id is finally known — otherwise a deep trace whose
    // parent span crosses a flush boundary loses its hierarchy (`show --tree`,
    // `why`) permanently. Only the forward direction was handled before.
    const relink = db.prepare(
      'UPDATE agent_trace_steps SET parent_step_number = ? WHERE trace_id = ? AND step_number = ?',
    );
    for (const orphan of orphans) {
      const parent = stepBySpan.get(orphan.parentSpan);
      if (parent != null && parent !== orphan.step_number) {
        relink.run(parent, traceId, orphan.step_number);
      }
    }

    // Recompute trace-level aggregates over both the existing trace and the
    // incoming batch: widest time window, summed tokens, failure-dominant status.
    const earliest = (a: string, b: string) => (Date.parse(b) < Date.parse(a) ? b : a);
    const latest = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);
    const startedAt = [existing.started_at, input.started_at]
      .filter((v): v is string => !!v)
      .reduce(earliest);
    const endCandidates = [existing.ended_at, input.ended_at].filter((v): v is string => !!v);
    const endedAt = endCandidates.length ? endCandidates.reduce(latest) : null;
    const duration = endedAt
      ? Math.round(Date.parse(endedAt) - Date.parse(startedAt))
      : existing.total_duration_ms;
    const totalTokens = (existing.total_tokens ?? 0) + (input.total_tokens ?? 0);
    const status =
      existing.status === 'failed' || input.status === 'failed' ? 'failed' : existing.status;

    // Upgrade a rootless synthetic trace in place once the batch that carries
    // the agent root arrives (a real root batch is not flagged synthetic).
    const mergedMeta = { ...existing.metadata };
    const wasSynthetic = existing.metadata.synthetic_trace === true;
    const incomingHasRoot = input.metadata?.synthetic_trace !== true;
    let agentName = existing.agent_name;
    let traceInput = existing.input;
    let traceOutput = existing.output;
    if (wasSynthetic && incomingHasRoot) {
      agentName = input.agent_name;
      traceInput = input.input ?? existing.input;
      traceOutput = input.output ?? existing.output;
      delete mergedMeta.synthetic_trace;
    } else if (existing.output == null && input.output != null) {
      traceOutput = input.output;
    }

    db.prepare(
      `UPDATE agent_traces SET
         agent_name = ?, status = ?, input = ?, output = ?, started_at = ?,
         ended_at = ?, total_duration_ms = ?, total_tokens = ?, metadata = ?,
         session_id = ?
       WHERE id = ?`,
    ).run(
      agentName,
      status,
      jsonStr(traceInput),
      jsonColOrNull(traceOutput),
      startedAt,
      endedAt,
      duration ?? null,
      totalTokens || null,
      jsonStr(mergedMeta),
      existing.session_id ?? input.session_id ?? null,
      traceId,
    );

    return db.prepare('SELECT * FROM agent_traces WHERE id = ?').get(traceId) as Record<string, unknown>;
  });

  return rowToTrace(run());
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
      jsonColOrNull(input.output),
      textOrNull(input.started_at) ?? timestamp,
      textOrNull(input.ended_at),
      numOrNull(input.duration_ms),
      numOrNull(input.tokens_used),
      textOrNull(input.model),
      // Coerce error like the adjacent output: the live `record`/SDK path types
      // error as a string, but a producer just as naturally puts a structured
      // error ({message, code, …}) here — an unbindable object that would throw
      // and (swallowed as a per-event warning) drop the whole step. jsonOrNull
      // keeps a plain string as-is and JSON-stringifies an object, matching the
      // hook adapter's existing error guard.
      jsonOrNull(input.error),
      jsonStr(input.metadata),
      // Keep only a strictly-earlier reference. `ingest` validates this, but the
      // live record/SDK path passes producer values straight through — and
      // causalWalk's contract ("references are validated to point strictly
      // earlier, so the walk is acyclic") depends on it. A forward reference
      // made `why` present time-travelling causality as fact: step 1 rendered
      // "caused by #2", a step that hadn't happened yet. A self-reference is
      // dropped for the same reason.
      earlierRef(input.parent_step ?? input.parent_step_number, input.step_number),
      earlierRef(input.caused_by_step ?? input.caused_by_step_number, input.step_number),
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
        numOrNull(input.snapshot.token_count) ?? 0,
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
    params.push(jsonColOrNull(patch.output));
  }
  if (patch.ended_at !== undefined) {
    sets.push('ended_at = ?');
    params.push(textOrNull(patch.ended_at));
  }
  if (patch.duration_ms !== undefined) {
    sets.push('duration_ms = ?');
    params.push(numOrNull(patch.duration_ms));
  }
  if (patch.tokens_used !== undefined) {
    sets.push('tokens_used = ?');
    params.push(numOrNull(patch.tokens_used));
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(textOrNull(patch.model));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(jsonOrNull(patch.error)); // coerce a structured error to text, like output
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
  // Replace atomically so a failed insert can't leave the step with no record.
  db.transaction(() => {
    db.prepare('DELETE FROM agent_trace_decisions WHERE step_id = ?').run(stepId);
    insertDecision(db, stepId, decision);
  })();
}

/** Attach (or replace) a snapshot on an existing step. */
export function attachSnapshot(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
  snapshot: IngestSnapshotInput,
): void {
  const stepId = resolveStepId(db, traceId, stepNumber);
  // Replace atomically so a failed insert can't leave the step with its old
  // snapshot deleted and no replacement (matches attachDecision's invariant).
  db.transaction(() => {
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
      numOrNull(snapshot.token_count) ?? 0,
    );
  })();
}

// ── 3. getTrace ───────────────────────────────────────────────────────────

export function getTrace(
  db: Database.Database,
  traceId: string,
): TraceWithDetails | null {
  // A blank id is never a valid trace. Without this guard the `id LIKE ?`
  // prefix match below turns into `LIKE '%'`, which matches every row and
  // resolves to an arbitrary trace instead of reporting "not found".
  if (!traceId || !traceId.trim()) return null;

  // Support prefix-matching, but always prefer an exact id and resolve prefix
  // collisions deterministically. Without the ORDER BY, `LIMIT 1` could return a
  // longer id that the given id merely prefixes (shadowing an exact match) or an
  // arbitrary one of several prefix siblings. `(id = ?) DESC` floats the exact
  // match to the top; `id ASC` makes the fallback stable.
  // Escape LIKE metacharacters so a partial id stays literal. Trace ids are
  // `trc_` + nanoid(12) over the default alphabet, which includes `_` and `-`,
  // so a copied partial like `trc_ab_c` would otherwise treat `_` as a wildcard
  // and resolve to an unrelated trace; a literal `%` would match everything.
  // Mirrors the agent_name/session_id branches in listTraces.
  const escaped = traceId.replace(/[\\%_]/g, '\\$&');
  const traceRow = db
    .prepare(
      "SELECT * FROM agent_traces WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY (id = ?) DESC, id ASC LIMIT 1",
    )
    .get(traceId, `${escaped}%`, traceId) as Record<string, unknown> | undefined;

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

  if (filter.id) {
    // Exact id match — callers that want prefix resolution should resolve to a
    // canonical id (via getTrace) before setting this, so bulk operations can be
    // scoped to exactly one trace.
    conditions.push('id = ?');
    params.push(filter.id);
  }
  if (filter.status) {
    // Reject an unknown status rather than silently matching nothing (a typo'd
    // `--status faield` shouldn't read as "no failed traces").
    if (!(TRACE_STATUSES as readonly string[]).includes(filter.status)) {
      throw new Error(`Invalid status '${filter.status}'. Valid: ${TRACE_STATUSES.join(', ')}`);
    }
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.agent_name) {
    // Substring match, but escape the LIKE metacharacters in the user's term so
    // they stay literal — agent names routinely contain `_` (e.g. "travel_bot"),
    // which unescaped matches any character ("travel-bot"), and a literal `%`
    // would match everything. Mirrors the session_id branch below.
    const escaped = filter.agent_name.replace(/[\\%_]/g, '\\$&');
    conditions.push("agent_name LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  if (filter.tag) {
    // SQLite JSON: check if the tags array contains the tag
    conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)");
    params.push(filter.tag);
  }
  if (filter.session_id) {
    // Session correlation key — prefix matching, like trace IDs. But a session id
    // is an arbitrary user string that routinely contains `_` (e.g. "sess_1"),
    // and in a raw LIKE pattern `_`/`%` are wildcards — so "sess_1" would also
    // match "sessX1", "sess-1", etc. Escape the metacharacters and declare the
    // escape char so only the trailing `%` acts as the prefix wildcard.
    const escaped = filter.session_id.replace(/[\\%_]/g, '\\$&');
    conditions.push("(session_id = ? OR session_id LIKE ? ESCAPE '\\')");
    params.push(filter.session_id, `${escaped}%`);
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
  // Reject an unknown sort field rather than silently falling back to the
  // default order (which would hide the user's mistake). sortCol is always one
  // of the whitelisted column names, so it is safe to interpolate below.
  const sortKey = filter.sort_by ?? 'started_at';
  const sortCol = sortMap[sortKey];
  if (!sortCol) {
    throw new Error(`Invalid sort field: '${sortKey}'. Valid: ${Object.keys(sortMap).join(', ')}`);
  }
  const sortDir = filter.sort_order === 'asc' ? 'ASC' : 'DESC';

  const limit = filter.limit ?? 25;
  const offset = filter.offset ?? 0;

  const countRow = db
    .prepare(`SELECT COUNT(*) as cnt FROM agent_traces ${whereClause}`)
    .get([...params]) as { cnt: number };

  // Include a per-trace step count (fast via idx_agent_trace_steps_trace) so the
  // list view can show it instead of a placeholder dash.
  const rows = db
    .prepare(
      `SELECT *,
        (SELECT COUNT(*) FROM agent_trace_steps s WHERE s.trace_id = agent_traces.id) AS step_count
       FROM agent_traces ${whereClause} ORDER BY ${sortCol} ${sortDir}, id ASC LIMIT ? OFFSET ?`,
    )
    .all([...params, limit, offset]) as Record<string, unknown>[];

  return {
    items: rows.map((row) => {
      const trace = rowToTrace(row);
      trace.step_count = (row.step_count as number) ?? 0;
      return trace;
    }),
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
    // Coerce to a valid enum value, like trigger/decided_by. A `trace_end` from
    // the live `record` path carries a free-string status, so a producer value
    // like "success" or "" would otherwise violate the CHECK constraint and abort
    // the whole finalization (dropping output/tokens/ended_at and leaving the
    // trace stuck `running`). An unknown terminal status maps to `completed`,
    // matching the recorder's own `?? 'completed'` default for a missing status.
    params.push((TRACE_STATUSES as readonly string[]).includes(update.status as string) ? update.status : 'completed');
  }
  if (update.output !== undefined) {
    sets.push('output = ?');
    params.push(jsonColOrNull(update.output));
  }
  if (update.ended_at !== undefined) {
    sets.push('ended_at = ?');
    params.push(textOrNull(update.ended_at));
  }
  if (update.total_duration_ms !== undefined) {
    sets.push('total_duration_ms = ?');
    params.push(numOrNull(update.total_duration_ms));
  }
  if (update.total_tokens !== undefined) {
    sets.push('total_tokens = ?');
    params.push(numOrNull(update.total_tokens));
  }
  if (update.total_cost_usd !== undefined) {
    sets.push('total_cost_usd = ?');
    params.push(numOrNull(update.total_cost_usd));
  }
  if (update.error !== undefined) {
    sets.push('error = ?');
    params.push(jsonOrNull(update.error)); // coerce a structured error to text, like output
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
