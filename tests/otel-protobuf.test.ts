import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { listTraces, getTrace } from '../src/services/trace-service.js';
import { decodeTracesData, decodeLogsData } from '../src/services/otel/protobuf.js';
import { mapOtlpTraces } from '../src/services/otel/semconv.js';
import { mapOtlpLogs } from '../src/services/otel/log-events.js';
import { handleTracesExportProtobuf, handleLogsExportProtobuf, type OtelStats } from '../src/services/otel/receiver.js';
import { tag, varintField, lenField, anyStr, anyInt, keyValue, span, tracesData, logRecord, logsData } from './helpers/otlp-protobuf.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

// ── Anchor: exact wire bytes for a known KeyValue ──────────────────────────

describe('protobuf wire format', () => {
  it('decodes a hand-encoded KeyValue with the OTLP field numbers', () => {
    // KeyValue{ key=1:"gen_ai.system", value=2: AnyValue{ string_value=1:"openai" } }
    const bytes = Buffer.from([
      0x0a, 0x0d, ...Buffer.from('gen_ai.system'),
      0x12, 0x08, 0x0a, 0x06, ...Buffer.from('openai'),
    ]);
    // Wrap as Resource{attributes=1: kv} → ResourceSpans → TracesData to reuse the decoder.
    const tracesData = lenField(1, lenField(1, lenField(1, bytes)));
    const decoded = decodeTracesData(tracesData) as any;
    const attr = decoded.resourceSpans[0].resource.attributes[0];
    expect(attr).toEqual({ key: 'gen_ai.system', value: { stringValue: 'openai' } });
  });

  it('decodes every AnyValue kind: bool, double, array, kvlist, and bytes', () => {
    // Real exporters send attribute values beyond strings/ints — a bool flag, a
    // double score, a string array, a nested kvlist, raw bytes. Each AnyValue
    // wire case must decode to the right shape (a wire-type mismatch here would
    // silently corrupt attributes read off untrusted protobuf input).
    const dbl = Buffer.alloc(8);
    dbl.writeDoubleLE(1.5);
    const attrs = [
      keyValue('flag', varintField(2, 1)), // AnyValue.bool_value = 2
      keyValue('temp', Buffer.concat([tag(4, 1), dbl])), // AnyValue.double_value = 4 (fixed64)
      keyValue('list', lenField(5, Buffer.concat([lenField(1, anyStr('a')), lenField(1, anyStr('b'))]))), // array_value = 5
      keyValue('nested', lenField(6, lenField(1, keyValue('k', anyStr('v'))))), // kvlist_value = 6
      keyValue('raw', lenField(7, Buffer.from([0xde, 0xad]))), // bytes_value = 7
    ];
    // Resource{ attributes = 1 (repeated) } → ResourceSpans{ resource = 1 } → TracesData{ resourceSpans = 1 }.
    const resource = Buffer.concat(attrs.map((kv) => lenField(1, kv)));
    const buf = lenField(1, lenField(1, resource));
    const decoded = decodeTracesData(buf) as any;
    const out = decoded.resourceSpans[0].resource.attributes;

    expect(out[0]).toEqual({ key: 'flag', value: { boolValue: true } });
    expect(out[1]).toEqual({ key: 'temp', value: { doubleValue: 1.5 } });
    expect(out[2]).toEqual({ key: 'list', value: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } } });
    expect(out[3]).toEqual({ key: 'nested', value: { kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } } });
    expect(out[4]).toEqual({ key: 'raw', value: { bytesValue: Buffer.from([0xde, 0xad]).toString('base64') } });
  });

  it('decodes int64 attribute values precisely, including negatives and > 2^53', () => {
    // A protobuf int64 encodes a negative value as a full 10-byte two's-complement
    // varint, and positive values can exceed 2^53. The numeric varint path lost
    // both (e.g. int_value -1 → ~1.84e19); the BigInt path must recover them.
    const varintBig = (n: bigint): Buffer => {
      const bytes: number[] = [];
      let v = BigInt.asUintN(64, n); // negatives → full 64-bit two's complement
      while (v > 0x7fn) { bytes.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
      bytes.push(Number(v));
      return Buffer.from(bytes);
    };
    const anyIntBig = (n: bigint) => Buffer.concat([tag(3, 0), varintBig(n)]); // AnyValue.int_value = 3
    const attrs = [
      keyValue('neg', anyIntBig(-1n)),
      keyValue('big', anyIntBig((1n << 53n) + 1n)), // 9007199254740993
    ];
    const resource = Buffer.concat(attrs.map((kv) => lenField(1, kv)));
    const decoded = decodeTracesData(lenField(1, lenField(1, resource))) as any;
    const out = decoded.resourceSpans[0].resource.attributes;
    expect(out[0]).toEqual({ key: 'neg', value: { intValue: '-1' } });
    expect(out[1]).toEqual({ key: 'big', value: { intValue: '9007199254740993' } });
  });
});

