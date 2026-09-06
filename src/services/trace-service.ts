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
import { DECIDED_BY, STEP_TYPES, TRACE_STATUSES, TRIGGER_TYPES } from '../models/enums.js';
import { isValidConfidence, validateTraceInput } from '../utils/validators.js';
import { SINCE_PREDICATE, sinceParams, DURATION_MS_EXPR, julianDayExpr, effectiveDurationMs } from '../utils/time.js';

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
/**
 * Whether a producer string is PRE-SERIALIZED STRUCTURE, to be stored as-is.
 *
 * Only an object or an array counts. Any parseable JSON used to qualify, which
 * silently re-typed the producer's value: a tool that returned the four-letter
 * text `null` was stored as JSON null and became indistinguishable from a step
 * that produced nothing — `hasRenderableContent` says no, and `show` renders no
 * Output line at all. `"42"` came back the number 42, `"true"` the boolean.
 * The type a value came back as depended on what the value happened to say.
 *
 * A producer sending pre-serialized structure sends `{...}` or `[...]`; nobody
 * writes the text `null` meaning "nothing". Restricting the pass-through to
 * those two keeps the documented behavior for the case it was written for —
 * OTel attributes and harness payloads that carry JSON text — and stops a
 * scalar-looking string from being re-typed. Every reader of these columns
 * expects an object or array anyway.
 */
