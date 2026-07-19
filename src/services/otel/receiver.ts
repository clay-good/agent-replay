import type Database from 'better-sqlite3';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ingestTrace } from '../trace-service.js';
import { mapOtlpTraces } from './semconv.js';
import { mapOtlpLogs } from './log-events.js';

/**
 * Minimal local OTLP/HTTP receiver. This slice accepts `POST /v1/traces` in the
 * `application/json` (OTLP/JSON) encoding, maps GenAI-semconv spans to traces,
 * and stores them live. Per the OTLP spec it answers 200 with an empty object
 * on success and 200 with `partial_success` when some spans could not be mapped.
 *
 * Not yet implemented in this slice: protobuf encoding and `POST /v1/logs`
 * (log-event mappers) — those return a clear 415/501 rather than silently
 * dropping data.
 */

export interface OtelReceiverHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export interface OtelStats {
  acceptedSpans: number;
  acceptedTraces: number;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let buf = Buffer.concat(chunks);
  if ((req.headers['content-encoding'] ?? '').includes('gzip')) buf = gunzipSync(buf);
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
  let otlp: Record<string, unknown>;
  try {
    otlp = JSON.parse(body);
  } catch {
    return { status: 400, payload: { error: 'invalid JSON body' } };
  }

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
  let otlp: Record<string, unknown>;
  try {
    otlp = JSON.parse(body);
  } catch {
    return { status: 400, payload: { error: 'invalid JSON body' } };
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
    if (contentType.includes('application/x-protobuf')) {
      res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'protobuf encoding not supported in this build; use OTLP/JSON' }));
      return;
    }

    try {
      const body = (await readBody(req)).toString('utf-8');
      const { status, payload } = isLogs ? handleLogsExport(db, body, stats) : handleTracesExport(db, body, stats);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
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