// ── Round-trip an encoded span tree through decode → map ───────────────────

describe('decodeTracesData → mapOtlpTraces', () => {
  it('decodes an agent span tree equivalently to the JSON path', () => {
    const buf = tracesData([
      span({ traceId: 'aa01', spanId: 'b1', name: 'invoke_agent', start: 1_000_000n, end: 5_000_000n, attrs: [
        keyValue('gen_ai.operation.name', anyStr('invoke_agent')),
        keyValue('gen_ai.agent.name', anyStr('planner')),
        keyValue('gen_ai.conversation.id', anyStr('conv-9')),
      ] }),
      span({ traceId: 'aa01', spanId: 'b2', parentSpanId: 'b1', name: 'chat', start: 2_000_000n, end: 3_000_000n, attrs: [
        keyValue('gen_ai.operation.name', anyStr('chat')),
        keyValue('gen_ai.request.model', anyStr('gpt-4')),
        keyValue('gen_ai.usage.input_tokens', anyInt(90)),
        keyValue('gen_ai.usage.output_tokens', anyInt(10)),
      ] }),
      span({ traceId: 'aa01', spanId: 'b3', parentSpanId: 'b1', name: 'execute_tool', start: 3_000_000n, end: 4_000_000n, attrs: [
        keyValue('gen_ai.operation.name', anyStr('execute_tool')),
        keyValue('gen_ai.tool.name', anyStr('search')),
      ], error: 'boom' }),
    ]);

    const [trace] = mapOtlpTraces(decodeTracesData(buf));
    expect(trace.agent_name).toBe('planner');
    expect(trace.session_id).toBe('conv-9');
    expect(trace.total_tokens).toBe(100);
    // The failed execute_tool span is a STEP error, not a run outcome — the
    // trace status now comes from the ROOT span, matching the other eight
    // capture paths and the telemetry-ingest spec. The failure is asserted
    // where it belongs, on the step, below.
    expect(trace.status).toBe('completed');
    expect(trace.steps!.map((s) => s.step_type)).toEqual(['llm_call', 'tool_call']);
    expect(trace.steps![0].model).toBe('gpt-4');
    expect(trace.steps!.some((st) => st.error != null)).toBe(true);
    expect(trace.steps![1].error).toBe('boom');
  });

  it('ingests a protobuf export through the receiver', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const buf = tracesData([
      span({ traceId: 'cc02', spanId: 's1', name: 'chat', start: 1_000_000n, end: 2_000_000n, attrs: [keyValue('gen_ai.operation.name', anyStr('chat'))] }),
    ]);
    const res = handleTracesExportProtobuf(db, buf, stats);
    expect(res.status).toBe(200);
    expect(listTraces(db, {}).total).toBe(1);
    expect(getTrace(db, listTraces(db, {}).items[0].id)!.steps).toHaveLength(1);
  });

  it('rejects a truncated protobuf body', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // A length-delimited field claiming more bytes than present.
    const res = handleTracesExportProtobuf(db, Buffer.from([0x0a, 0x7f, 0x01]), stats);
    expect(res.status).toBe(400);
  });
});

// ── Round-trip encoded log events through decode → map ─────────────────────

