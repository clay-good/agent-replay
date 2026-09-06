import type Database from 'better-sqlite3';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ingestTrace, mergeBatchIntoTrace } from '../trace-service.js';
import type { IngestTraceInput } from '../../models/types.js';
import { mapOtlpTraces, type MappedOtelTrace } from './semconv.js';
import { mapOtlpLogs, countRecognizedLogRecords} from './log-events.js';
import { decodeTracesData, decodeLogsData } from './protobuf.js';
import { julianDayExpr } from '../../utils/time.js';

/**
 * Local OTLP/HTTP receiver. Accepts `POST /v1/traces` and `POST /v1/logs` in
 * both OTLP/JSON and OTLP/protobuf, decoding gzip when present. GenAI-semconv
 * spans map to traces, with OpenInference and OpenLLMetry fallbacks; Gemini CLI
 * and Claude Code log events map through the log-event mappers. All are stored
 * live.
 *
 * Per the OTLP spec, success answers 200 with an empty body; client-malformed
 * input answers 4xx (not 5xx, which the spec makes retryable). The spec's
 * `partial_success` response is scaffolded but currently unreachable: every
 * span the receiver counts maps to at least a synthetic trace, so a batch never
 * resolves to zero traces.
 *
 * Cross-batch assembly: a single OTel trace (or emitter session) whose spans or
 * log events arrive across multiple export batches — the common
 * `BatchSpanProcessor` case, where completed child spans flush before the root
 * span ends — is assembled into one agent-replay trace. Each batch is still
 * stored immediately (so a trace stays queryable while the session is live);
 * later batches merge into the existing trace by OTel trace id, or by session id
 * for log events, rather than opening a new one. A rootless synthetic trace is
 * upgraded in place once the batch carrying the agent root arrives.
 */

export interface OtelReceiverHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/** A request-level failure that maps to a specific HTTP status (client errors). */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** True for a plain JSON object — the only shape a valid OTLP request can take. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface OtelStats {
  acceptedSpans: number;
  acceptedTraces: number;
}

// Bound the receiver's memory against a runaway or hostile client. An
// unbounded body read OOMs the process, and gzip decompresses at up to ~1000x,
// so a few KB can expand to gigabytes (a "zip bomb"). Both caps sit far above
// any real OTLP batch (typically KB to a few MB), so legitimate exporters are
// unaffected; a body over the cap is 413 (not retryable) rather than a crash.
const MAX_BODY_BYTES = 32 * 1024 * 1024; // compressed/raw request body
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024; // after gunzip

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      // Stop reading, but do NOT destroy the socket here: destroying it before
      // the 413 response flushes surfaces to the client as a connection reset,
      // which OTLP exporters treat as retryable — so they'd resend the oversized
      // batch forever, the exact runaway this cap exists to stop. Throw and let
      // the handler send a real 413 with `Connection: close` (below), so the
      // response reaches the client and the socket closes right after.
      throw new HttpError(413, 'request body too large');
    }
    chunks.push(chunk);
  }
  let buf = Buffer.concat(chunks);
  if ((req.headers['content-encoding'] ?? '').includes('gzip')) {
    // A body that claims gzip but isn't is a client mistake (400), not a server
    // fault (500) — a 500 would make OTLP exporters retry the bad payload. A
    // body that decompresses past the cap is a bomb: 413, also not retryable.
    try {
      buf = gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new HttpError(413, 'decompressed body too large');
      }
      throw new HttpError(400, 'malformed gzip body');
    }
  }
  return buf;
}

function countSpans(otlp: Record<string, unknown>): number {
  let n = 0;
  for (const rs of (otlp.resourceSpans as unknown[]) ?? []) {
    for (const ss of ((rs as { scopeSpans?: unknown[] }).scopeSpans) ?? []) {
      n += (((ss as { spans?: unknown[] }).spans) ?? []).length;
    }
  }
  return n;
}

function countLogRecords(otlp: Record<string, unknown>): number {
  let n = 0;
  for (const rl of (otlp.resourceLogs as unknown[]) ?? []) {
    for (const sl of ((rl as { scopeLogs?: unknown[] }).scopeLogs) ?? []) {
      n += (((sl as { logRecords?: unknown[] }).logRecords) ?? []).length;
    }
  }
  return n;
}

