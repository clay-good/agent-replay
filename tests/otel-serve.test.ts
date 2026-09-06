import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anyStr, keyValue, span, tracesData, logRecord, logsData } from './helpers/otlp-protobuf.js';

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

/**
 * Same, but with the receiver's stderr captured — for the console notices the
 * server prints about requests it refuses. `stdio: 'ignore'` in `startReceiver`
 * would throw them away.
 */
async function startReceiverCapturingStderr(): Promise<{ base: string; stderr: () => string }> {
  const port = await freePort();
  let err = '';
  server = spawn(process.execPath, [CLI, 'otel', 'serve', '--port', String(port), '--dir', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (probe.ok) return { base, stderr: () => err };
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

  it('rejects a gzip bomb with 413 instead of exhausting memory', async () => {
    const url = await startReceiver();
    // ~65 MB of highly compressible data gzips to a few KB but decompresses past
    // the receiver's cap, so it must be rejected (413, not retryable) rather than
    // OOM the process. The compressed body sent over the wire stays tiny.
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024, 0x41));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: bomb,
    });
    expect(res.status).toBe(413);
  }, 20000);

  it('rejects an oversized uncompressed body with a real 413, not a connection reset', async () => {
    const url = await startReceiver();
    // A >32 MB uncompressed body exceeds the raw-body cap. The receiver must
    // answer 413 (not retryable), NOT reset the socket — a reset is retryable to
    // OTLP exporters, so they'd resend the oversized batch forever. Use a raw
    // http request so the response status is observed even if the server responds
    // and closes while the 33 MB body is still being written.
    const big = Buffer.alloc(33 * 1024 * 1024, 0x20); // 33 MB
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      let responded = false;
      const req = httpRequest(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => { responded = true; res.resume(); resolve(res.statusCode ?? 0); },
      );
      // A write error is EXPECTED here and is not the thing under test: the
      // server answers 413 and closes while the 33 MB body is still uploading,
      // so the upload takes EPIPE/ECONNRESET. Racing that error against the
      // response on a fixed timer flaked under parallel load (the response can
      // take longer than any timer to be scheduled) and read as a receiver
      // regression. Instead, remember the error and only fail once the socket is
      // fully closed with no response — by then a sent response has already been
      // emitted, so this is deterministic rather than timing-dependent.
      let writeError: Error | undefined;
      req.on('error', (e) => { writeError = e; });
      req.on('close', () => {
        if (responded) return;
        setImmediate(() => {
          if (!responded) reject(writeError ?? new Error('socket closed with no response'));
        });
      });
      req.end(big);
    });
    expect(status).toBe(413);
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

  it('says why it rejected a protobuf body, instead of a bare 400', async () => {
    // Regression: `handle` destructured `status` alone from the protobuf
    // handlers and answered a failure with ZERO BYTES. The reason — "invalid
    // protobuf body" — had already been computed and was thrown away, so an
    // exporter got a bare 400 and its operator had nothing to go on. Every
    // sibling path explains itself, including the catch three lines below,
    // which already answers a protobuf request with a JSON error body.
    const url = await startReceiver();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid protobuf body' });

    // The logs endpoint answers the same way.
    const logsRes = await fetch(url.replace('/v1/traces', '/v1/logs'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    });
    expect(logsRes.status).toBe(400);
    expect(await logsRes.json()).toEqual({ error: 'invalid protobuf body' });
  }, 20000);

  it('accepts an OTLP/protobuf logs export over HTTP', async () => {
    const url = await startReceiver();
    const logsUrl = url.replace('/v1/traces', '/v1/logs');
    const body = logsData([
      logRecord({ eventName: 'gemini_cli.user_prompt', time: 1_000_000n, body: anyStr('hi'), attrs: [
        keyValue('session.id', anyStr('proto-log-sess')),
        keyValue('prompt', anyStr('hi')),
      ] }),
      logRecord({ eventName: 'gemini_cli.tool_call', time: 2_000_000n, attrs: [
        keyValue('session.id', anyStr('proto-log-sess')),
        keyValue('function_name', anyStr('run_shell')),
        keyValue('function_args', anyStr('{}')),
      ] }),
    ]);
    const res = await fetch(logsUrl, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-protobuf');
    expect((await res.arrayBuffer()).byteLength).toBe(0);

    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    try {
      const trace = db.prepare('SELECT agent_name FROM agent_traces WHERE session_id = ?').get('proto-log-sess') as
        | { agent_name: string }
        | undefined;
      expect(trace?.agent_name).toBe('gemini'); // decoded from protobuf logs and mapped
      const steps = db.prepare("SELECT COUNT(*) c FROM agent_trace_steps WHERE step_type = 'tool_call'").get() as { c: number };
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

    // A well-typed top-level object whose repeated fields are the wrong type is
    // still malformed. `?? []` guards only null/undefined, so a non-array here
    // used to iterate a non-iterable and 500. Every quadrant must answer 400.
    const logsUrl = url.replace('/v1/traces', '/v1/logs');
    expect((await post(json, '{"resourceSpans":{}}')).status).toBe(400);
    expect((await post(json, '{"resourceSpans":[{"scopeSpans":5}]}')).status).toBe(400);
    expect((await fetch(logsUrl, { method: 'POST', headers: json, body: '{"resourceLogs":{}}' })).status).toBe(400);
    expect((await fetch(logsUrl, { method: 'POST', headers: json, body: '{"resourceLogs":[{"scopeLogs":[{"logRecords":5}]}]}' })).status).toBe(400);

    // An empty OTLP object is still a valid (empty) batch → 200.
    expect((await post(json, '{}')).status).toBe(200);
  }, 20000);

  it('explains a request it does not route, instead of a bodyless 404/405', async () => {
    // Regression: an unknown path and a non-POST method were both answered with
    // `res.writeHead(404).end()` — zero bytes, no `Allow`, and nothing on the
    // server console. The case that makes it matter is not a typo: the
    // exporters the README configures take a BASE endpoint and append the
    // signal path themselves, so a harness with its metrics exporter left on
    // `otlp` POSTs /v1/metrics every interval into silence on both sides.
    const url = await startReceiver();
    const base = url.replace('/v1/traces', '');

    const metrics = await fetch(`${base}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceMetrics":[]}',
    });
    expect(metrics.status).toBe(404);
    const metricsBody = await metrics.json() as { error: string; accepts: string[] };
    // Named, not merely "not found": /v1/metrics is a real OTLP signal this
    // receiver deliberately does not ingest, and the reader must be able to
    // tell that from a mistyped path.
    expect(metricsBody.error).toMatch(/metrics/i);
    expect(metricsBody.error).toMatch(/dropped/i);
    expect(metricsBody.accepts).toEqual(['POST /v1/traces', 'POST /v1/logs']);

    // A path that is simply not an endpoint says so, and says what is.
    const typo = await fetch(`${base}/v1/trace`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(typo.status).toBe(404);
    const typoBody = await typo.json() as { error: string; accepts: string[] };
    expect(typoBody.error).toContain('/v1/trace');
    expect(typoBody.error).not.toMatch(/metrics/i);
    expect(typoBody.accepts).toEqual(['POST /v1/traces', 'POST /v1/logs']);

    // A wrong METHOD on a real endpoint carries `Allow`, which a bare 405 owes
    // an HTTP client and did not have.
    const get = await fetch(`${base}/v1/traces`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(((await get.json()) as { error: string }).error).toMatch(/POST/);
  }, 20000);

  it('announces a repeating refused export once, and keeps ingesting traces', async () => {
    // A metrics exporter posts on a fixed interval for the life of the session.
    // The operator has to learn the exports are being dropped, but a line per
    // request would bury the trace activity this console exists to show — so
    // the notice is once per method+path, and nothing else is disturbed.
    const { base, stderr } = await startReceiverCapturingStderr();
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"resourceMetrics":[]}',
      });
      expect(res.status).toBe(404);
    }
    // A real export on the same receiver still lands.
    const ok = await fetch(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: OTLP_PAYLOAD,
    });
    expect(ok.status).toBe(200);

    await sleep(300);
    const lines = stderr().split('\n').filter((l) => l.includes('/v1/metrics'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no metric target/);
    // The notice has to leave the reader able to act, not just informed.
    expect(stderr()).toMatch(/OTEL_METRICS_EXPORTER=none/);

    server?.kill('SIGTERM');
    await sleep(300);
    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM agent_traces').get() as { n: number };
    db.close();
    expect(row.n).toBe(1);
  }, 20000);

  it('says when another capture path already has this session', async () => {
    // The README documents both the hook and the OTel exporter for the same
    // harness, and `findMergeTarget` scopes its lookup by source_format — for
    // good reason, since the two paths' steps mean different things. So turning
    // both on gives TWO traces per session, same agent, same session id, and
    // every store-wide count doubles. Nothing said so.
    const { base, stderr } = await startReceiverCapturingStderr();
    const sessionId = 'sess-two-paths';
    // A trace from a DIFFERENT capture path, already in the store.
    const seed = new Database(join(dir, 'traces.db'));
    seed.pragma('foreign_keys = ON');
    runMigrations(seed);
    ingestTrace(seed, {
      agent_name: 'claude-code', status: 'running', session_id: sessionId,
      input: { prompt: 'hi' },
      metadata: { dialect: 'claude-code' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'Bash' }],
    } as never);
    seed.close();

    const logs = JSON.stringify({
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: '1750000000000000000',
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
            { key: 'session.id', value: { stringValue: sessionId } },
            { key: 'model', value: { stringValue: 'claude-opus-5' } },
            { key: 'input_tokens', value: { intValue: '120' } },
          ],
        }] }],
      }],
    });
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/v1/logs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: logs,
      });
      expect(res.status).toBe(200);
    }

    await sleep(300);
    // Once per session, however many batches arrive.
    const lines = stderr().split('\n').filter((l) => l.includes('already captured by another path'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(sessionId);
    expect(stderr()).toMatch(/double every store-wide count/);
  }, 20000);

  it('announces an export it could not store, once per reason', async () => {
    // A mistyped path was announced; a DROPPED batch was not. A store that has
    // gone read-only (or a full disk) answers every export with a 500 the
    // exporter sees and the operator does not, so a receiver that has stored
    // nothing for hours looks exactly like a quiet one — the only console line
    // was at Ctrl-C, after the run it was meant to capture.
    const { base, stderr } = await startReceiverCapturingStderr();
    // Break the store under the running receiver, the way a read-only mount, a
    // full disk or a damaged file does — dropping the table the insert needs is
    // the deterministic version of all three, and reaches the same code path.
    const breaker = new Database(join(dir, 'traces.db'));
    breaker.exec('DROP TABLE agent_traces');
    breaker.close();
    {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: OTLP_PAYLOAD,
        });
        expect(res.status).toBe(500);
      }
      // A different failure is its own reason, and gets its own line.
      const bad = await fetch(`${base}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      expect(bad.status).toBe(400);

      await sleep(300);
      const failures = stderr().split('\n').filter((l) => l.includes('export failed'));
      // Three identical failures, one line — the exporter retries on an interval.
      expect(failures).toHaveLength(2);
      expect(failures[0]).toMatch(/500: .*agent_traces/);
      expect(failures[0]).toMatch(/nothing from that batch was stored/);
      expect(failures[1]).toMatch(/400/);
    }
  }, 20000);

  it('does not double count a batch an exporter redelivers', async () => {
    // An OTLP exporter retries a batch it did not get a 200 for. The identity
    // ROOT was already guarded against re-adding itself, but the batch's CHILD
    // spans were appended unconditionally — so a lost 200, a client timeout
    // after commit, or the retry the receiver's own transaction plans for
    // permanently doubled the trace's steps AND its token total (the merge adds
    // the batch total to the running one).
    const url = await startReceiver();
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: OTLP_PAYLOAD,
      });
      expect(res.status).toBe(200);
    }

    const db = new Database(join(dir, 'traces.db'), { readonly: true });
    try {
      const trace = db
        .prepare('SELECT id, total_tokens FROM agent_traces WHERE session_id = ?')
        .get('conv-e2e') as { id: string; total_tokens: number | null } | undefined;
      expect(trace).toBeDefined();
      const after = db
        .prepare('SELECT COUNT(*) c FROM agent_trace_steps WHERE trace_id = ?')
        .get(trace!.id) as { c: number };
      // One delivery's worth of steps, not three.
      const single = db
        .prepare("SELECT COUNT(*) c FROM agent_trace_steps WHERE trace_id = ? AND step_type = 'llm_call'")
        .get(trace!.id) as { c: number };
      expect(single.c).toBe(1);
      expect(after.c).toBeLessThanOrEqual(2);
    } finally {
      db.close();
    }
  }, 30000);
});

