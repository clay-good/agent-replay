import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { listTraces, getTrace } from '../src/services/trace-service.js';
import { decodeTracesData } from '../src/services/otel/protobuf.js';
import { mapOtlpTraces } from '../src/services/otel/semconv.js';
import { handleTracesExportProtobuf, type OtelStats } from '../src/services/otel/receiver.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

// ── Independent minimal protobuf encoder (OTLP field numbers) ──────────────

function varint(n: number): Buffer {
  const b: number[] = [];
  while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  b.push(n);
  return Buffer.from(b);
}
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lenField = (field: number, buf: Buffer) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const strField = (field: number, s: string) => lenField(field, Buffer.from(s, 'utf8'));
const varintField = (field: number, n: number) => Buffer.concat([tag(field, 0), varint(n)]);
function fixed64Field(field: number, n: bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(n);
  return Buffer.concat([tag(field, 1), b]);
}
const anyStr = (s: string) => strField(1, s);           // AnyValue.string_value = 1
const anyInt = (n: number) => varintField(3, n);        // AnyValue.int_value = 3
const keyValue = (key: string, value: Buffer) => Buffer.concat([strField(1, key), lenField(2, value)]);

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
});

// ── Round-trip an encoded span tree through decode → map ───────────────────

function span(opts: {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  start: bigint; end: bigint; attrs: Buffer[]; error?: string;
}): Buffer {
  const parts = [
    lenField(1, Buffer.from(opts.traceId, 'hex')),
    lenField(2, Buffer.from(opts.spanId, 'hex')),
    ...(opts.parentSpanId ? [lenField(4, Buffer.from(opts.parentSpanId, 'hex'))] : []),
    strField(5, opts.name),
    fixed64Field(7, opts.start),
    fixed64Field(8, opts.end),
    ...opts.attrs.map((a) => lenField(9, a)),
    ...(opts.error ? [lenField(15, Buffer.concat([strField(2, opts.error), varintField(3, 2)]))] : []),
  ];
  return Buffer.concat(parts);
}
function tracesData(spans: Buffer[]): Buffer {
  const scopeSpans = Buffer.concat(spans.map((s) => lenField(2, s)));
  const resourceSpans = lenField(2, scopeSpans);
  return lenField(1, resourceSpans);
}

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
    expect(trace.status).toBe('failed'); // execute_tool span had ERROR status
    expect(trace.steps!.map((s) => s.step_type)).toEqual(['llm_call', 'tool_call']);
    expect(trace.steps![0].model).toBe('gpt-4');
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