describe('decodeLogsData → mapOtlpLogs', () => {
  it('decodes a Gemini log batch equivalently to the JSON path', () => {
    const buf = logsData([
      logRecord({ eventName: 'gemini_cli.user_prompt', time: 1_000_000n, body: anyStr('list files'), attrs: [
        keyValue('session.id', anyStr('pg1')),
        keyValue('prompt', anyStr('list files')),
      ] }),
      logRecord({ eventName: 'gemini_cli.tool_call', time: 2_000_000n, attrs: [
        keyValue('session.id', anyStr('pg1')),
        keyValue('function_name', anyStr('run_shell')),
        keyValue('function_args', anyStr('{"cmd":"ls"}')),
        keyValue('decision', anyStr('reject')),
      ] }),
      logRecord({ eventName: 'gemini_cli.api_response', time: 3_000_000n, attrs: [
        keyValue('session.id', anyStr('pg1')),
        keyValue('input_token_count', anyInt(100)),
        keyValue('output_token_count', anyInt(20)),
      ] }),
    ]);

    const [t] = mapOtlpLogs(decodeLogsData(buf));
    expect(t.agent_name).toBe('gemini');
    expect(t.session_id).toBe('pg1');
    expect(t.input).toEqual({ prompt: 'list files' });
    expect(t.total_tokens).toBe(120);
    const tool = t.steps!.find((s) => s.step_type === 'tool_call')!;
    expect(tool.name).toBe('run_shell');
    expect(tool.input).toEqual({ cmd: 'ls' });
    const decision = t.steps!.find((s) => s.step_type === 'decision')!;
    expect(decision.decision!.chosen).toBe('reject');
  });

  it('ingests a protobuf logs export through the receiver', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const buf = logsData([
      logRecord({ eventName: 'claude_code.user_prompt', time: 1_000_000n, attrs: [
        keyValue('session.id', anyStr('pc1')),
        keyValue('prompt', anyStr('fix it')),
      ] }),
      logRecord({ eventName: 'claude_code.tool_result', time: 2_000_000n, attrs: [
        keyValue('session.id', anyStr('pc1')),
        keyValue('tool_name', anyStr('Bash')),
      ] }),
    ]);
    const res = handleLogsExportProtobuf(db, buf, stats);
    expect(res.status).toBe(200);
    const traces = listTraces(db, { session_id: 'pc1' });
    expect(traces.total).toBe(1);
    const t = getTrace(db, traces.items[0].id)!;
    expect(t.agent_name).toBe('claude-code');
    expect(t.steps.some((s) => s.step_type === 'tool_call' && s.name === 'Bash')).toBe(true);
  });

  it('rejects a truncated protobuf logs body', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleLogsExportProtobuf(db, Buffer.from([0x0a, 0x7f, 0x01]), stats);
    expect(res.status).toBe(400);
  });
});

// ── Span events over the protobuf transport ───────────────────────────────

/**
 * The decoder skipped Span.events (field 11) entirely, so a failure recorded
 * only via `recordException` — no `status` set — could not be reported at all
 * over protobuf, while the JSON transport could. The two transports must agree.
 */
describe('Span.events decoding', () => {
  it('surfaces a recordException failure sent as protobuf', () => {
    const body = tracesData([
      span({
        traceId: 'aa'.repeat(16), spanId: 'bb'.repeat(8), name: 'execute_tool',
        start: 1_000_000n, end: 2_000_000n,
        attrs: [keyValue('gen_ai.tool.name', anyStr('write'))],
        events: [{
          name: 'exception',
          attrs: [
            keyValue('exception.type', anyStr('ValueError')),
            keyValue('exception.message', anyStr('boom')),
          ],
        }],
      }),
    ]);

    const decoded = decodeTracesData(body) as Record<string, unknown>;
    const traces = mapOtlpTraces(decoded);
    expect(traces[0].status).toBe('failed');
    expect(traces[0].steps![0].error).toBe('boom');
  });

  it('leaves a span with no events alone', () => {
    const body = tracesData([
      span({
        traceId: 'aa'.repeat(16), spanId: 'cc'.repeat(8), name: 'execute_tool',
        start: 1_000_000n, end: 2_000_000n,
        attrs: [keyValue('gen_ai.tool.name', anyStr('read'))],
      }),
    ]);
    const traces = mapOtlpTraces(decodeTracesData(body) as Record<string, unknown>);
    expect(traces[0].status).toBe('completed');
    expect(traces[0].steps![0].error).toBeNull();
  });
});