/** Handle one OTLP/JSON traces export. Returns the response body to send. */
export function handleTracesExport(
  db: Database.Database,
  body: string,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  let otlp: unknown;
  try {
    otlp = JSON.parse(body);
  } catch {
    return { status: 400, payload: { error: 'invalid JSON body' } };
  }
  // `null`, arrays, and primitives are valid JSON but not a valid OTLP request;
  // reject them as 400 rather than letting a property access throw a 500.
  if (!isPlainObject(otlp)) {
    return { status: 400, payload: { error: 'invalid OTLP body: expected a JSON object' } };
  }
  return ingestOtlpTraces(db, otlp, stats);
}

/** Handle one OTLP/protobuf traces export (decoded to the shared shape). */
export function handleTracesExportProtobuf(
  db: Database.Database,
  body: Buffer,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  let otlp: Record<string, unknown>;
  try {
    otlp = decodeTracesData(body);
  } catch {
    return { status: 400, payload: { error: 'invalid protobuf body' } };
  }
  return ingestOtlpTraces(db, otlp, stats);
}

/**
 * Find an existing trace this batch belongs to, so spans/log-events arriving
 * across batches assemble into one trace. Span batches merge by OTel trace id;
 * log-event batches merge by (session id, source format). Returns the target
 * trace id, or undefined when this is the first batch (open a new trace).
 *
 * Forks are excluded and the tie is broken by start time (parsed, not by the
 * bytes of the timestamp — see the ordering in `listTraces`): a fork inherits the
 * original's session_id and metadata (so it matches both merge keys), and
 * without these clauses which of the two received later batches was left to
 * SQLite's scan order.
 */
function findMergeTarget(db: Database.Database, input: IngestTraceInput): string | undefined {
  const meta = input.metadata ?? {};
  const otelTraceId = meta.otel_trace_id;
  if (typeof otelTraceId === 'string' && otelTraceId) {
    const row = db
      .prepare(
        `SELECT id FROM agent_traces WHERE json_extract(metadata, '$.otel_trace_id') = ?
           AND parent_trace_id IS NULL ORDER BY ${julianDayExpr('started_at')} ASC, started_at ASC LIMIT 1`,
      )
      .get(otelTraceId) as { id: string } | undefined;
    return row?.id;
  }
  const sourceFormat = meta.source_format;
  if (input.session_id && typeof sourceFormat === 'string') {
    const row = db
      .prepare(
        `SELECT id FROM agent_traces WHERE session_id = ? AND json_extract(metadata, '$.source_format') = ?
           AND parent_trace_id IS NULL ORDER BY ${julianDayExpr('started_at')} ASC, started_at ASC LIMIT 1`,
      )
      .get(input.session_id, sourceFormat) as { id: string } | undefined;
    return row?.id;
  }
  return undefined;
}

/**
 * Store a whole batch atomically, returning what it accepted.
 *
 * `immediate` matters here: better-sqlite3's default transaction is DEFERRED,
 * and the first statement inside is findMergeTarget's SELECT, which takes the
 * WAL read snapshot. If another process (a `hook`, `run`, or `ingest` sharing
 * the store) commits before the first INSERT, the upgrade to a write
 * transaction fails with SQLITE_BUSY_SNAPSHOT — which does NOT invoke the busy
 * handler, so `busy_timeout` gave no protection and the receiver answered 500
 * "database is locked" for the whole batch. Taking the write lock up front lets
 * busy_timeout serialize the writers instead, the way `migrations` already does.
 *
 * The accepted counters are returned rather than incremented in place, so a
 * rolled-back batch cannot leave the shutdown summary reporting spans that were
 * never stored (and counting them again when the exporter retries).
 */
function storeOtelBatch(db: Database.Database, traces: MappedOtelTrace[], stats: OtelStats): void {
  const accepted: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
  db.transaction(() => {
    for (const t of traces) upsertOtelTrace(db, t, accepted);
  }).immediate();
  stats.acceptedTraces += accepted.acceptedTraces;
  stats.acceptedSpans += accepted.acceptedSpans;
}

