import type Database from 'better-sqlite3';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ingestTrace } from '../trace-service.js';
import { mapOtlpTraces } from './semconv.js';
import { mapOtlpLogs } from './log-events.js';
import { decodeTracesData } from './protobuf.js';

/**
 * Local OTLP/HTTP receiver. Accepts `POST /v1/traces` in both OTLP/JSON and
 * OTLP/protobuf, and `POST /v1/logs` in JSON (log-event mappers), decoding gzip
 * when present. GenAI-semconv spans map to traces, with OpenInference and
 * OpenLLMetry fallbacks, and are stored live.
 *
 * Per the OTLP spec, success answers 200 with an empty body; client-malformed
 * input answers 4xx (not 5xx, which the spec makes retryable). The spec's
 * `partial_success` response is scaffolded but currently unreachable: every
 * span the receiver counts maps to at least a synthetic trace, so a batch never
 * resolves to zero traces. `POST /v1/logs` over protobuf is not supported and
 * returns 415.
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let buf = Buffer.concat(chunks);
  if ((req.headers['content-encoding'] ?? '').includes('gzip')) {
    // A body that claims gzip but isn't is a client mistake (400), not a server
    // fault (500) — a 500 would make OTLP exporters retry the bad payload.
    try {
      buf = gunzipSync(buf);
    } catch {
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

function ingestOtlpTraces(
  db: Database.Database,
  otlp: Record<string, unknown>,
  stats: OtelStats,
): { status: number; payload: Record<string, unknown> } {
  const totalSpans = countSpans(otlp);
  const traces = mapOtlpTraces(otlp);
  let mappedSpans = 0;
  for (const t of traces) {
    ingestTrace(db, t);
    mappedSpans += (t.steps?.length ?? 0);
    stats.acceptedTraces++;
  }
  stats.acceptedSpans += mappedSpans;

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
  const traces = mapOtlpLogs(otlp);
  for (const t of traces) {
    ingestTrace(db, t);
    stats.acceptedSpans += t.steps?.length ?? 0;
    stats.acceptedTraces++;
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
    if (isProtobuf && isLogs) {
      res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'protobuf log ingest not supported; use OTLP/JSON for logs' }));
      return;
    }

    try {
      const raw = await readBody(req);
      if (isProtobuf) {
        // Traces over protobuf: decode, then respond with an empty protobuf
        // ExportTraceServiceResponse (zero bytes) on success per the spec.
        const { status } = handleTracesExportProtobuf(db, raw, stats);
        res.writeHead(status, { 'content-type': 'application/x-protobuf' }).end(status === 200 ? Buffer.alloc(0) : undefined);
        return;
      }
      const body = raw.toString('utf-8');
      const { status, payload } = isLogs ? handleLogsExport(db, body, stats) : handleTracesExport(db, body, stats);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  return new Promise((resolvePromise) => {
    server.listen(port, () => {
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
