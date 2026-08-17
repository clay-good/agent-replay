import type Database from 'better-sqlite3';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ingestTrace, mergeBatchIntoTrace } from '../trace-service.js';
import type { IngestTraceInput } from '../../models/types.js';
import { mapOtlpTraces } from './semconv.js';
import { mapOtlpLogs } from './log-events.js';
import { decodeTracesData, decodeLogsData } from './protobuf.js';

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
           AND parent_trace_id IS NULL ORDER BY julianday(started_at) ASC, started_at ASC LIMIT 1`,
      )
      .get(otelTraceId) as { id: string } | undefined;
    return row?.id;
  }
  const sourceFormat = meta.source_format;
  if (input.session_id && typeof sourceFormat === 'string') {
    const row = db
      .prepare(
        `SELECT id FROM agent_traces WHERE session_id = ? AND json_extract(metadata, '$.source_format') = ?
           AND parent_trace_id IS NULL ORDER BY julianday(started_at) ASC, started_at ASC LIMIT 1`,
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
function storeOtelBatch(db: Database.Database, traces: IngestTraceInput[], stats: OtelStats): void {
  const accepted: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
  db.transaction(() => {
    for (const t of traces) upsertOtelTrace(db, t, accepted);
  }).immediate();
  stats.acceptedTraces += accepted.acceptedTraces;
  stats.acceptedSpans += accepted.acceptedSpans;
}

/** Merge a mapped batch into its existing trace, or open a new one. */
function upsertOtelTrace(db: Database.Database, input: IngestTraceInput, stats: OtelStats): void {
  const target = findMergeTarget(db, input);
  if (target) {
    mergeBatchIntoTrace(db, target, input);
  } else {
    ingestTrace(db, input);
    stats.acceptedTraces++;
  }
  stats.acceptedSpans += input.steps?.length ?? 0;
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
  let totalSpans: number;
  let traces: IngestTraceInput[];
  try {
    totalSpans = countSpans(otlp);
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

  // Root/agent spans define traces rather than steps, so mappedSpans can be
  // fewer than totalSpans without any rejection. Only report partial_success
  // when spans were genuinely undecodable (no traceId → dropped in flatten).
  const rejected = traces.length === 0 && totalSpans > 0 ? totalSpans : 0;
  if (rejected > 0) {
    return { status: 200, payload: { partialSuccess: { rejectedSpans: rejected, errorMessage: 'no mappable spans in batch' } } };
  }
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
  if (traces.length === 0 && totalRecords > 0) {
    return {
      status: 200,
      payload: {
        partialSuccess: {
          rejectedLogRecords: totalRecords,
          errorMessage: 'no recognized log events in batch (expected gemini_cli.* or claude_code.*)',
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
        const { status } = isLogs
          ? handleLogsExportProtobuf(db, raw, stats)
          : handleTracesExportProtobuf(db, raw, stats);
        res.writeHead(status, { 'content-type': 'application/x-protobuf' }).end(status === 200 ? Buffer.alloc(0) : undefined);
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