/** Merge a mapped batch into its existing trace, or open a new one. */
function upsertOtelTrace(db: Database.Database, input: MappedOtelTrace, stats: OtelStats): void {
  const target = findMergeTarget(db, input);
  if (target) {
    // Read BEFORE the merge: this is the model in effect when this batch opened,
    // and the merge is about to move the cursor on to this batch's own.
    const priorModel = (db
      .prepare(`SELECT json_extract(metadata, '$.model') AS model FROM agent_traces WHERE id = ?`)
      .get(target) as { model: unknown } | undefined)?.model;
    // If the target already has a real identity root, this batch's own root has
    // no identity left to define — and merging inserts only `steps`, so the span
    // used to produce no row at all. Keep it as a step: whether a span survives
    // must not depend on where the exporter cut its batches. Its tokens and
    // timing were already folded in at the trace level, so nothing is
    // double-counted.
    //
    // A SYNTHETIC target is the exception: it was opened by a rootless batch and
    // the merge adopts this root as its identity, so adding it as a step too
    // would duplicate it.
    const targetRow = db
      .prepare(`SELECT json_extract(metadata, '$.synthetic_trace') AS synthetic,
                       json_extract(metadata, '$.otel_span_id') AS span_id
                  FROM agent_traces WHERE id = ?`)
      .get(target) as { synthetic: unknown; span_id: unknown } | undefined;

    const candidate = input.otel_identity_root_step;
    const candidateSpan = candidate?.metadata?.otel_span_id;
    // Never add a span that is ALREADY on this trace — as the trace's own
    // identity, or as a step. An OTLP exporter retries a batch it did not get a
    // 200 for, so without this the batch that OPENED the trace would, on
    // redelivery, add its own root back as a step: a trace containing a step
    // that is itself.
    const alreadyPresent =
      typeof candidateSpan === 'string' &&
      (targetRow?.span_id === candidateSpan ||
        db
          .prepare(
            `SELECT 1 FROM agent_trace_steps
              WHERE trace_id = ? AND json_extract(metadata, '$.otel_span_id') = ? LIMIT 1`,
          )
          .get(target, candidateSpan) != null);
    const rootStep = targetRow?.synthetic || alreadyPresent ? undefined : candidate;

    // The same rule, applied to EVERY span in the batch and not just the
    // identity root. The root guard above exists because an exporter retries a
    // batch it did not get a 200 for — but the retry's CHILD spans were appended
    // unconditionally, so a redelivered batch permanently doubled the trace's
    // steps and its token total (the merge adds the batch total to the running
    // one). A lost 200, a client timeout after commit, or the retry the
    // all-or-nothing transaction below explicitly plans for was enough. The span
    // id needed to detect it was already in each step's metadata.
    const incoming = input.steps ?? [];
    let newSteps = incoming;
    if (incoming.length > 0) {
      // Dedupe keys off `otel_span_id`, which only the SPAN path produces.
      //
      // A log-record equivalent was tried and reverted: a key built from
      // (timestamp, step type, name, batch-local ordinal) collided ACROSS
      // batches — the ordinal resets per batch, and a `tool_result` carries no
      // other distinguishing field — so a genuinely different failing call at
      // the same timestamp was silently dropped as a duplicate. Trading
      // duplicate rows for lost rows is the wrong direction, and the token
      // carriers on that path (`api_response`) produce no step at all, so the
      // shape that actually inflates was never covered. Log redelivery
      // therefore still duplicates; that is a known limitation, documented in
      // the README, and strictly safer than dropping real data.
      const seen = new Set(
        (db
          .prepare(
            `SELECT json_extract(metadata, '$.otel_span_id') AS span_id
               FROM agent_trace_steps WHERE trace_id = ?`,
          )
          .all(target) as Array<{ span_id: unknown }>)
          .map((r) => r.span_id)
          .filter((id): id is string => typeof id === 'string'),
      );
      newSteps = incoming.filter((st) => {
        const id = (st.metadata as { otel_span_id?: unknown } | undefined)?.otel_span_id;
        return !(typeof id === 'string' && seen.has(id));
      });
    }

    // Nothing in this batch is new: it is a redelivery, so merging it again
    // would only inflate the totals. `alreadyPresent` covers the ROOT-ONLY
    // retry — the common final flush, since the root span ends last — which
    // carries no child steps at all and so slipped past a check that required
    // `incoming.length > 0`.
    // A batch whose root is NEW still brings something even when every one of
    // its child spans is a duplicate: that root upgrades a rootless synthetic
    // trace to a real one (and carries its own usage). Skipping it because
    // `newSteps` was empty left the trace synthetic forever and dropped the
    // root's tokens — the redelivery guard swallowing a genuine first delivery.
    const bringsNewRoot = candidate != null && !alreadyPresent;
    if (!bringsNewRoot && !rootStep && newSteps.length === 0 && (incoming.length > 0 || alreadyPresent)) return;

    const steps = rootStep ? [...newSteps, rootStep] : newSteps;

    // When dedupe actually removed something, recompute this batch's
    // CONTRIBUTION rather than passing the mapper's batch-wide totals through.
    // Those totals are summed over every span the batch carried, including the
    // ones just dropped as duplicates — so a retry that brought one new span
    // still added the whole batch's tokens and cost again, permanently
    // inflating both. Deduping the steps and not the numbers fixed half the
    // defect and left the half nobody looks at.
    //
    // ONLY when something was dropped, AND only when the retained steps actually
    // carry per-step attribution. This same merge serves the /v1/logs path,
    // whose steps have no `tokens_used` and no `otel_cost_usd` (that mapper
    // reads spend from the record, not the step) — so a recompute there sums to
    // zero and ERASES the batch's real contribution. Requiring attribution
    // makes the recompute apply to the span path, which has it, and never to a
    // path that does not.
    // Gate on WHICH PATH this batch came from, not on what happened to survive
    // the dedupe. Testing the retained steps for attribution looked equivalent
    // and was not: when the duplicate span is the one carrying the tokens and
    // the new span is a tool call (the most ordinary mixed batch there is), the
    // survivors have no attribution, the recompute is skipped, and the mapper's
    // BATCH-WIDE totals — which still include the dropped span's tokens — are
    // merged again. That re-inflated exactly what the recompute exists to
    // prevent. A span carries `otel_span_id`; a log-mapped step never does, and
    // the log path is the one whose steps have no per-step attribution to
    // recompute from.
    const isSpanBatch = incoming.some(
      (st) => typeof (st.metadata as { otel_span_id?: unknown } | undefined)?.otel_span_id === 'string',
    ) || candidate != null;
    const deduped = isSpanBatch && (newSteps.length < incoming.length || (candidate != null && alreadyPresent));
    // Count the ROOT's own usage too, even when it is being absorbed as the
    // trace's identity rather than appended as a step. `rootStep` is undefined
    // both when the root is already present (a redelivery — correctly excluded)
    // and when the target is a SYNTHETIC trace being upgraded by this batch, and
    // the mapper's batch total includes the root's usage in that case. Reducing
    // over `steps` alone therefore silently UNDER-counted: a rootless trace
    // upgraded by a batch that also redelivered a stored child lost the root's
    // tokens entirely. Over-counting was the bug this recompute fixed; this is
    // the same mistake with the sign flipped.
    const contributing = rootStep || alreadyPresent || candidate == null ? steps : [...steps, candidate];
    const totals = deduped
      ? {
          total_tokens:
            contributing.reduce((sum, st) => sum + (Number(st.tokens_used) || 0), 0) || null,
          total_cost_usd:
            contributing.reduce(
              (sum, st) => sum + (Number((st.metadata as { otel_cost_usd?: unknown } | undefined)?.otel_cost_usd) || 0),
              0,
            ) || null,
        }
      : {};
    mergeBatchIntoTrace(db, target, {
      ...input,
      ...totals,
      steps: steps ?? [],
    });
    if (!isSpanBatch) fillLogStepModels(db, target, priorModel, batchModel(input));
    stats.acceptedSpans += steps?.length ?? 0;
    return;
  }
  ingestTrace(db, input);
  stats.acceptedTraces++;
  // Counts STEPS STORED, which is how `otel serve` reports it ("Accepted N
  // trace(s), M step(s)"). The identity root became the trace itself, not a
  // step, so it is deliberately not counted here — the trace it opened is.
  stats.acceptedSpans += input.steps?.length ?? 0;
}