function isJsonText(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function jsonStr(val: unknown): string {
  if (val === undefined || val === null) return '{}';
  if (typeof val === 'string') return isJsonText(val) ? val : JSON.stringify(val);
  return JSON.stringify(val);
}

/** Whether an input object carries a non-empty `prompt`. */
function hasPromptValue(input: unknown): boolean {
  const prompt = (input as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === 'string' && prompt.trim().length > 0;
}

/** Stored `follow_up_prompts` as a list of strings — anything else reads as none. */
function asPromptList(val: unknown): string[] {
  return Array.isArray(val) ? val.filter((p): p is string => typeof p === 'string' && p !== '') : [];
}

/**
 * The incoming batch's prompt when it is a LATER turn of a trace that already
 * has one — the merge keeps the first prompt as the trace input, so a subsequent
 * turn belongs in `follow_up_prompts` (there is no step type for a user turn).
 * Empty when the trace has no prompt yet, or when the batch repeats the same one.
 */
function promptOf(existingInput: unknown, incomingInput: unknown): string[] {
  const prompt = (incomingInput as { prompt?: unknown } | undefined)?.prompt;
  const kept = (existingInput as { prompt?: unknown } | undefined)?.prompt;
  if (typeof prompt !== 'string' || !prompt) return [];
  if (typeof kept !== 'string' || !kept || kept === prompt) return [];
  return [prompt];
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

/**
 * `earlierRef`, plus the step actually EXISTING in this trace.
 *
 * Range alone is not enough. A reference can be a perfectly well-formed
 * "earlier" number and still point at nothing — a producer whose own counter
 * skips, or the ordinary case where one step was rejected (a bad `step_type`)
 * and the next step references it. The row was stored with a dangling number
 * and three things went wrong, each verified:
 *
 *   - `why` looked the number up, found nothing, and fell through to its
 *     `prior_decision` fallback — presenting a DIFFERENT antecedent as fact,
 *     with no hint that the recorded one was unresolvable.
 *   - `show --tree` printed "⟵ caused by #2" for a step not in the trace, so
 *     two surfaces contradicted each other about one trace.
 *   - `export` then produced a trace `ingest` REFUSES ("references step 2,
 *     which does not exist in this trace") — the tool rejecting its own
 *     output, which is the failure the OTel merge guards against by name.
 *
 * `validateTraceInput` already checks existence on the `ingest` path, and the
 * spec requires it ("A parent reference MUST point to an existing, earlier step
 * in the same trace"); the live path is where it was missing. The referenced
 * step must be strictly earlier, so by the time this runs it is already stored
 * — existence is answerable here.
 */
function existingEarlierRef(
  db: Database.Database,
  traceId: string,
  ref: unknown,
  stepNumber: number,
  field: string,
  dropped: string[],
): number | null {
  const n = earlierRef(ref, stepNumber);
  if (n == null) return null;
  const row = db
    .prepare('SELECT 1 AS ok FROM agent_trace_steps WHERE trace_id = ? AND step_number = ?')
    .get(traceId, n) as { ok: number } | undefined;
  if (row) return n;
  dropped.push(`${field} -> step ${n}`);
  return null;
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
  // Same treatment for `confidence`, which had none: both `ingest` and `record`
  // refuse anything outside [0, 1] (isValidConfidence, shared by those two
  // paths), but a programmatic caller reached this insert directly and a value
  // like 99 was stored — so `show` and `why` rendered a confidence outside its
  // documented range, and the trace failed its own re-ingest. Dropped to null
  // rather than rejected, matching how decided_by is handled one line above:
  // this is the persistence layer, and one unusable field should not cost the
  // whole decision.
  const confidence = isValidConfidence(decision.confidence) ? (decision.confidence as number) : null;
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
    confidence,
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

/**
 * C0 controls, DEL and C1 — never legitimate in an identifier, and an escape
 * sequence in one addresses the terminal of whoever later inspects the trace.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Insert the trace row (no steps). Shared by ingestTrace and startTrace. */
function insertTraceRow(
  db: Database.Database,
  traceId: string,
  input: IngestTraceInput,
  status: string,
  timestamp: string,
): void {
  // A status the schema does not allow is a CALLER error, not a producer's
  // vocabulary — so unlike `trigger` below it is reported, not coerced. It
  // reached SQLite raw, and the CHECK constraint's message ("CHECK constraint
  // failed: status IN (...)") names a constraint rather than the argument the
  // caller passed. `ingestTrace`/`startTrace` are documented public API.
  if (!(TRACE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid trace status "${status}". Valid: ${TRACE_STATUSES.join(', ')}`);
  }
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
  // The SAME validation the `ingest` command performs, so the two public doors
  // to this function agree by construction rather than by hand-copied guards.
  //
  // They did not. `ingest` refuses a negative `total_tokens`/`tokens_used`, a
  // `step_number` of 0, non-string tags, a numeric `started_at` and a duplicate
  // step number with precise field paths; a programmatic caller had all of them
  // stored or coerced silently. The numeric `started_at` was the worst: it was
  // stringified into the column, so every `--since` window and every ordering
  // by parsed instant answered about a time the run never had. The rest
  // surfaced as raw SQLite constraint text naming a column rather than the
  // argument passed.
  const validation = validateTraceInput(input);
  if (!validation.valid) {
    throw new Error(
      `Invalid trace input: ${validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
    );
  }

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
        // Flattened like every sibling error column. This was the one step TEXT
        // column bound raw, so a structured `error` (a shape real producers send,
        // and one `--dry-run` validated as fine) made better-sqlite3 refuse the
        // bind and roll back the whole trace with a message naming neither the
        // field nor the step.
        jsonOrNull(step.error),
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

    // Evaluations carried on the document. `export --with-evals` writes them,
    // and a json/jsonl export is a BACKUP — but ingest read only `steps`, so
    // restoring one reported "Ingested N trace(s) successfully" and kept ZERO
    // evaluations. A success message for data that was dropped is the failure
    // this tool exists to catch.
    //
    // `evaluated_at` is carried through rather than left to the column's
    // `datetime('now')` default: an evaluation restored from a July backup in
    // September would otherwise be stamped September, and a wrong timestamp
    // reads exactly like a right one. Same rule the importers follow for a
    // step's `started_at`.
    for (const ev of input.evals ?? []) {
      db.prepare(
        `INSERT INTO agent_trace_evals
          (id, trace_id, evaluator_type, evaluator_name, score, passed, details, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId('evl'),
        traceId,
        ev.evaluator_type,
        ev.evaluator_name,
        ev.score,
        ev.passed ? 1 : 0,
        jsonStr(ev.details),
        ev.evaluated_at ?? now(),
      );
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
/**
 * Renumber an assembled trace's steps so that step_number follows START TIME
 * rather than arrival order, rewriting parent/caused-by references to match.
 *
 * Batches arrive in completion order, but a parent span ends *after* its
 * children — so the parent flushes later and, numbered on arrival, landed ABOVE
 * the child it owns. That made the backward re-link write a forward parent
 * reference: `validateTraceInput` rejects those (so `otel serve` persisted rows
 * `ingest` refuses, breaking export → ingest for exactly the deep traces this
 * assembly exists to serve), and `why` / `show --tree` rendered step 1 as
 * "caused by #2" — time-travelling causality presented as fact.
 *
 * Numbering by start time is what makes both hold at once: the parent really did
 * start first, so once numbers reflect that, the re-link points backward on its
 * own. Ties keep their current relative order, so a batch of same-instant steps
 * is left alone. The renumber runs inside the merge transaction; it is a no-op
 * when the order is already correct, which is the common case.
 */
/**
 * Renumbering rewrites every row of the trace twice, so it is bounded. A
 * long-running receiver assembling a very large trace would otherwise pay an
 * O(N) rewrite per batch — seconds, while holding the write lock — and the
 * reordering batch is the normal case here, so this is not a rare path. Above
 * the bound the trace keeps arrival order; the forward-reference sweep still
 * runs, so the data stays valid either way.
 */
const RENUMBER_MAX_STEPS = 2_000;

/**
 * The forward-reference sweep, done entirely in SQL.
 *
 * Above the renumber bound this is all that has to happen, and it is a
 * predicate SQLite can evaluate over the rows itself — so it costs one
 * statement instead of pulling every step of the trace into JS to test two
 * numbers per row.
 */
function dropForwardRefsSql(db: Database.Database, traceId: string, touched?: TouchedSteps): void {
  // Scoped to the rows this batch could have changed, when the caller knows
  // them. Above the renumber bound nothing else moves, so a forward reference
  // can only have been created by a step this batch inserted or by an orphan it
  // re-linked — and sweeping the whole trace to find them is the last of the
  // per-batch O(trace) costs that made assembling a long session quadratic.
  const scope = touched
    ? { sql: ' AND (step_number > ? OR step_number IN (' + touched.relinked.map(() => '?').join(',') + '))',
        params: [touched.fromStep, ...touched.relinked] }
    : { sql: '', params: [] as unknown[] };
  db.prepare(
    `UPDATE agent_trace_steps
        SET parent_step_number = CASE WHEN parent_step_number >= step_number THEN NULL ELSE parent_step_number END,
            caused_by_step_number = CASE WHEN caused_by_step_number >= step_number THEN NULL ELSE caused_by_step_number END
      WHERE trace_id = ?
        AND (parent_step_number >= step_number OR caused_by_step_number >= step_number)${scope.sql}`,
  ).run(traceId, ...scope.params);
}

/**
 * The rows a single merge touched: everything it appended (above `fromStep`)
 * and the orphans it re-linked. Nothing else in the trace can have gained a
 * forward reference from that merge.
 */
interface TouchedSteps {
  fromStep: number;
  relinked: number[];
}

function renumberByStartTime(db: Database.Database, traceId: string, touched?: TouchedSteps): void {
  // Count before materializing. Above the bound below this function does not
  // renumber at all, so pulling every row first was reading the whole trace on
  // every batch only to throw it away — the same per-batch O(trace) cost the
  // bound exists to avoid, just spent on the read instead of the write.
  const total = (db
    .prepare('SELECT COUNT(*) AS n FROM agent_trace_steps WHERE trace_id = ?')
    .get(traceId) as { n: number }).n;
  if (total < 2) return;
  if (total > RENUMBER_MAX_STEPS) {
    dropForwardRefsSql(db, traceId, touched);
    return;
  }

  const steps = db
    .prepare(
      `SELECT step_number, started_at, parent_step_number, caused_by_step_number
         FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number`,
    )
    .all(traceId) as {
    step_number: number;
    started_at: string | null;
    parent_step_number: number | null;
    caused_by_step_number: number | null;
  }[];

  const ordered = [...steps].sort((a, b) => {
    const ta = a.started_at ? Date.parse(a.started_at) : NaN;
    const tb = b.started_at ? Date.parse(b.started_at) : NaN;
    // A step with no (or unparseable) start time keeps its arrival position
    // rather than sorting to either end — there is nothing better to say about
    // it, and moving it would reorder steps we have no timing evidence about.
    if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.step_number - b.step_number;
    return ta - tb;
  });

  const renumbered = new Map<number, number>();
  ordered.forEach((s, i) => renumbered.set(s.step_number, i + 1));
  if (ordered.every((s, i) => s.step_number === i + 1)) {
    dropForwardRefs(db, traceId, steps);
    return; // already in order
  }

  const ref = (n: number | null): number | null => (n == null ? null : (renumbered.get(n) ?? null));
  const update = db.prepare(
    `UPDATE agent_trace_steps
        SET step_number = ?, parent_step_number = ?, caused_by_step_number = ?
      WHERE trace_id = ? AND step_number = ?`,
  );

  // Two phases: UNIQUE(trace_id, step_number) means an in-place shuffle can
  // collide mid-flight, so park every row above the current maximum first.
  const offset = steps.reduce((m, s) => Math.max(m, s.step_number), 0);
  for (const s of [...steps].reverse()) {
    update.run(s.step_number + offset, s.parent_step_number, s.caused_by_step_number, traceId, s.step_number);
  }
  for (const s of steps) {
    update.run(
      renumbered.get(s.step_number) as number,
      ref(s.parent_step_number),
      ref(s.caused_by_step_number),
      traceId,
      s.step_number + offset,
    );
  }

  dropForwardRefs(db, traceId);
}

/**
 * Clear any parent/caused-by reference that still points at a LATER step.
 *
 * Start-time ordering cannot always resolve these: span timestamps are stored
 * to millisecond precision, so a parent and a child that start within the same
 * millisecond tie, and the tie-break falls back to arrival order — leaving the
 * forward reference the renumbering was meant to remove. Clock skew between
 * hosts can put a parent's start after its child's outright. Those references
 * are what `validateTraceInput` rejects and what makes `why` render step 1 as
 * "caused by #2", so a trace must never keep one: the same rule the
 * single-batch OTel path and the live record path already enforce. The span ids
 * stay in metadata, so a later batch can still repair the link properly.
 */
function dropForwardRefs(
  db: Database.Database,
  traceId: string,
  known?: { step_number: number; parent_step_number: number | null; caused_by_step_number: number | null }[],
): void {
  const rows =
    known ??
    (db
      .prepare(
        'SELECT step_number, parent_step_number, caused_by_step_number FROM agent_trace_steps WHERE trace_id = ?',
      )
      .all(traceId) as { step_number: number; parent_step_number: number | null; caused_by_step_number: number | null }[]);

  const clear = db.prepare(
    'UPDATE agent_trace_steps SET parent_step_number = ?, caused_by_step_number = ? WHERE trace_id = ? AND step_number = ?',
  );
  for (const r of rows) {
    const parent = r.parent_step_number != null && r.parent_step_number >= r.step_number ? null : r.parent_step_number;
    const caused = r.caused_by_step_number != null && r.caused_by_step_number >= r.step_number ? null : r.caused_by_step_number;
    if (parent !== r.parent_step_number || caused !== r.caused_by_step_number) {
      clear.run(parent, caused, traceId, r.step_number);
    }
  }
}

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

    // Read what this batch actually needs, not the whole trace.
    //
    // This used to SELECT every existing step and `JSON.parse` each one's
    // metadata, to get three things: the highest step number, a span-id -> step
    // map, and the orphans. That is O(trace) work on EVERY batch, and a
    // `BatchSpanProcessor` flushes many batches into one trace — so the cost of
    // assembling a session grew with the square of its length. Measured against
    // a live receiver: 2.6 ms per batch at 2,000 spans, 10.7 ms at 10,000, and
    // 6.5 s of receiver time to assemble 10,000 spans. Each of the three is
    // available without reading the trace.
    const maxStep =
      (db
        .prepare('SELECT COALESCE(MAX(step_number), 0) AS n FROM agent_trace_steps WHERE trace_id = ?')
        .get(traceId) as { n: number }).n;

    // Only steps that are actually unparented can be orphans, and there are
    // few — the root, plus any child whose parent span has not arrived yet.
    const orphans: { step_number: number; parentSpan: string }[] = [];
    for (const s of db
      .prepare('SELECT step_number, metadata FROM agent_trace_steps WHERE trace_id = ? AND parent_step_number IS NULL')
      .all(traceId) as { step_number: number; metadata: string | null }[]) {
      const parentSpan = parseJson(s.metadata)?.otel_parent_span_id;
      if (typeof parentSpan === 'string') orphans.push({ step_number: s.step_number, parentSpan });
    }

    // The span ids this batch can possibly need: the parents its own steps
    // name, and the parents its orphans are still waiting for. Everything else
    // in the trace is irrelevant to this merge. `json_extract` in SQL, so the
    // extraction happens in C over the rows rather than by parsing every
    // metadata blob into JS.
    const wanted = new Set<string>();
    for (const step of input.steps ?? []) {
      const p = (step.metadata ?? {}).otel_parent_span_id;
      if (typeof p === 'string') wanted.add(p);
    }
    for (const o of orphans) wanted.add(o.parentSpan);

    const stepBySpan = new Map<string, number>();
    if (wanted.size > 0) {
      const ids = [...wanted];
      const rows = db
        .prepare(
          `SELECT step_number, json_extract(metadata, '$.otel_span_id') AS span
             FROM agent_trace_steps
            WHERE trace_id = ? AND json_extract(metadata, '$.otel_span_id') IN (${ids.map(() => '?').join(',')})`,
        )
        .all(traceId, ...ids) as { step_number: number; span: string | null }[];
      for (const r of rows) if (typeof r.span === 'string') stepBySpan.set(r.span, r.step_number);
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
        // Flattened like every sibling error column. This was the one step TEXT
        // column bound raw, so a structured `error` (a shape real producers send,
        // and one `--dry-run` validated as fine) made better-sqlite3 refuse the
        // bind and roll back the whole trace with a message naming neither the
        // field nor the step.
        jsonOrNull(step.error),
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
    const relinked: number[] = [];
    for (const orphan of orphans) {
      const parent = stepBySpan.get(orphan.parentSpan);
      if (parent != null && parent !== orphan.step_number) {
        relink.run(parent, traceId, orphan.step_number);
        relinked.push(orphan.step_number);
      }
    }

    renumberByStartTime(db, traceId, { fromStep: maxStep, relinked });

    // Recompute trace-level aggregates over both the existing trace and the
    // incoming batch: widest time window, summed tokens, failure-dominant status.
    const earliest = (a: string, b: string) => (Date.parse(b) < Date.parse(a) ? b : a);
    const latest = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);
    const startedAt = [existing.started_at, input.started_at]
      .filter((v): v is string => !!v)
      .reduce(earliest);
    const endCandidates = [existing.ended_at, input.ended_at].filter((v): v is string => !!v);
    const endedAt = endCandidates.length ? endCandidates.reduce(latest) : null;
    // Same skew guard the mapper applies to its own window (semconv.ts): the
    // start and the end come from independent sets — the earliest of the starts
    // and the latest of the ends — so nothing makes the end follow the start.
    // A trace whose first batch carried no renderable timestamps takes the
    // ingest wall-clock as its started_at; a later batch contributing only an
    // end in the past then wrote a large NEGATIVE total_duration_ms, which the
    // UI renders as a negative duration and `ingest` rejects outright, breaking
    // the round trip of a trace this tool wrote. Keep what we had instead.
    const merged = endedAt ? Math.round(Date.parse(endedAt) - Date.parse(startedAt)) : null;
    const duration =
      merged != null && Number.isFinite(merged) && merged >= 0 ? merged : existing.total_duration_ms;
    const totalTokens = (existing.total_tokens ?? 0) + (input.total_tokens ?? 0);
    // Cost sums across batches exactly like tokens. It was absent from the UPDATE
    // below, so only the FIRST batch's cost survived — and a session whose first
    // batch carried no cost record stayed null forever, which for the usual
    // multi-flush processor meant `stats` and `list --sort cost` never saw the
    // spend at all.
    const totalCost = (existing.total_cost_usd ?? 0) + (input.total_cost_usd ?? 0);
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
    // Adopt what the existing trace still LACKS, whatever flagged it. Keying
    // everything on `wasSynthetic` meant a later batch's content was dropped
    // whenever the trace already had a root — the normal BatchSpanProcessor
    // order, since a sub-agent span ends (and flushes) before its parent. A
    // second `invoke_agent` root then contributed no step and no trace field:
    // its prompt, name and attributes vanished, and the trace was attributed to
    // the sub-agent. The same gap dropped a log session's prompt outright when
    // the batch that opened the trace carried none (a receiver started
    // mid-session, a resumed session, an out-of-order flush).
    if (!hasPromptValue(traceInput) && hasPromptValue(input.input)) {
      traceInput = input.input as Record<string, unknown>;
    }
    // Metadata the root carries (provider, model, span id, unmapped gen_ai.*)
    // was likewise discarded: `mergedMeta` copied the EXISTING trace's only.
    // Existing keys win, so an upgrade can't rewrite what is already recorded.
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (key !== 'synthetic_trace' && !(key in mergedMeta)) mergedMeta[key] = value;
    }

    // Carry the incoming batch's later user turns across the merge. A session's
    // turns are minutes apart, so a log processor flushes each one in its own
    // batch: the mapper correctly put turn 2 in `input` (it is the first prompt
    // IT saw) and turn 3+ in `follow_up_prompts`, and both were then discarded
    // here, because the input is only adopted for a synthetic trace and the
    // metadata was copied from the existing trace alone. A multi-turn session
    // kept only its first question, with the rest nowhere in the store.
    // Collapse only a CONSECUTIVE repeat, which is what a redelivered batch looks
    // like: an OTLP exporter retries on a 5xx, or on a timeout that arrived after
    // the server had already committed, and the identical batch then appended its
    // prompt again on every redelivery — the list grew without bound. Deduping by
    // set membership instead would silently DROP a genuine repeated turn: asking
    // "run the tests" at turn 2 and again at turn 5 is an ordinary session, and
    // an A, B, A sequence would lose its third turn entirely.
    const followUps: string[] = [];
    for (const prompt of [
      ...asPromptList(existing.metadata.follow_up_prompts),
      ...promptOf(traceInput, input.input),
      ...asPromptList(input.metadata?.follow_up_prompts),
    ]) {
      if (followUps[followUps.length - 1] !== prompt) followUps.push(prompt);
    }
    if (followUps.length > 0) mergedMeta.follow_up_prompts = followUps;

    db.prepare(
      `UPDATE agent_traces SET
         agent_name = ?, status = ?, input = ?, output = ?, started_at = ?,
         ended_at = ?, total_duration_ms = ?, total_tokens = ?, total_cost_usd = ?,
         metadata = ?, session_id = ?
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
      totalCost || null,
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
/**
 * Attach a restored trace to the parent it was forked from.
 *
 * `ingestTrace` deliberately stores no lineage: a `parent_trace_id` in a
 * document names a trace in the store that document came from, and ingest mints
 * fresh ids, so writing it through would point at nothing. Only the RESTORE
 * knows which new id each old one became, so only the restore can rebuild the
 * link — which it must, because a fork restored as an ordinary trace is counted
 * as a real run by every guard that excludes forks: `stats`, the dashboard,
 * `check`, `watch`, and `export --format golden`, where a never-executed step
 * prefix in a baseline lets a run that crashed part way reproduce its shorter
 * shape and pass.
 *
 * Both ids must already exist. A trace may not become its own ancestor: a
 * document is untrusted input and can describe a cycle, which would hang any
 * reader that walks lineage.
 */
export function relinkFork(
  db: Database.Database,
  traceId: string,
  parentTraceId: string,
  forkedFromStep: number | null,
): void {
  if (traceId === parentTraceId) throw new Error('a trace cannot be forked from itself');
  const exists = (id: string): boolean =>
    db.prepare('SELECT 1 FROM agent_traces WHERE id = ?').get(id) != null;
  if (!exists(traceId) || !exists(parentTraceId)) {
    throw new Error('both the fork and its parent must be stored before they can be linked');
  }
  // Walk up from the intended parent. Reaching `traceId` means this link would
  // close a loop. Bounded by the walk itself, which cannot revisit a row without
  // having already returned to the start.
  const seen = new Set<string>([traceId]);
  let cursor: string | null = parentTraceId;
  while (cursor != null) {
    if (seen.has(cursor)) throw new Error('fork lineage would form a cycle');
    seen.add(cursor);
    const row = db
      .prepare('SELECT parent_trace_id FROM agent_traces WHERE id = ?')
      .get(cursor) as { parent_trace_id: string | null } | undefined;
    cursor = row?.parent_trace_id ?? null;
  }
  db.prepare('UPDATE agent_traces SET parent_trace_id = ?, forked_from_step = ? WHERE id = ?')
    .run(parentTraceId, numOrNull(forkedFromStep), traceId);
}

export function startTrace(
  db: Database.Database,
  input: IngestTraceInput,
  opts: { id?: string } = {},
): Trace {
  // The WRITE is the single door, not the protocol parser. `validateEvent`
  // rejects a control character in a producer-supplied trace id, but the
  // programmatic path — `TraceRecorder.startTrace`, which builds an event and
  // calls `applyEvent` directly — never passes through it. An id reaches show,
  // list, watch, why, decisions, fork, eval, check and the dashboard, and is
  // copied into `parent_trace_id` by `fork`, so one that can address the
  // terminal must not be storable by ANY route.
  // Reject anything that is not an identifier, not just control characters. An
  // EMPTY id is not nullish, so `?? generateId` did not replace it: the row was
  // stored with `id = ''`, and since every later event needs a non-empty
  // trace_id, that trace was unreachable forever — finalized `timeout`, counted
  // by `list` and by `check`'s candidate scan, and openable by nothing.
  if (opts.id != null && (!opts.id.trim() || CONTROL_CHARS.test(opts.id))) {
    throw new Error('trace id must be a non-empty identifier without control characters');
  }
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
  /** Receives a note for each causal reference dropped, so a caller can report it. */
  droppedRefs: string[] = [],
): TraceStep {
  // Verify trace exists and is running
  const trace = db
    .prepare('SELECT id, status FROM agent_traces WHERE id = ?')
    .get(traceId) as { id: string; status: string } | undefined;

  if (!trace) {
    throw new Error(`Trace ${traceId} not found`);
  }
  // Reported rather than left to the CHECK constraint, for the same reason as
  // the trace status above: `appendStep` is documented public API, and the raw
  // message named a constraint instead of the value passed.
  if (!(STEP_TYPES as readonly string[]).includes(input.step_type as string)) {
    throw new Error(`Invalid step_type "${String(input.step_type)}". Valid: ${STEP_TYPES.join(', ')}`);
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
      // Keep only a strictly-earlier reference that EXISTS. `ingest` validates
      // both, but the live record/SDK path passed producer values straight
      // through — and causalWalk's contract ("references are validated to point
      // strictly earlier, so the walk is acyclic") depends on it. A forward
      // reference made `why` present time-travelling causality as fact: step 1
      // rendered "caused by #2", a step that hadn't happened yet. A
      // self-reference is dropped for the same reason, and a DANGLING one — see
      // `existingEarlierRef` — for a worse one.
      existingEarlierRef(db, traceId, input.parent_step ?? input.parent_step_number, input.step_number, 'parent_step', droppedRefs),
      existingEarlierRef(db, traceId, input.caused_by_step ?? input.caused_by_step_number, input.step_number, 'caused_by_step', droppedRefs),
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

/**
 * A trace-id prefix that matches more than one trace.
 *
 * Its own type so callers can tell "you named this ambiguously" (a USAGE error,
 * exit 2) from "something broke" (exit 1) — the same split `check` documents
 * between a regression and a gate that could not run. Commands that support
 * `--json` catch it and answer in that shape; the CLI's top-level handler maps
 * it to exit 2 for the rest.
 */
export class AmbiguousTraceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousTraceIdError';
  }
}

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
  //
  // Try the exact id on its own FIRST. The combined query below is correct but
  // cannot use the PRIMARY KEY index: `id = ? OR id LIKE ?` is a disjunction, so
  // SQLite falls back to `SCAN agent_traces` plus a temp B-tree for the ORDER BY.
  // That is ~3.5 ms per lookup on a 10k-trace store against ~0.005 ms for a
  // keyed hit, and it grows with the store — `exportTraces` calls this once per
  // trace with an ALREADY-CANONICAL id and no limit, which made a whole-store
  // export quadratic (1k traces 0.4 s, 2k 1.2 s, 4k 5.5 s). Same class of defect
  // as the `list` full scan that schema v4's expression index exists to fix, on
  // the path that builds golden datasets and backups. The exact match is also
  // what the ORDER BY below would have chosen, so this changes no result — a
  // prefix that is itself a full id resolves to that id either way.
  const escaped = traceId.replace(/[\\%_]/g, '\\$&');
  let traceRow = db.prepare('SELECT * FROM agent_traces WHERE id = ?').get(traceId) as
    | Record<string, unknown>
    | undefined;

  if (!traceRow) {
    // LIMIT 2, not 1: an AMBIGUOUS prefix used to resolve to whichever id sorted
    // first, silently and with no warning — so `why`/`decisions`/`show` answered
    // about a trace the user did not name, and `fork`, which WRITES, derived a
    // new trace from one. `fork trc_ --from-step 1` was enough to fork an
    // arbitrary trace out of a whole store at exit 0. Deterministic ordering
    // made that stable, not correct.
    const matches = db
      .prepare("SELECT * FROM agent_traces WHERE id LIKE ? ESCAPE '\\' ORDER BY id ASC LIMIT 2")
      .all(`${escaped}%`) as Record<string, unknown>[];
    if (matches.length > 1) {
      throw new AmbiguousTraceIdError(
        `Ambiguous trace id "${traceId}" — it matches at least ${matches.map((m) => m.id as string).join(' and ')}. ` +
          'Use more characters of the id.',
      );
    }
    traceRow = matches[0];
  }

  if (!traceRow) return null;

  const resolvedId = traceRow.id as string;

  const stepRows = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number',
    )
    .all(resolvedId) as Record<string, unknown>[];

  const evalRows = db
    .prepare(
      // rowid breaks the tie: evaluated_at has millisecond resolution and one
      // `--all` run writes several evals inside the same millisecond, where the
      // implicit rowid order is ASCENDING — the reverse of the newest-first this
      // asks for, so re-running an evaluator could show the stale verdict above
      // the fresh one.
      'SELECT * FROM agent_trace_evals WHERE trace_id = ? ORDER BY evaluated_at DESC, rowid DESC',
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

/**
 * One page of a live tail: the steps written since `cursor`, and the cursor to
 * pass next time.
 *
 * The cursor is the ROWID — insertion order — not the step number. `watch` must
 * not cursor on step_number: those are producer-supplied and need only be
 * unique, so a step written after a higher-numbered one would be filtered out
 * and silently dropped from the tail (see `unseenSteps`). rowid is assigned by
 * SQLite in write order, so it carries a cursor without that risk.
 *
 * Why it matters: `watch` re-read the WHOLE trace on every poll — `getStepsAfter
 * (id, 0)` — materializing and JSON-parsing every row twice a second. On a
 * long session, which is the case `watch` exists for, that grows without bound:
 * measured at 4.1 ms per poll at 2,000 steps and 31.9 ms at 8,000 (a superlinear
 * climb, from the allocation churn), i.e. 6.4% of a core at the default interval
 * and about 64% at the `--interval 50` the README shows. The command's cost
 * should not scale with the length of the run it is following.
 */
export interface StepPage {
  steps: TraceStep[];
  cursor: number;
}

export function getStepsSince(db: Database.Database, traceId: string, cursor: number): StepPage {
  const rows = db
    .prepare('SELECT rowid AS _rowid, * FROM agent_trace_steps WHERE trace_id = ? AND rowid > ? ORDER BY rowid')
    .all(traceId, cursor) as (Record<string, unknown> & { _rowid: number })[];
  return {
    steps: rows.map(rowToStep),
    cursor: rows.length ? rows[rows.length - 1]._rowid : cursor,
  };
}

/**
 * Specific steps of a trace by step number — for re-reading the handful a live
 * tail is still holding open.
 *
 * A `step_end` UPDATES an existing row, which does not change its rowid, so the
 * page above cannot carry the closing line. The open set is normally empty or a
 * single step, so this is a targeted read rather than another full scan.
 */
export function getStepsByNumbers(db: Database.Database, traceId: string, numbers: number[]): TraceStep[] {
  if (numbers.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM agent_trace_steps
        WHERE trace_id = ? AND step_number IN (${numbers.map(() => '?').join(',')})
        ORDER BY step_number`,
    )
    .all(traceId, ...numbers) as Record<string, unknown>[];
  return rows.map(rowToStep);
}

/** How many steps a trace has. Index-only, so it stays cheap on a long trace. */
export function countSteps(db: Database.Database, traceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM agent_trace_steps WHERE trace_id = ?').get(traceId) as { n: number })
    .n;
}

/**
 * The most recently started live trace still in status `running`, or null.
 * Forks are excluded: `fork` opens its copy as `running` with a fresh
 * started_at, so a fork always sorted first here and a bare `watch` attached to
 * the static copy — showing nothing happening — instead of the live run.
 *
 * "Most recent" is the parsed instant, not the byte order. This resolver ranks
 * traces from DIFFERENT producers against each other — `hook`, `record`, the
 * OTel receiver and `ingest` each write `started_at` in whatever form they
 * received — and a `2026-08-16 23:00:00` (SQLite's space form) sorts below every
 * `T`-separated timestamp, so a bare `watch` attached to an older run and showed
 * a live session doing nothing. Byte order stays the secondary key so a
 * timestamp julianday cannot parse is never dropped.
 */
export function getMostRecentRunningTrace(db: Database.Database): Trace | null {
  const row = db
    .prepare(
      "SELECT * FROM agent_traces WHERE status = 'running' AND parent_trace_id IS NULL" +
        ` ORDER BY ${julianDayExpr('started_at')} DESC, started_at DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToTrace(row) : null;
}

/** How long a trace may stay `running` before `list` flags it as possibly abandoned. */
export const ABANDONED_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Whether a trace looks abandoned: still `running` and started longer ago than
 * the staleness threshold. `nowMs` is injectable for testing.
 *
 * A FORK is never abandoned, however long it sits. `fork` copies a run up to a
 * step and leaves the copy `running` for the user to explore, so every what-if
 * sandbox in the store crossed the threshold half an hour after it was created
 * and was then reported — in `list`, in `show`, in `show --json`, on the
 * dashboard and by `watch` — as a capture whose writer had died. Nothing is
 * wrong with it, and nothing the marker suggests would help.
 * `getMostRecentRunningTrace` already draws exactly this line
 * (`parent_trace_id IS NULL`, so `watch` never attaches to a fork); this is the
 * same rule at the other site that reads `status = 'running'` as "a capture is
 * in progress".
 */
export function isPossiblyAbandoned(
  trace: Pick<Trace, 'status' | 'started_at'> & { parent_trace_id?: string | null },
  thresholdMs: number = ABANDONED_THRESHOLD_MS,
  nowMs: number = Date.now(),
): boolean {
  if (trace.parent_trace_id) return false;
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
  if (filter.agent_name_exact) {
    // Exact match, for a caller that needs to name ONE agent — a regression gate
    // in particular, where the substring form below selects agents the user did
    // not ask about. Checked before the substring branch so the two can never
    // both apply.
    conditions.push('agent_name = ?');
    params.push(filter.agent_name_exact);
  } else if (filter.agent_name) {
    // Substring match, but escape the LIKE metacharacters in the user's term so
    // they stay literal — agent names routinely contain `_` (e.g. "travel_bot"),
    // which unescaped matches any character ("travel-bot"), and a literal `%`
    // would match everything. Mirrors the session_id branch below.
    const escaped = filter.agent_name.replace(/[\\%_]/g, '\\$&');
    conditions.push("agent_name LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  if (filter.source_format) {
    // Which capture path recorded it. Exact: the formats are short identifiers
    // that prefix one another (`record:native`, `record:codex-exec`), so a
    // substring match would answer a narrower question than it was asked.
    conditions.push(`json_extract(metadata, '$.source_format') = ?`);
    params.push(filter.source_format);
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
    // since is an ISO string or relative duration — callers should resolve to ISO.
    // Compared as an instant, not as bytes: see SINCE_PREDICATE.
    conditions.push(SINCE_PREDICATE);
    params.push(...sinceParams(filter.since));
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort — whitelist expressions to prevent SQL injection.
  //
  // `duration` must sort by the SAME number the Duration column displays.
  // `list`/`show` render `effectiveDurationMs`, which falls back to
  // ended_at - started_at when total_duration_ms is null — and the hook
  // finalizer sets ONLY ended_at, so every hook-captured trace has a null
  // total_duration_ms. Sorting on the raw column pushed all of them to the end
  // as NULLs, so `list --sort -duration` visibly ended with its longest rows and
  // "my slowest traces" returned the wrong set. Mirror the fallback here, as
  // `stats` already does for its average.
  const TOKENS_EXPR = `COALESCE(
    total_tokens,
    (SELECT SUM(s.tokens_used) FROM agent_trace_steps s WHERE s.trace_id = agent_traces.id)
  )`;
  const DURATION_EXPR = DURATION_MS_EXPR;
  // `tokens` needs the same treatment as `duration`, for the same reason: the
  // trace-level column is set only when a producer reports a total, while
  // `ingest`, `record`, the OTel mapper and the importers all populate per-step
  // `tokens_used`. Sorting on the raw column ranked a 50,000-token trace BELOW
  // a 7-token one — "show me my most expensive runs" returned the cheapest.
  // `started_at` is TEXT, and nothing constrains the format a producer writes:
  // SQLite's own `2026-08-16 23:00:00` and a numeric offset `…T22:00:00+02:00`
  // both occur (the same reason SINCE_PREDICATE parses with julianday rather
  // than comparing bytes). Ordering the raw column compares BYTES, so those
  // traces ranked by spelling instead of instant — `list` could put the newest
  // trace last while `stats --since` counted it as the most recent. Sort by the
  // parsed instant, keeping the byte order as a secondary key for a timestamp
  // julianday cannot parse at all (NULL), so no row is ever dropped or
  // arbitrarily placed among its unparseable peers.
  //
  // Use `julianDayExpr`, not a bare `julianday()`: the latter returns NULL for
  // an ISO basic-format offset (`+0200`), so those rows had no instant to sort
  // by and clustered at one end ranked by BYTES — the newest trace printed
  // last, and `--limit 1` returned the wrong one. Schema v5 indexes exactly
  // this expression, so the ordering stays keyed.
  const STARTED_EXPRS = [julianDayExpr('started_at'), 'started_at'];
  const sortMap: Record<string, string> = {
    started_at: 'started_at',
    duration: DURATION_EXPR,
    tokens: TOKENS_EXPR,
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
  const orderBy = `${(sortKey === 'started_at' ? STARTED_EXPRS : [sortCol])
    .map((e) => `${e} ${sortDir}`)
    .join(', ')}, id ASC`;

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
        (SELECT COUNT(*) FROM agent_trace_steps s WHERE s.trace_id = agent_traces.id) AS step_count,
        ${TOKENS_EXPR} AS effective_tokens
       FROM agent_traces ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    )
    .all([...params, limit, offset]) as Record<string, unknown>[];

  return {
    items: rows.map((row) => {
      const trace = rowToTrace(row);
      trace.step_count = (row.step_count as number) ?? 0;
      trace.effective_tokens = (row.effective_tokens as number | null) ?? null;
      // The number the Duration column shows, so a caller reading the JSON sees
      // what the table beside it printed.
      //
      // Derived in JS through the shared helper rather than by selecting
      // `DURATION_MS_EXPR`, even though that expression is right there and
      // already orders `--sort duration`. It computes the fallback from
      // julianday arithmetic, so a clean ten-second span comes back as
      // 9999.985992908478 — a fractional millisecond count no clock produced,
      // and one that would disagree with the exact 30000 `show --json` reports
      // for the same trace from the same two timestamps. Sorting can live with
      // sub-millisecond noise; a number in the document cannot.
      trace.effective_duration_ms = effectiveDurationMs(trace);
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
    // trace stuck `running`).
    //
    // An unrecognized terminal status now maps to `failed`, not `completed`.
    // Coercing upward was a fail-open: `endTrace({status: 'Failed'})` — a case
    // difference — and `'aborted'`, `'cancelled'`, `'Timeout'` were all stored
    // as SUCCESS, and the deterministic evaluators read `status`, so a run the
    // caller explicitly declared failed scored 1.0 PASS and exited 0. Ask which
    // direction costs more: reporting an unreadable outcome as failure is
    // visible and correctable; reporting it as success is a false green nobody
    // goes looking for. A MISSING status still defaults to `completed` at the
    // recorder, which is a different question — that is a clean stream ending
    // normally, not a value we could not read.
    params.push((TRACE_STATUSES as readonly string[]).includes(update.status as string) ? update.status : 'failed');
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
