import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, listTraces } from '../src/services/trace-service.js';
import { mapOtlpTraces } from '../src/services/otel/semconv.js';
import { handleTracesExport, startOtelReceiver, type OtelStats } from '../src/services/otel/receiver.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

// ── OTLP/JSON construction helpers ─────────────────────────────────────────

function attr(key: string, value: unknown) {
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}
function span(s: {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  start: number; end?: number; attrs: Record<string, unknown>; error?: string;
}) {
  return {
    traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name,
    startTimeUnixNano: String(s.start), endTimeUnixNano: s.end ? String(s.end) : undefined,
    attributes: Object.entries(s.attrs).map(([k, v]) => attr(k, v)),
    status: s.error ? { code: 2, message: s.error } : undefined,
  };
}
function otlp(spans: unknown[], resource: Record<string, unknown> = {}) {
  return {
    resourceSpans: [
      { resource: { attributes: Object.entries(resource).map(([k, v]) => attr(k, v)) }, scopeSpans: [{ spans }] },
    ],
  };
}

const MS = 1_000_000; // nanos per ms

// ── GenAI span mapping ─────────────────────────────────────────────────────

describe('mapOtlpTraces (GenAI semconv)', () => {
  it('maps an agent span tree to a trace with hierarchy and token totals', () => {
    const payload = otlp([
      span({ traceId: 't1', spanId: 'root', name: 'invoke_agent', start: 1 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'planner', 'gen_ai.conversation.id': 'conv-1' } }),
      span({ traceId: 't1', spanId: 's1', parentSpanId: 'root', name: 'chat', start: 2 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20 } }),
      span({ traceId: 't1', spanId: 's2', parentSpanId: 's1', name: 'execute_tool', start: 3 * MS, end: 4 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ]);

    const [trace] = mapOtlpTraces(payload);
    expect(trace.agent_name).toBe('planner');
    expect(trace.session_id).toBe('conv-1');
    expect(trace.total_tokens).toBe(120);
    // The trace spans the earliest start (1ms) to the latest end (5ms), so it
    // carries a derived end time and duration rather than leaving them null.
    expect(trace.total_duration_ms).toBe(4);
    expect(trace.ended_at).toBe('1970-01-01T00:00:00.005Z');
    expect(trace.steps).toHaveLength(2);

    const [chat, tool] = trace.steps!;
    expect(chat.step_type).toBe('llm_call');
    expect(chat.model).toBe('gpt-4');
    expect(chat.tokens_used).toBe(120);
    expect(tool.step_type).toBe('tool_call');
    expect(tool.name).toBe('search');
    expect(tool.parent_step).toBe(1); // execute_tool nested under chat
  });

  it('normalizes deprecated attribute names (gen_ai.system, prompt_tokens)', () => {
    const payload = otlp([
      span({ traceId: 't2', spanId: 's1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'openai', 'gen_ai.usage.prompt_tokens': 1200, 'gen_ai.usage.completion_tokens': 300 } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.total_tokens).toBe(1500);
    expect(trace.steps![0].metadata!.provider).toBe('openai');
  });

  it('groups spans with no agent root into a synthetic trace per OTel trace ID', () => {
    const payload = otlp([
      span({ traceId: 'orphan', spanId: 's1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.session_id).toBeNull(); // conversation.id never synthesized
    expect(trace.metadata!.synthetic_trace).toBe(true);
    expect(trace.steps).toHaveLength(1);
  });

  it('falls back to OpenInference span kinds when GenAI attrs are absent', () => {
    const payload = otlp([
      span({ traceId: 't3', spanId: 's1', name: 'tool.execute', start: 1 * MS, end: 2 * MS, attrs: { 'openinference.span.kind': 'TOOL' } }),
      span({ traceId: 't3', spanId: 's2', name: 'llm', start: 2 * MS, end: 3 * MS, attrs: { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': 50, 'llm.token_count.completion': 10 } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.steps!.map((s) => s.step_type)).toEqual(['tool_call', 'llm_call']);
    expect(trace.total_tokens).toBe(60);
  });

  it('records span ERROR status as a step error and fails the trace', () => {
    const payload = otlp([
      span({ traceId: 't4', spanId: 's1', name: 'execute_tool', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool' }, error: 'tool blew up' }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.status).toBe('failed');
    expect(trace.steps![0].error).toBe('tool blew up');
  });
});

// ── Receiver ────────────────────────────────────────────────────────────────

describe('OTLP receiver', () => {
  it('ingests a traces export and answers 200 with an empty object', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const payload = otlp([
      span({ traceId: 't5', spanId: 'root', name: 'invoke_agent', start: 1 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'bot' } }),
      span({ traceId: 't5', spanId: 's1', parentSpanId: 'root', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ]);
    const res = handleTracesExport(db, JSON.stringify(payload), stats);
    expect(res.status).toBe(200);
    expect(res.payload).toEqual({});
    expect(listTraces(db, {}).total).toBe(1);
  });

  it('returns 400 on a malformed body', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    expect(handleTracesExport(db, '{not json', stats).status).toBe(400);
  });

  it('maps even an orphan span (no traceId) to a synthetic trace rather than rejecting it', () => {
    // flattenSpans normalizes a missing traceId to '' and every group becomes a
    // trace, so no counted span is ever dropped. (This is why the receiver's
    // partial_success branch is currently unreachable.)
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const payload = otlp([{ spanId: 'orphan', name: 'chat', startTimeUnixNano: '1', attributes: [] }]);
    const res = handleTracesExport(db, JSON.stringify(payload), stats);
    expect(res.status).toBe(200);
    expect(res.payload).toEqual({}); // full success, not partial
    expect(listTraces(db, {}).total).toBe(1);
  });

  it('maps each export batch independently (split traces are not reassembled — known limitation)', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // Batch 1: root + child for OTel trace "t7".
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't7', spanId: 'r', name: 'invoke_agent', start: 1 * MS, end: 9 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'batchbot' } }),
      span({ traceId: 't7', spanId: 'c1', parentSpanId: 'r', name: 'chat', start: 2 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);
    // Batch 2: a later child of the SAME OTel trace whose root isn't in this batch.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't7', spanId: 'c2', parentSpanId: 'r', name: 'execute_tool', start: 4 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ])), stats);

    // Two batches → two agent-replay traces today (no cross-batch assembly). If
    // that limitation is ever lifted, this expectation should change to 1.
    expect(listTraces(db, {}).total).toBe(2);
  });

  it('accepts a real OTLP/JSON POST over HTTP', async () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const handle = await startOtelReceiver(db, 0, stats);
    const payload = otlp([
      span({ traceId: 't6', spanId: 's1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ]);
    const resp = await fetch(`http://localhost:${handle.port}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(200);
    await handle.close();
    expect(listTraces(db, {}).total).toBe(1);
  }, 15000);
});

// ── OpenLLMetry (traceloop.*) fallback ─────────────────────────────────────

describe('mapOtlpTraces (OpenLLMetry traceloop.*)', () => {
  it('maps traceloop span kinds and llm.request.type', () => {
    const payload = otlp([
      span({ traceId: 'tl', spanId: 'root', name: 'my_workflow', start: 1 * MS, end: 5 * MS, attrs: { 'traceloop.span.kind': 'workflow', 'traceloop.entity.name': 'agent' } }),
      span({ traceId: 'tl', spanId: 's1', parentSpanId: 'root', name: 'search.tool', start: 2 * MS, end: 3 * MS, attrs: { 'traceloop.span.kind': 'tool', 'traceloop.entity.name': 'search' } }),
      span({ traceId: 'tl', spanId: 's2', parentSpanId: 'root', name: 'openai.chat', start: 3 * MS, end: 4 * MS, attrs: { 'llm.request.type': 'chat', 'gen_ai.usage.prompt_tokens': 40, 'gen_ai.usage.completion_tokens': 8 } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.steps!.map((s) => s.step_type)).toEqual(['tool_call', 'llm_call']);
    expect(trace.steps![0].name).toBe('search');
    expect(trace.total_tokens).toBe(48);
  });
});