/**
 * Carry a log session's model across the batch boundary.
 *
 * The log mapper can only see one batch, so it stamps a step with a model only
 * when the SAME batch carried a model-bearing record. Batches are cut mid-session
 * constantly — the mapper's own note calls a flush window of only model-call
 * events "very common between tool calls" — so the ordinary live shape is an
 * `api_request` in one batch and the `tool_result` it led to in the next, which
 * left the step with no model at all and put `check --golden --fields model`
 * straight back to the "no baseline entry carries that data" refusal it was just
 * taught to avoid. A within-batch-only fix is inert against a real receiver.
 *
 * The invariant this restores: assembling a session from N batches yields the
 * same per-step models as receiving the whole session in one batch.
 *
 * Two scoped statements rather than a walk over the trace in JS. Steps are
 * renumbered by start time on merge, so `step_number` order IS time order, and
 * the fill is the mapper's own rule expressed over the assembled trace: take the
 * nearest model-bearing step BEFORE this one, and failing that (a step that ran
 * before the session ever reported a model) the session's first. The merge path
 * deliberately avoids O(trace) work per batch, so this stays in SQL, indexed by
 * `(trace_id, step_number)`, instead of pulling every step into JS.
 *
 * A trace that has no model anywhere leaves both subqueries NULL, so every step
 * stays null: an absent model still stays absent rather than becoming an
 * invented one. `decision` steps are excluded for the same reason as in the
 * mapper — a tool decision is the user's or the policy's call, not the model's.
 *
 * Span batches are excluded: a span carries its own model attribute, and a span
 * without one is stating that it had none rather than inheriting a neighbour's.
 */