describe('redelivery does not inflate the numbers either', () => {
  // The step dedupe landed and the TOKENS did not: the merge still received the
  // mapper's batch-wide totals, summed over every span the batch carried
  // including the ones just dropped. And a ROOT-ONLY retry — the common final
  // flush, since the root span ends last — carried no child steps at all, so it
  // slipped past a guard that required incoming spans. Both halves are asserted
  // here; the first version of this test never looked at total_tokens.
  it('keeps tokens and cost stable across a root-only retry', async () => {
    const url = await startReceiver();
    const child = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
        scopeSpans: [{ spans: [{
          traceId: 'ee', spanId: 'c9', parentSpanId: 'r9', name: 'chat',
          startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
          attributes: [
            { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
            { key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } },
            { key: 'gen_ai.usage.output_tokens', value: { intValue: '5' } },
            { key: 'gen_ai.usage.cost', value: { doubleValue: 0.25 } },
          ],
        }] }],
      }],
    });
    const root = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
        scopeSpans: [{ spans: [{
          traceId: 'ee', spanId: 'r9', name: 'invoke_agent',
          startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000002000000000',
          attributes: [
            { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
            { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
            { key: 'gen_ai.usage.output_tokens', value: { intValue: '50' } },
            { key: 'gen_ai.usage.cost', value: { doubleValue: 1.5 } },
          ],
        }] }],
      }],
    });
    const post = async (body: string): Promise<void> => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(res.status).toBe(200);
    };

    await post(child);
    await post(root);

    const read = (): { total_tokens: number | null; total_cost_usd: number | null; steps: number } => {
      const db = new Database(join(dir, 'traces.db'), { readonly: true });
      try {
        const t = db.prepare('SELECT id, total_tokens, total_cost_usd FROM agent_traces ORDER BY created_at DESC LIMIT 1')
          .get() as { id: string; total_tokens: number | null; total_cost_usd: number | null };
        const c = db.prepare('SELECT COUNT(*) c FROM agent_trace_steps WHERE trace_id = ?').get(t.id) as { c: number };
        return { total_tokens: t.total_tokens, total_cost_usd: t.total_cost_usd, steps: c.c };
      } finally {
        db.close();
      }
    };

    const before = read();
    expect(before.total_tokens).toBe(165);
    expect(before.total_cost_usd).toBeCloseTo(1.75, 8);

    // The retry the exporter sends when it never saw the 200.
    await post(root);
    const after = read();
    expect(after.total_tokens).toBe(before.total_tokens);
    expect(after.total_cost_usd).toBeCloseTo(before.total_cost_usd!, 8);
    expect(after.steps).toBe(before.steps);
  }, 30000);
});
