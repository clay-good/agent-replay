import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anyStr, keyValue, span, tracesData } from './helpers/otlp-protobuf.js';

/**
 * End-to-end test of the `otel serve` command: spawn the real OTLP/HTTP
 * receiver, POST an OTLP/JSON payload over the network, and confirm it lands as
 * a trace. Covers the command wiring (port parsing, server startup, live write)
 * that the receiver unit tests don't exercise.
 */

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let dir: string;
let server: ChildProcess | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OTLP_PAYLOAD = JSON.stringify({
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'aa',
              spanId: 'b1',
              name: 'invoke_agent',
              startTimeUnixNano: '1000000',
              endTimeUnixNano: '5000000',
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
                { key: 'gen_ai.agent.name', value: { stringValue: 'otel-e2e-bot' } },
                { key: 'gen_ai.conversation.id', value: { stringValue: 'conv-e2e' } },
              ],
            },
            {
              traceId: 'aa',
              spanId: 'b2',
              parentSpanId: 'b1',
              name: 'chat',
              startTimeUnixNano: '2000000',
              endTimeUnixNano: '3000000',
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }],
            },
          ],
        },
      ],
    },
  ],
});

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`built CLI not found at ${CLI}; run "npm run build" first`);
});

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'ar-otel-')), '.agent-replay');
  execFileSync(process.execPath, [CLI, 'init', '--dir', dir], { encoding: 'utf8' });
});

afterEach(() => {
  server?.kill('SIGTERM');
  server = undefined;
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

// Spawn the receiver and resolve its /v1/traces URL once it's listening.
async function startReceiver(): Promise<string> {
  const port = await freePort();
  server = spawn(process.execPath, [CLI, 'otel', 'serve', '--port', String(port), '--dir', dir], { stdio: 'ignore' });
  const url = `http://localhost:${port}/v1/traces`;
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (probe.ok) return url;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('otel receiver did not start');
}

describe('otel serve (end-to-end)', () => {
  it('accepts an OTLP/JSON export over HTTP and records it as a trace', async () => {
    const url = await startReceiver();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: OTLP_PAYLOAD,
    });
    expect(res.status).toBe(200);

    // The span tree is committed synchronously before the 200, so a reader sees it.
    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    try {
      const trace = db.prepare('SELECT agent_name, session_id FROM agent_traces WHERE session_id = ?').get('conv-e2e') as
        | { agent_name: string; session_id: string }
        | undefined;
      expect(trace?.agent_name).toBe('otel-e2e-bot');
      const steps = db.prepare("SELECT COUNT(*) c FROM agent_trace_steps WHERE step_type = 'llm_call'").get() as { c: number };
      expect(steps.c).toBe(1); // the chat span became an llm_call step
    } finally {
      db.close();
    }
  }, 20000);

  it('accepts a gzip-compressed OTLP export (as real exporters send)', async () => {
    const url = await startReceiver();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(OTLP_PAYLOAD)),
    });
    expect(res.status).toBe(200);

    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    try {
      const trace = db.prepare('SELECT agent_name FROM agent_traces WHERE session_id = ?').get('conv-e2e') as
        | { agent_name: string }
        | undefined;
      expect(trace?.agent_name).toBe('otel-e2e-bot'); // decompressed and mapped
    } finally {
      db.close();
    }
  }, 20000);

  it('accepts an OTLP/protobuf export over HTTP (the exporter default)', async () => {
    const url = await startReceiver();
    // invoke_agent root carries agent.name/conversation.id; a chat child becomes
    // an llm_call step — the same shape as the JSON test, encoded as protobuf.
    const body = tracesData([
      span({ traceId: 'aabb', spanId: '01', name: 'invoke_agent', start: 1_000_000n, end: 5_000_000n, attrs: [
        keyValue('gen_ai.operation.name', anyStr('invoke_agent')),
        keyValue('gen_ai.agent.name', anyStr('proto-e2e-bot')),
        keyValue('gen_ai.conversation.id', anyStr('proto-conv')),
      ] }),
      span({ traceId: 'aabb', spanId: '02', parentSpanId: '01', name: 'chat', start: 2_000_000n, end: 3_000_000n, attrs: [
        keyValue('gen_ai.operation.name', anyStr('chat')),
      ] }),
    ]);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-protobuf');
    // Success is an empty ExportTraceServiceResponse (zero bytes) per the spec.
    expect((await res.arrayBuffer()).byteLength).toBe(0);

    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    try {
      const trace = db.prepare('SELECT agent_name FROM agent_traces WHERE session_id = ?').get('proto-conv') as
        | { agent_name: string }
        | undefined;
      expect(trace?.agent_name).toBe('proto-e2e-bot'); // decoded from protobuf and mapped
      const steps = db.prepare("SELECT COUNT(*) c FROM agent_trace_steps WHERE step_type = 'llm_call'").get() as { c: number };
      expect(steps.c).toBe(1);
    } finally {
      db.close();
    }
  }, 20000);

  it('answers client-malformed payloads with 4xx, not 5xx (no retry storms)', async () => {
    const url = await startReceiver();
    const post = (headers: Record<string, string>, body: BodyInit) =>
      fetch(url, { method: 'POST', headers, body });
    const json = { 'content-type': 'application/json' };

    // Valid JSON that isn't an OTLP object must be 400, not a 500 from a
    // downstream property access. OTLP exporters retry 5xx but not 4xx, so a
    // 500 on un-processable input would loop the same bad batch forever.
    expect((await post(json, 'null')).status).toBe(400);
    expect((await post(json, '[1,2,3]')).status).toBe(400);
    expect((await post(json, '42')).status).toBe(400);
    // A body that claims gzip but isn't decompresses with an error → 400.
    expect((await post({ ...json, 'content-encoding': 'gzip' }, 'not-actually-gzip')).status).toBe(400);
    // The logs endpoint shares the guard.
    expect((await post(json, 'null').then(() => fetch(url.replace('/v1/traces', '/v1/logs'), { method: 'POST', headers: json, body: 'null' }))).status).toBe(400);

    // An empty OTLP object is still a valid (empty) batch → 200.
    expect((await post(json, '{}')).status).toBe(200);
  }, 20000);
});