function batchModel(input: MappedOtelTrace): string | undefined {
  const m = input.metadata?.model;
  return typeof m === 'string' && m ? m : undefined;
}

function fillLogStepModels(
  db: Database.Database,
  traceId: string,
  priorModel: unknown,
  thisBatchModel: string | undefined,
): void {
  // 1. The nearest model-bearing step BEFORE this one — the mapper's own rule,
  //    expressed over the assembled trace.
  db.prepare(
    `UPDATE agent_trace_steps
        SET model = (SELECT p.model FROM agent_trace_steps p
                      WHERE p.trace_id = agent_trace_steps.trace_id AND p.model IS NOT NULL
                        AND p.step_number < agent_trace_steps.step_number
                      ORDER BY p.step_number DESC LIMIT 1)
      WHERE trace_id = ? AND model IS NULL AND step_type IN ('tool_call', 'llm_call')
        AND EXISTS (SELECT 1 FROM agent_trace_steps p
                     WHERE p.trace_id = agent_trace_steps.trace_id AND p.model IS NOT NULL
                       AND p.step_number < agent_trace_steps.step_number)`,
  ).run(traceId);

  const fillRemaining = (model: string) =>
    db
      .prepare(
        `UPDATE agent_trace_steps SET model = ?
          WHERE trace_id = ? AND model IS NULL AND step_type IN ('tool_call', 'llm_call')`,
      )
      .run(model, traceId);

  // 2. Otherwise the model in effect when this batch opened. These are the steps
  //    that ran before this batch reported a model of its own — almost always the
  //    ordinary case, since the model-call records that would have stamped them
  //    were flushed in an earlier batch and produce no step to inherit from.
  if (typeof priorModel === 'string' && priorModel) fillRemaining(priorModel);

  // 3. Otherwise this batch's model, for steps that ran before the session had
  //    reported any model at all (a receiver started mid-session, an out-of-order
  //    flush). The same backward seed the mapper applies inside one batch.
  //    A session that has never reported a model reaches neither branch, so its
  //    steps stay null — an absent model stays absent rather than invented.
  if (thisBatchModel) fillRemaining(thisBatchModel);

  // Move the cursor on. The metadata merge lets EXISTING keys win (so an upgrade
  // cannot rewrite a root's identity), which would freeze this at the session's
  // first model and then label a step that ran after a fallback with the model
  // the session no longer used. This key is the receiver's own running value, so
  // it is written explicitly.
  if (thisBatchModel) {
    db.prepare(`UPDATE agent_traces SET metadata = json_set(metadata, '$.model', ?) WHERE id = ?`)
      .run(thisBatchModel, traceId);
  }
}

function ingestOtlpTraces(
  db: Database.Database,
  otlp: Record<string, unknown>,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  // Mapping is a pure transform of client-supplied structure. A malformed body
  // (e.g. a non-array `resourceSpans`/`scopeSpans`/`spans`, which `?? []` does
  // not guard against) throws here and must answer 400, not fall through to the
  // outer 500 — a 5xx tells OTLP exporters to retry the same bad batch forever.
  let traces: MappedOtelTrace[];
  try {
    // Walked purely to reject a malformed body: a non-array resourceSpans /
    // scopeSpans / spans is not iterable, so this throws exactly where
    // mapOtlpTraces would, before anything is written.
    countSpans(otlp);
    traces = mapOtlpTraces(otlp);
  } catch {
    return { status: 400, payload: { error: 'invalid OTLP body: resourceSpans/scopeSpans/spans must be arrays' } };
  }
  // DB writes are server-side: let them propagate to a 500. One transaction for
  // the WHOLE batch, though — without it, a failure part way through a
  // multi-trace payload left the earlier traces committed and answered 500, and
  // a 5xx tells an OTLP exporter to retry the same batch. On redelivery
  // findMergeTarget found those committed traces and merged the same spans
  // again — steps duplicated and tokens doubled, permanently, because duplicate
  // deliveries are deliberately not de-duplicated. All-or-nothing makes the
  // retry safe instead. (better-sqlite3 nests via savepoints, so the per-trace
  // transactions inside still work.)
  storeOtelBatch(db, traces, stats);

  // No partial_success on this endpoint, deliberately: the span path rejects
  // NOTHING. Every span becomes a step or a trace — `flattenSpans` drops none,
  // and a span with no trace id is deliberately kept as its own synthetic trace
  // rather than refused (grouping the id-less ones together would fuse
  // unrelated services, so each gets its own). There is therefore no count of
  // dropped spans to report.
  //
  // This used to answer `partialSuccess: { rejectedSpans: totalSpans }` when the
  // batch mapped to zero traces, explained as "spans genuinely undecodable (no
  // traceId → dropped in flatten)". That reason stopped being true when the
  // id-less span became a synthetic trace, and with every span yielding a trace
  // the condition cannot hold at all — an unreachable branch promising a
  // report this endpoint can never make. The /v1/logs endpoint DOES report
  // partial_success, and honestly: its mapper keeps only `gemini_cli.*` /
  // `claude_code.*` events, so records really are discarded there and the count
  // is real. The difference between the two endpoints is the mappers, not an
  // oversight here.
  //
  // A span id repeated inside one batch is dropped, but that is a REDELIVERY
  // and not a rejection — the merge path drops a span id it has already stored
  // for the same reason and is likewise silent, so reporting one and not the
  // other would make an exporter's retry look like data loss.
  return { status: 200, payload: {} };
}

/** Handle one OTLP/JSON logs export (Gemini CLI / Claude Code log events). */
export function handleLogsExport(
  db: Database.Database,
  body: string,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  let otlp: unknown;
  try {
    otlp = JSON.parse(body);
  } catch {
    return { status: 400, payload: { error: 'invalid JSON body' } };
  }
  if (!isPlainObject(otlp)) {
    return { status: 400, payload: { error: 'invalid OTLP body: expected a JSON object' } };
  }
  return ingestOtlpLogs(db, otlp, stats);
}

/** Handle one OTLP/protobuf logs export (Gemini CLI / Claude Code log events). */
export function handleLogsExportProtobuf(
  db: Database.Database,
  body: Buffer,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  let otlp: Record<string, unknown>;
  try {
    otlp = decodeLogsData(body);
  } catch {
    return { status: 400, payload: { error: 'invalid protobuf body' } };
  }
  return ingestOtlpLogs(db, otlp, stats);
}

function ingestOtlpLogs(
  db: Database.Database,
  otlp: Record<string, unknown>,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  // As in ingestOtlpTraces: a malformed body (non-array resourceLogs/scopeLogs/
  // logRecords) throws in the pure mapping step and must answer 400, not 500.
  let traces: IngestTraceInput[];
  let totalRecords: number;
  try {
    totalRecords = countLogRecords(otlp);
    traces = mapOtlpLogs(otlp);
  } catch {
    return { status: 400, payload: { error: 'invalid OTLP body: resourceLogs/scopeLogs/logRecords must be arrays' } };
  }
  // All-or-nothing, for the same reason as the traces endpoint above: a partial
  // commit plus the exporter's retry duplicates everything it already stored.
  storeOtelBatch(db, traces, stats);
  // The traces endpoint reports partial_success when a batch mapped to nothing;
  // this one answered a bare 200 unconditionally. mapOtlpLogs keeps only
  // `gemini_cli.*` / `claude_code.*` events, so an emitter whose event names
  // drift — a CLI version change, a generic OTel logger — got a clean 200
  // forever while the store stayed empty and shutdown printed "Accepted 0
  // trace(s)", with nothing anywhere to debug against.
  // Report a PARTIAL rejection too, not only a total one.
  //
  // The guard used to be `traces.length === 0`, which answers a bare 200
  // whenever anything at all was recognized — but the drift this exists to
  // surface is normally partial: a CLI version bump renames some events and
  // keeps others, and those records were discarded under a clean 200 with
  // nothing anywhere to debug against. OTLP's `partialSuccess` is exactly the
  // field for "accepted, minus these", so say how many.
  const recognized = countRecognizedLogRecords(otlp);
  const rejected = totalRecords - recognized;
  if (rejected > 0) {
    return {
      status: 200,
      payload: {
        partialSuccess: {
          rejectedLogRecords: rejected,
          errorMessage:
            recognized === 0
              ? 'no recognized log events in batch (expected gemini_cli.* or claude_code.*)'
              : `${rejected} of ${totalRecords} log record(s) were not recognized events (expected gemini_cli.* or claude_code.*)`,
        },
      },
    };
  }
  return { status: 200, payload: {} };
}

/** Start the OTLP/HTTP receiver. Resolves once listening. */
export function startOtelReceiver(db: Database.Database, port: number, stats: OtelStats): Promise<OtelReceiverHandle> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const contentType = req.headers['content-type'] ?? '';

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const isTraces = url.startsWith('/v1/traces');
    const isLogs = url.startsWith('/v1/logs');
    if (!isTraces && !isLogs) {
      res.writeHead(404).end();
      return;
    }
    const isProtobuf = contentType.includes('application/x-protobuf');

    try {
      const raw = await readBody(req);
      if (isProtobuf) {
        // Over protobuf: decode, then respond with an empty ExportServiceResponse
        // (zero bytes) on success per the spec, in the encoding received.
        const { status, payload } = isLogs
          ? handleLogsExportProtobuf(db, raw, stats)
          : handleTracesExportProtobuf(db, raw, stats);
        if (status === 200) {
          res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end(Buffer.alloc(0));
          return;
        }
        // A failure says why. This destructured `status` alone and answered a
        // 400 with ZERO BYTES — the handler had already computed "invalid
        // protobuf body", and it was thrown away, so an exporter got a bare 400
        // and its operator had nothing to go on. The JSON path returns the
        // reason, and the catch below already answers a protobuf request with a
        // JSON error body; this was the one failure path that said nothing.
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        return;
      }
      const body = raw.toString('utf-8');
      const { status, payload } = isLogs ? handleLogsExport(db, body, stats) : handleTracesExport(db, body, stats);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // Close the connection after an error response. In the oversized-body case
      // the client may still be streaming a body we stopped reading; `Connection:
      // close` makes Node flush this response and then tear the socket down,
      // instead of trying to keep-alive (which would need the unread body drained)
      // — so the client actually receives the status (e.g. 413) rather than a reset.
      res
        .writeHead(status, { 'content-type': 'application/json', connection: 'close' })
        .end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  return new Promise((resolvePromise) => {
    // Loopback only. Node defaults to :: / 0.0.0.0, so a receiver this module
  // calls "local" — and whose banner prints http://localhost — accepted
  // unauthenticated writes from any host on the network: anyone could inject
  // traces into the user's store, or spend the 32 MB body budget. An exporter on
  // another machine is a deliberate setup that needs a deliberate proxy.
  server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({
        server,
        port: boundPort,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
