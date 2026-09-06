import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, listTraces } from '../src/services/trace-service.js';
import { mapOtlpTraces, attrsToMap, decodeAnyValue } from '../src/services/otel/semconv.js';
import { handleTracesExport, startOtelReceiver, unroutedRequest, type OtelStats } from '../src/services/otel/receiver.js';
import { validateTraceInput } from '../src/utils/validators.js';
import { forkTrace } from '../src/services/fork-service.js';

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

describe('attrsToMap / decodeAnyValue (OTLP/JSON attribute values)', () => {
  it('converts every AnyValue kind to its JS value', () => {
    const m = attrsToMap([
      { key: 's', value: { stringValue: 'hi' } },
      { key: 'i', value: { intValue: '42' } }, // JSON encodes 64-bit ints as strings
      { key: 'd', value: { doubleValue: 1.5 } },
      { key: 'b', value: { boolValue: true } },
      { key: 'arr', value: { arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } } },
      { key: 'kv', value: { kvlistValue: { values: [{ key: 'nested', value: { boolValue: false } }] } } },
    ]);
    expect(m).toEqual({ s: 'hi', i: 42, d: 1.5, b: true, arr: ['a', 2], kv: { nested: false } });
  });

  it('skips a keyless attribute and handles unknown/primitive values', () => {
    expect(attrsToMap([{ value: { stringValue: 'x' } }])).toEqual({}); // no key → skipped
    expect(attrsToMap(undefined)).toEqual({});
    expect(decodeAnyValue({ somethingElse: 1 })).toBeUndefined(); // unrecognized shape
    expect(decodeAnyValue('raw')).toBe('raw'); // non-object passes through
  });
});

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
    // A step span with no output messages must map to output null, not a bare
    // {} — same guard as the trace root. A spurious {} reads as truthy
    // downstream ("OUTPUT: {}" in summaries, golden stores {} not null).
    expect(tool.output).toBeNull();
  });

  it('maps a root with no output messages to output null, not an empty {}', () => {
    // messageContent returns {} (never null) when a span has no message attrs,
    // so a root carrying only input must yield output: null — a spurious {} reads
    // as truthy downstream (summary prints "OUTPUT: {}", golden stores {}).
    const payload = otlp([
      span({ traceId: 'noout', spanId: 'root', name: 'invoke_agent', start: 1 * MS, end: 5 * MS,
        attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'planner', 'gen_ai.input.messages': '[{"role":"user"}]' } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.output).toBeNull();
    // A present input is still carried, not nulled.
    expect(trace.input).toMatchObject({ messages: expect.anything() });
  });

  it('normalizes deprecated attribute names (gen_ai.system, prompt_tokens)', () => {
    const payload = otlp([
      span({ traceId: 't2', spanId: 's1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'openai', 'gen_ai.usage.prompt_tokens': 1200, 'gen_ai.usage.completion_tokens': 300 } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.total_tokens).toBe(1500);
    expect(trace.steps![0].metadata!.provider).toBe('openai');
  });

  it('leaves the trace duration null when a span has an end but no start', () => {
    // A span missing startTimeUnixNano flattens to nanos 0 and sorts first, so
    // the trace start is unknown. The total duration must stay null (consistent
    // with the undefined started_at and the null step duration), not compute
    // `end - 0` into an absurd epoch-based value.
    const payload = otlp([
      { traceId: 'nostart', spanId: 's1', name: 'chat', endTimeUnixNano: String(5 * MS),
        attributes: [attr('gen_ai.operation.name', 'chat')] },
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.started_at).toBeUndefined();
    expect(trace.total_duration_ms).toBeNull();
    expect(trace.steps![0].duration_ms).toBeNull();
  });

  it('derives trace start/duration from the earliest valid start when another span lacks one', () => {
    // A start-less span (nanos 0) must not steal the trace start — or step 1 —
    // from a fully-timed span. Start/duration come from the earliest VALID start.
    const payload = otlp([
      span({ traceId: 'mix', spanId: 'timed', name: 'chat', start: 2 * MS, end: 6 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
      { traceId: 'mix', spanId: 'nostart', name: 'execute_tool', endTimeUnixNano: String(4 * MS),
        attributes: [attr('gen_ai.operation.name', 'execute_tool')] },
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.started_at).toBe('1970-01-01T00:00:00.002Z'); // the valid 2ms start
    expect(trace.total_duration_ms).toBe(4); // 6ms end - 2ms start
    expect(trace.steps![0].name).toBe('chat'); // the timed span is step 1, not the start-less one
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

  it('classifies OpenLLMetry (traceloop.*) span kinds and an llm.request.type span', () => {
    // Documented OpenLLMetry support: workflow/agent anchor the trace, tool →
    // tool_call, task → thought, and an llm.request.type attribute marks an
    // inference (llm_call) span.
    const payload = otlp([
      span({ traceId: 'tl', spanId: 'root', name: 'workflow', start: 1 * MS, end: 5 * MS, attrs: { 'traceloop.span.kind': 'workflow' } }),
      span({ traceId: 'tl', spanId: 's1', parentSpanId: 'root', name: 'call_tool', start: 2 * MS, end: 3 * MS, attrs: { 'traceloop.span.kind': 'tool' } }),
      span({ traceId: 'tl', spanId: 's2', parentSpanId: 'root', name: 'subtask', start: 3 * MS, end: 4 * MS, attrs: { 'traceloop.span.kind': 'task' } }),
      span({ traceId: 'tl', spanId: 's3', parentSpanId: 'root', name: 'infer', start: 4 * MS, end: 5 * MS, attrs: { 'llm.request.type': 'chat' } }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.steps!.map((s) => s.step_type)).toEqual(['tool_call', 'thought', 'llm_call']);
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

  it('maps OpenInference and OpenLLMetry content, not just their span kinds', () => {
    // Regression: only the gen_ai.* content attributes were read, so a
    // LangChain / LlamaIndex app — the frameworks these conventions come from —
    // produced traces whose every step had `input: {}` and `output: null`. The
    // spans were classified, timed and token-counted correctly; they just
    // carried no content, and the raw attributes were preserved nowhere either.
    const payload = otlp([
      span({
        traceId: 'toi', spanId: 's1', name: 'ChatOpenAI', start: 1 * MS, end: 2 * MS,
        attrs: {
          'openinference.span.kind': 'LLM',
          'input.value': '{"messages":[{"role":"user","content":"hi"}]}',
          'output.value': '{"content":"hello"}',
          'llm.provider': 'openai',
          'llm.model_name': 'gpt-4o-mini',
        },
      }),
      span({
        traceId: 'toi', spanId: 's2', name: 'span-name-not-tool-name', start: 2 * MS, end: 3 * MS,
        attrs: { 'openinference.span.kind': 'TOOL', 'tool.name': 'search_flights' },
      }),
      span({
        traceId: 'toi', spanId: 's3', name: 'task', start: 3 * MS, end: 4 * MS,
        attrs: { 'traceloop.span.kind': 'task', 'traceloop.entity.input': 'do the thing' },
      }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    const [llm, tool, task] = trace.steps!;

    expect(llm.input).toEqual({ messages: '{"messages":[{"role":"user","content":"hi"}]}' });
    expect(llm.output).toEqual({ messages: '{"content":"hello"}' });
    expect(llm.model).toBe('gpt-4o-mini');
    expect(llm.metadata!.provider).toBe('openai');
    // A tool span is named by its tool, not by the raw span name.
    expect(tool.name).toBe('search_flights');
    expect(task.input).toEqual({ messages: 'do the thing' });
    // A span with no content still stores null output, not a spurious {}.
    expect(tool.output).toBeNull();
  });

  it('records span ERROR status as a step error and fails the trace', () => {
    const payload = otlp([
      span({ traceId: 't4', spanId: 's1', name: 'execute_tool', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool' }, error: 'tool blew up' }),
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.status).toBe('failed');
    expect(trace.steps![0].error).toBe('tool blew up');
  });

  it('fails the trace on an ERROR span even when status.message is empty', () => {
    // Some OTLP/JSON exporters set status.code=2 with an empty message (the
    // description field is optional). The empty string is not a "no error"
    // signal: the trace must still be marked failed and the step must carry a
    // non-empty error, rather than being silently recorded as completed.
    const payload = otlp([
      {
        traceId: 't-empty', spanId: 's1', name: 'execute_tool',
        startTimeUnixNano: String(1 * MS), endTimeUnixNano: String(2 * MS),
        attributes: [attr('gen_ai.operation.name', 'execute_tool'), attr('error.type', 'TimeoutError')],
        status: { code: 2, message: '' },
      },
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.status).toBe('failed');
    // Falls back to error.type when the message is empty.
    expect(trace.steps![0].error).toBe('TimeoutError');
  });

  it('marks an ERROR span with neither message nor error.type using a generic error', () => {
    const payload = otlp([
      {
        traceId: 't-bare', spanId: 's1', name: 'execute_tool',
        startTimeUnixNano: String(1 * MS), endTimeUnixNano: String(2 * MS),
        attributes: [attr('gen_ai.operation.name', 'execute_tool')],
        status: { code: 2, message: '' },
      },
    ]);
    const [trace] = mapOtlpTraces(payload);
    expect(trace.status).toBe('failed');
    expect(trace.steps![0].error).toBe('error');
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

  it('does not fuse orphan spans from different services into one trace', () => {
    // Regression: flattenSpans normalizes a missing traceId to '', and grouping
    // on that value put EVERY id-less span in the batch — across unrelated
    // resourceSpans entries — into a single trace, attributed to whichever
    // service sorted earliest, with both services' tokens summed. A collector
    // fanning two services in was enough to fabricate that trace. Orphans are
    // still mapped (not rejected), just never correlated with each other.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const orphan = (service: string, spanId: string) => ({
      resource: { attributes: [attr('service.name', service)] },
      scopeSpans: [{ spans: [{
        spanId, name: 'chat', startTimeUnixNano: String(MS), endTimeUnixNano: String(2 * MS),
        attributes: [attr('gen_ai.usage.input_tokens', 10)],
      }] }],
    });
    const res = handleTracesExport(
      db,
      JSON.stringify({ resourceSpans: [orphan('billing-svc', 'o1'), orphan('search-svc', 'o2')] }),
      stats,
    );

    expect(res.status).toBe(200);
    expect(res.payload).toEqual({}); // still full success — orphans are not rejected
    const names = listTraces(db, {}).items.map((t) => t.agent_name).sort();
    expect(names).toEqual(['billing-svc', 'search-svc']);
    // Neither trace absorbed the other's tokens.
    for (const t of listTraces(db, {}).items) expect(t.total_tokens).toBe(10);
  });

  it('assembles spans of one OTel trace arriving across batches into a single trace', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // Batch 1: root + first child for OTel trace "t7".
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't7', spanId: 'r', name: 'invoke_agent', start: 1 * MS, end: 9 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'batchbot' } }),
      span({ traceId: 't7', spanId: 'c1', parentSpanId: 'r', name: 'chat', start: 2 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 20 } }),
    ])), stats);
    // Batch 2: a later child of the SAME OTel trace whose parent (c1) shipped in
    // batch 1, and whose root is likewise absent from this batch.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't7', spanId: 'c2', parentSpanId: 'c1', name: 'execute_tool', start: 4 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search', 'gen_ai.usage.input_tokens': 40, 'gen_ai.usage.output_tokens': 20 } }),
    ])), stats);

    // One logical OTel trace → one agent-replay trace, not one per batch.
    expect(listTraces(db, {}).total).toBe(1);
    const trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    expect(trace.agent_name).toBe('batchbot');
    expect(trace.steps).toHaveLength(2);
    const [c1, c2] = trace.steps;
    // c2 arrived in a later batch but is re-linked to its parent c1 by span id.
    expect(c2.name).toBe('search');
    expect(c2.parent_step_number).toBe(c1.step_number);
    // Aggregates recompute over both batches: full window and summed tokens.
    expect(trace.total_tokens).toBe(180);
    expect(trace.started_at).toBe('1970-01-01T00:00:00.001Z');
    expect(trace.ended_at).toBe('1970-01-01T00:00:00.009Z');
  });

  it('assembles later batches into the original trace, never into a fork of it', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't8', spanId: 'r', name: 'invoke_agent', start: 1 * MS, end: 9 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'forkbot' } }),
      span({ traceId: 't8', spanId: 'c1', parentSpanId: 'r', name: 'chat', start: 2 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);
    const live = listTraces(db, {}).items[0].id;

    // A fork inherits the original's session_id and metadata, so it matches
    // both merge keys; only lineage distinguishes it from the real trace.
    const fork = forkTrace(db, live, 1);

    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't8', spanId: 'c2', parentSpanId: 'c1', name: 'execute_tool', start: 4 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ])), stats);

    expect(getTrace(db, live)!.steps.map((s) => s.name)).toContain('search');
    expect(getTrace(db, fork.forked_trace_id)!.steps.map((s) => s.name)).not.toContain('search');
  });

  it('keeps a second root span when it arrives in a later batch', () => {
    // A span exporter flushes inner spans first, so a multi-root trace (GenAI
    // emits create_agent before invoke_agent; multi-agent runs nest
    // invoke_agent) naturally splits with a root in a LATER batch. Each batch
    // independently promoted its own first root to trace identity and
    // contributed no step for it — and merging inserts only `steps`, so that
    // span produced NO ROW AT ALL: silently dropped, while the accepted-span
    // count still counted it. Whether a span survives must not depend on where
    // the exporter cut its batches.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't9', spanId: '2', parentSpanId: '1', name: 'invoke_agent', start: 2 * MS, end: 8 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'writer' } }),
      span({ traceId: 't9', spanId: '3', parentSpanId: '2', name: 'execute_tool', start: 3 * MS, end: 4 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ])), stats);

    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't9', spanId: '1', name: 'invoke_agent', start: 1 * MS, end: 9 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'researcher' } }),
    ])), stats);

    expect(listTraces(db, {}).total).toBe(1);
    const trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    const names = trace.steps.map((s) => s.name);
    expect(names).toContain('search');
    // The late root survives as a step rather than vanishing.
    expect(trace.steps.some((s) => s.metadata.otel_span_id === '1')).toBe(true);
    // All three spans are stored: one as the trace, two as steps. The counter
    // reports STEPS STORED (how `otel serve` labels it), and must match.
    expect(trace.steps).toHaveLength(2); // spans 3 and 1; span 2 is the trace
    expect(stats.acceptedSpans).toBe(2);
  });

  it('does not re-add its own identity root when a batch is redelivered', () => {
    // An OTLP exporter retries a batch it did not get a 200 for. Keeping a late
    // root as a step must not make the batch that OPENED the trace add its own
    // root back on redelivery — a trace containing a step that is itself.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const batch = JSON.stringify(otlp([
      span({ traceId: 'tA', spanId: '1', name: 'invoke_agent', start: 1 * MS, end: 9 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'solo' } }),
      span({ traceId: 'tA', spanId: '2', parentSpanId: '1', name: 'execute_tool', start: 2 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ]));
    handleTracesExport(db, batch, stats);
    handleTracesExport(db, batch, stats); // redelivery

    const trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    expect(trace.metadata.otel_span_id).toBe('1');
    // The trace's own identity span never appears as one of its steps.
    expect(trace.steps.some((s) => s.metadata.otel_span_id === '1')).toBe(false);
  });

  it('upgrades a rootless synthetic trace in place when the root batch arrives last', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // Batch 1: two children flush before the root ends → a synthetic trace.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't8', spanId: 'c1', parentSpanId: 'r', name: 'chat', start: 2 * MS, end: 3 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
      span({ traceId: 't8', spanId: 'c2', parentSpanId: 'c1', name: 'execute_tool', start: 4 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ])), stats);
    let trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    expect(trace.agent_name).toBe('otel-agent');
    expect(trace.metadata.synthetic_trace).toBe(true);

    // Batch 2: the root span finally ends and exports.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 't8', spanId: 'r', name: 'invoke_agent', start: 1 * MS, end: 9 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'latebot', 'gen_ai.conversation.id': 'conv-8' } }),
    ])), stats);

    expect(listTraces(db, {}).total).toBe(1);
    trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    expect(trace.agent_name).toBe('latebot'); // upgraded from otel-agent
    expect(trace.session_id).toBe('conv-8');
    expect(trace.metadata.synthetic_trace).toBeUndefined(); // no longer synthetic
    expect(trace.steps).toHaveLength(2);
    expect(trace.started_at).toBe('1970-01-01T00:00:00.001Z'); // widened to root start
    expect(trace.steps[1].parent_step_number).toBe(trace.steps[0].step_number);
  });

  it('re-links a child whose parent span flushed in a later batch', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // A parent span ends AFTER its children, so a deep child can flush in an
    // earlier batch than the parent that owns it. Batch 1: the tool span B ends
    // first; its parent llm span A has not flushed yet, so B lands parent-less.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'td', spanId: 'B', parentSpanId: 'A', name: 'execute_tool', start: 3 * MS, end: 4 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ])), stats);
    // Batch 2: the parent llm span A ends and flushes (its own parent is root).
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'td', spanId: 'A', parentSpanId: 'root', name: 'chat', start: 2 * MS, end: 7 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);
    // Batch 3: the agent root finally ends, upgrading the synthetic trace.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'td', spanId: 'root', name: 'invoke_agent', start: 1 * MS, end: 20 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'deepbot' } }),
    ])), stats);

    expect(listTraces(db, {}).total).toBe(1);
    const trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    const A = trace.steps.find((s) => s.name === 'chat')!;
    const B = trace.steps.find((s) => s.name === 'search')!;
    // B arrived before A but must be re-linked to A once A's batch arrives —
    // otherwise a deep trace crossing a flush boundary loses its hierarchy.
    expect(B.parent_step_number).toBe(A.step_number);
  });

  it('numbers an assembled trace by start time so the re-link points backward', () => {
    // Regression: batches arrive in COMPLETION order, but a parent span ends
    // after its children — so a late-flushing parent was numbered ABOVE the
    // child it owns, and the backward re-link wrote a FORWARD parent reference.
    // validateTraceInput rejects those, so `otel serve` persisted rows `ingest`
    // refuses (export → ingest hard-failed for exactly the deep traces this
    // assembly serves), and `why` / `show --tree` rendered step 1 as "caused by
    // #2". Numbering by start time satisfies both contracts at once: the parent
    // really did start first.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    // Batch 1: only the child (starts at 3ms, ends first).
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'tord', spanId: 'C', parentSpanId: 'P', name: 'execute_tool', start: 3 * MS, end: 4 * MS, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } }),
    ])), stats);
    // Batch 2: its parent, which STARTED EARLIER (2ms) but flushed later.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'tord', spanId: 'P', name: 'chat', start: 2 * MS, end: 7 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);

    const trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    const parent = trace.steps.find((s) => s.name === 'chat')!;
    const child = trace.steps.find((s) => s.name === 'search')!;

    // The hierarchy survives...
    expect(child.parent_step_number).toBe(parent.step_number);
    // ...and now points strictly backward, because the earlier-starting parent
    // is numbered first despite arriving second.
    expect(parent.step_number).toBeLessThan(child.step_number);
    expect(trace.steps.map((s) => s.step_number).sort((a, b) => a - b)).toEqual([1, 2]);

    // The assembled trace is something `ingest` will actually accept.
    expect(
      validateTraceInput({
        agent_name: trace.agent_name,
        steps: trace.steps.map((s) => ({
          step_number: s.step_number,
          step_type: s.step_type,
          name: s.name,
          parent_step: s.parent_step_number,
          caused_by_step: s.caused_by_step_number,
        })),
      } as never).valid,
    ).toBe(true);
  });

  it('never keeps a forward parent reference, even when start times tie', () => {
    // Renumbering by start time cannot resolve every case: span timestamps are
    // stored to MILLISECOND precision, so a parent and a child that start within
    // the same millisecond tie and the tie-break falls to arrival order —
    // leaving exactly the forward reference the renumbering exists to remove.
    // (Clock skew putting a parent's start after its child's does the same.)
    // Such a reference is what validateTraceInput rejects and what makes `why`
    // render step 1 as "caused by #2", so it must never survive.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const T = 20 * MS;
    // Child starts 0.2ms AFTER its parent — identical once truncated to ms.
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'ttie', spanId: 'C', parentSpanId: 'P', name: 'execute_tool', start: T + 200_000, end: T + 900_000, attrs: { 'gen_ai.operation.name': 'execute_tool' } }),
    ])), stats);
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'ttie', spanId: 'P', name: 'chat', start: T, end: T + 9 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);

    const trace = getTrace(db, listTraces(db, {}).items[0].id)!;
    for (const step of trace.steps) {
      if (step.parent_step_number != null) expect(step.parent_step_number).toBeLessThan(step.step_number);
      if (step.caused_by_step_number != null) expect(step.caused_by_step_number).toBeLessThan(step.step_number);
    }
    // And the result is something `ingest` will take back.
    expect(
      validateTraceInput({
        agent_name: trace.agent_name,
        steps: trace.steps.map((s) => ({
          step_number: s.step_number, step_type: s.step_type, name: s.name,
          parent_step: s.parent_step_number, caused_by_step: s.caused_by_step_number,
        })),
      } as never).valid,
    ).toBe(true);
  });

  it('keeps distinct OTel traces separate across batches', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'ta', spanId: 's1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);
    handleTracesExport(db, JSON.stringify(otlp([
      span({ traceId: 'tb', spanId: 's1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ])), stats);
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

describe('unroutedRequest', () => {
  it('names /v1/metrics as a signal with no target, not a missing path', () => {
    const r = unroutedRequest('POST', '/v1/metrics');
    expect(r.status).toBe(404);
    expect(r.payload.error).toMatch(/metrics/i);
    expect(r.payload.accepts).toEqual(['POST /v1/traces', 'POST /v1/logs']);
    // The notice has to leave the operator able to act, not merely informed.
    expect(r.notice.join(' ')).toMatch(/OTEL_METRICS_EXPORTER=none/);
  });

  it('offers Allow: POST on a wrong method, which a bare 405 owes an HTTP client', () => {
    const r = unroutedRequest('GET', '/v1/traces');
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
  });

  it('escapes and bounds the method and path it echoes back', () => {
    // Both come off the wire and are printed to the operator's terminal and
    // returned in a body, so they get the same treatment as any other value
    // this tool did not generate — the rule every render site in the CLI
    // follows. A long target must not push the explanation off the screen.
    const r = unroutedRequest('POST', '/v1/\u001b[2Jwiped');
    expect(String(r.payload.error)).not.toContain('\u001b');
    expect(r.notice.join(' ')).not.toContain('\u001b');

    const long = unroutedRequest('POST', '/v1/' + 'a'.repeat(500));
    expect(String(r.payload.error).length).toBeLessThan(300);
    expect(String(long.payload.error).length).toBeLessThan(300);
    // Matching still happens on the RAW path; the escaped copy is display only.
    expect(unroutedRequest('POST', '/v1/metrics?x=' + 'b'.repeat(500)).payload.error).toMatch(/metrics/i);
  });
});

describe('mapOtlpTraces — an unrenderable span timestamp', () => {
  // The end/start sets were built from RAW nanos while the formatter rejects a
  // stamp outside the four-digit-year window, so one absurd endTimeUnixNano gave
  // a trace with `ended_at: null` and a ~31-million-year duration on the same row.
  it('ignores a stamp it cannot render instead of deriving a duration from it', () => {
    const [trace] = mapOtlpTraces(otlp([
      span({ traceId: 'tz', spanId: 'z0', name: 'invoke_agent', start: 1 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'bot' } }),
      span({ traceId: 'tz', spanId: 'z1', parentSpanId: 'z0', name: 'chat', start: 2 * MS, end: 9e21, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ]));

    expect(trace.ended_at).toBe('1970-01-01T00:00:00.005Z');
    expect(trace.total_duration_ms).toBe(4);
    // The step itself still reports no end rather than a fabricated one.
    expect(trace.steps![0].ended_at).toBeNull();
  });
});

describe('mapOtlpTraces — span names inherited from Object.prototype', () => {
  // The step-type tables are plain object literals and their keys come from
  // untrusted telemetry: `gen_ai.operation.name`, and the span NAME's leading
  // word. A span named `constructor` or `toString` (an auto-instrumented JS class
  // method) used to resolve to a FUNCTION typed as string — it survived the
  // `?? 'thought'` fallback and reached the SQLite bind, rolling back the whole
  // batch's transaction and answering 500, which OTLP exporters retry forever.
  for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    it(`classifies a span named "${poison}" as an ordinary step and stores it`, () => {
      const [trace] = mapOtlpTraces(otlp([
        span({ traceId: 'tp', spanId: 'p1', name: poison, start: 1 * MS, end: 2 * MS, attrs: {} }),
      ]));
      expect(typeof trace.steps![0].step_type).toBe('string');
      expect(trace.steps![0].step_type).toBe('thought');
      expect(() => ingestTrace(db, trace)).not.toThrow();
    });

    it(`ignores a gen_ai.operation.name of "${poison}"`, () => {
      const [trace] = mapOtlpTraces(otlp([
        span({ traceId: 'to', spanId: 'o1', name: 'work', start: 1 * MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': poison } }),
      ]));
      expect(trace.steps![0].step_type).toBe('thought');
      expect(() => ingestTrace(db, trace)).not.toThrow();
    });
  }
});

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

// ── Failures that never touched span.status ───────────────────────────────

/**
 * Error detection keyed solely on `status.code`, missing the two other ways a
 * failure reaches us: an `exception` span event (what `recordException` writes,
 * and several instrumentations call it WITHOUT also setting the status) and an
 * `error.type` attribute (what GenAI semconv sets on a failed operation). A
 * span that captured its own exception was stored as a completed step on a
 * completed trace, with the exception text preserved nowhere at all.
 */
describe('mapOtlpTraces — failures not written to status', () => {
  function spanWith(extra: Record<string, unknown>) {
    return {
      traceId: 't1', spanId: 'b', name: 'execute_tool',
      startTimeUnixNano: String(MS), endTimeUnixNano: String(2 * MS),
      attributes: [], ...extra,
    };
  }

  it('treats an exception span event as a failure', () => {
    const traces = mapOtlpTraces(otlp([spanWith({
      events: [{
        name: 'exception',
        attributes: [attr('exception.type', 'ValueError'), attr('exception.message', 'boom')],
      }],
    })]) as never);
    expect(traces[0].status).toBe('failed');
    expect(traces[0].steps![0].error).toBe('boom');
  });

  it('falls back to the exception type when it carries no message', () => {
    const traces = mapOtlpTraces(otlp([spanWith({
      events: [{ name: 'exception', attributes: [attr('exception.type', 'ValueError')] }],
    })]) as never);
    expect(traces[0].steps![0].error).toBe('ValueError');
  });

  it('treats a bare error.type attribute as a failure', () => {
    const traces = mapOtlpTraces(otlp([spanWith({ attributes: [attr('error.type', '429')] })]) as never);
    expect(traces[0].status).toBe('failed');
    expect(traces[0].steps![0].error).toBe('429');
  });

  it('lets an explicit OK status win over the weaker signals', () => {
    const traces = mapOtlpTraces(otlp([spanWith({
      attributes: [attr('error.type', '429')],
      status: { code: 1 },
    })]) as never);
    expect(traces[0].status).toBe('completed');
    expect(traces[0].steps![0].error).toBeNull();
  });

  it('still prefers the status message when the status says ERROR', () => {
    const traces = mapOtlpTraces(otlp([spanWith({
      status: { code: 2, message: 'upstream 500' },
      events: [{ name: 'exception', attributes: [attr('exception.message', 'boom')] }],
    })]) as never);
    expect(traces[0].steps![0].error).toBe('upstream 500');
  });

  it('leaves a clean span alone', () => {
    const traces = mapOtlpTraces(otlp([spanWith({})]) as never);
    expect(traces[0].status).toBe('completed');
    expect(traces[0].steps![0].error).toBeNull();
  });
});

// ── Root-span data and out-of-order parentage ─────────────────────────────

describe('mapOtlpTraces — root span and parent ordering', () => {
  // Regression: totalTokens summed only the step spans, and stepMetadata was
  // never called for the root — so a single-span agent trace reported
  // total_tokens: null and recorded no model or provider at all.
  it("counts the root span's own tokens and keeps its attributes", () => {
    const traces = mapOtlpTraces(otlp([
      span({
        traceId: 't1', spanId: 'a', name: 'invoke_agent', start: MS, end: 2 * MS,
        attrs: {
          'gen_ai.usage.input_tokens': 100,
          'gen_ai.usage.output_tokens': 50,
          'gen_ai.request.model': 'claude-opus-5',
          'gen_ai.provider.name': 'anthropic',
        },
      }),
    ]) as never);

    expect(traces[0].total_tokens).toBe(150);
    expect(traces[0].metadata).toMatchObject({
      provider: 'anthropic',
      source_format: 'otel-genai',
    });
  });

  // Regression: step numbers follow start-time order while parentage resolves
  // by span id, so a child that STARTS BEFORE its parent produced a forward
  // reference — which validateTraceInput rejects. `otel serve` was persisting
  // rows `ingest` refuses, breaking an export → ingest round-trip.
  it('drops a forward parent reference when a child starts before its parent', () => {
    const traces = mapOtlpTraces(otlp([
      span({ traceId: 't1', spanId: 'a', name: 'invoke_agent', start: MS, end: 9 * MS, attrs: {} }),
      span({ traceId: 't1', spanId: 'p', parentSpanId: 'a', name: 'chat', start: 1.5 * MS, end: 8 * MS, attrs: {} }),
      // Starts before its parent `p` (clock skew / async wrapper).
      span({ traceId: 't1', spanId: 'c', parentSpanId: 'p', name: 'execute_tool', start: 1.4 * MS, end: 7 * MS, attrs: {} }),
    ]) as never);

    const child = traces[0].steps!.find((s) => s.name === 'execute_tool')!;
    expect(child.step_number).toBe(1);
    expect(child.parent_step).toBeNull();
    // The span id is still there, so a cross-batch re-link can repair it later.
    expect(child.metadata).toMatchObject({ otel_parent_span_id: 'p' });
    expect(validateTraceInput(traces[0]).valid).toBe(true);
  });

  // Regression: a span whose end precedes its own start (clock skew between
  // hosts, or a hand-rolled exporter) produced a negative duration at BOTH the
  // step and trace level — values validateTraceInput rejects, so `otel serve`
  // persisted rows `ingest` refuses, and the UI printed a negative millisecond
  // count. Contradictory timing is now dropped as unknown, not clamped to 0.
  it('drops a negative duration when a span ends before it starts', () => {
    const traces = mapOtlpTraces(otlp([
      span({ traceId: 'tskew', spanId: 'a', name: 'chat', start: 5 * MS, end: 2 * MS, attrs: {} }),
    ]) as never);

    expect(traces[0].steps![0].duration_ms).toBeNull();
    expect(traces[0].total_duration_ms).toBeNull();
    expect(validateTraceInput(traces[0]).valid).toBe(true);
  });

  it('keeps a well-ordered duration, including a genuine zero', () => {
    const traces = mapOtlpTraces(otlp([
      span({ traceId: 'tok', spanId: 'a', name: 'chat', start: 2 * MS, end: 5 * MS, attrs: {} }),
      // Same start and end: an instant/cached call is 0ms, not unknown.
      span({ traceId: 'tok', spanId: 'b', name: 'execute_tool', start: 6 * MS, end: 6 * MS, attrs: {} }),
    ]) as never);

    const steps = traces[0].steps!;
    expect(steps.find((s) => s.name === 'chat')!.duration_ms).toBe(3);
    expect(steps.find((s) => s.name === 'execute_tool')!.duration_ms).toBe(0);
    expect(traces[0].total_duration_ms).toBe(4);
  });

  it('drops a self-referencing parent', () => {
    const traces = mapOtlpTraces(otlp([
      span({ traceId: 't1', spanId: 'x', parentSpanId: 'x', name: 'chat', start: MS, end: 2 * MS, attrs: {} }),
    ]) as never);
    expect(traces[0].steps![0].parent_step).toBeNull();
    expect(validateTraceInput(traces[0]).valid).toBe(true);
  });

  it('still nests a normally-ordered child under its parent', () => {
    const traces = mapOtlpTraces(otlp([
      span({ traceId: 't1', spanId: 'a', name: 'invoke_agent', start: MS, end: 9 * MS, attrs: {} }),
      span({ traceId: 't1', spanId: 'p', parentSpanId: 'a', name: 'chat', start: 2 * MS, end: 8 * MS, attrs: {} }),
      span({ traceId: 't1', spanId: 'c', parentSpanId: 'p', name: 'execute_tool', start: 3 * MS, end: 7 * MS, attrs: {} }),
    ]) as never);
    const child = traces[0].steps!.find((s) => s.name === 'execute_tool')!;
    const parent = traces[0].steps!.find((s) => s.name === 'chat')!;
    expect(child.parent_step).toBe(parent.step_number);
  });
});


// ── a batch is stored all-or-nothing ───────────────────────────────────────

describe('an OTLP batch commits atomically', () => {
  it('stores nothing when one trace in a multi-trace batch fails', () => {
    // Regression: the upsert loop had no transaction around it, so a failure
    // part way through a multi-trace payload left the earlier traces committed
    // and answered 500 — and a 5xx tells an OTLP exporter to retry the SAME
    // batch. On redelivery findMergeTarget found those committed traces and
    // merged the same spans again: steps duplicated, tokens doubled, and
    // permanently, since duplicate deliveries are deliberately not deduped.
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const batch = JSON.stringify(otlp([
      span({ traceId: 'ok1', spanId: 'a', name: 'chat', start: MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
      span({ traceId: 'ok2', spanId: 'b', name: 'chat', start: MS, end: 2 * MS, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ]));

    // Make the SECOND insert fail, after the first has already been written.
    let inserts = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('INSERT INTO agent_traces')) {
        inserts++;
        if (inserts === 2) throw new Error('simulated mid-batch write failure');
      }
      return realPrepare(sql);
    }) as typeof db.prepare;

    try {
      expect(() => handleTracesExport(db, batch, stats)).toThrow(/simulated/);
    } finally {
      db.prepare = realPrepare;
    }

    // The first trace must NOT have survived — otherwise the exporter's retry
    // would merge its spans a second time.
    expect(listTraces(db, {}).total).toBe(0);
  });
});

describe('mapOtlpTraces — a step stamp the formatter cannot render', () => {
  // The trace-level window was guarded, the per-STEP duration was not: a step
  // came back with `ended_at: null` beside a duration of ~56,000 years, computed
  // from the very stamp the formatter had just rejected — and the value is finite
  // and non-negative, so validation stores it and every view renders it.
  it('reports no duration rather than one derived from a rejected stamp', () => {
    const [trace] = mapOtlpTraces(otlp([
      span({ traceId: 'ts', spanId: 's0', name: 'invoke_agent', start: 1 * MS, end: 5 * MS, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'bot' } }),
      // Nanoseconds mistakenly stamped as ms*1e9 — the documented producer error.
      span({ traceId: 'ts', spanId: 's1', parentSpanId: 's0', name: 'chat', start: 2 * MS, end: 1.7e27, attrs: { 'gen_ai.operation.name': 'chat' } }),
    ]));

    const step = trace.steps![0];
    expect(step.ended_at).toBeNull();
    expect(step.duration_ms).toBeNull();
    // And the trace's own window is unaffected by the bad stamp.
    expect(trace.total_duration_ms).toBe(4);
    expect(() => ingestTrace(db, trace)).not.toThrow();
  });
});

describe('mapOtlpTraces — hostile attribute keys and counters', () => {
  // The prototype guard covered the step-type LOOKUP tables but not the map being
  // BUILT: an attribute named `__proto__` reassigned the map's prototype, so its
  // entries became inherited reads — enough to reclassify a span as a trace root
  // and drop its step entirely.
  it('does not let a `__proto__` attribute reclassify a span', () => {
    // The span must NOT carry its own `gen_ai.operation.name`: an own property
    // would shadow the poisoned prototype, which is exactly why the attack needs
    // a span that classifies by NAME while the prototype supplies the operation.
    const payload = otlp([
      span({ traceId: 'tp2', spanId: 'p1', name: 'chat', start: 1 * MS, end: 2 * MS, attrs: {} }),
    ]);
    // Inject a kvlist-shaped __proto__ attribute alongside the real ones.
    const spans = (payload.resourceSpans[0].scopeSpans[0].spans as Array<Record<string, unknown>>);
    (spans[0].attributes as unknown[]).push({
      key: '__proto__',
      value: { kvlistValue: { values: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }] } },
    });

    const [trace] = mapOtlpTraces(payload);
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps![0].step_type).toBe('llm_call');
  });

  // protobuf int64 is signed, so a negative usage count is wire-legal — and it
  // was stored verbatim, dragging `stats` sums negative and breaking the
  // export → ingest round trip.
  it('clamps a negative usage counter instead of storing it', () => {
    const [trace] = mapOtlpTraces(otlp([
      span({
        traceId: 'tn', spanId: 'n1', name: 'chat', start: 1 * MS, end: 2 * MS,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': -500, 'gen_ai.usage.output_tokens': -9 },
      }),
    ]));
    expect(trace.total_tokens).toBeNull();
    expect(() => ingestTrace(db, trace)).not.toThrow();
  });
});

describe('a span with no name still round-trips', () => {
  // `name` was `String(s.name ?? '')`, so a span carrying its operation only in
  // attributes (legal OTLP) produced a step named "" — which this tool's own
  // `ingest` refuses, and which the native `record` path refuses too. An
  // OTel-captured trace could not be restored from its own export: the exact
  // record/ingest drift class this mapper has been bitten by twice already.
  it('falls back to the operation name rather than storing an empty one', () => {
    const traces = mapOtlpTraces({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [{
          spans: [
            {
              traceId: 'aa', spanId: '01', name: 'invoke_agent',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }],
            },
            {
              traceId: 'aa', spanId: '02', parentSpanId: '01',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }],
            },
          ],
        }],
      }],
    });
    const steps = traces[0].steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(typeof s.name).toBe('string');
      expect(s.name).not.toBe('');
    }
    expect(steps.some((s) => s.name === 'execute_tool')).toBe(true);
  });
});

describe('span attributes the log path already reads', () => {
  function spanTrace(attrs: Array<{ key: string; value: unknown }>): ReturnType<typeof mapOtlpTraces>[number] {
    return mapOtlpTraces({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [{
          spans: [
            {
              traceId: 'cc', spanId: 'r1', name: 'invoke_agent',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000002000000000',
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }],
            },
            {
              traceId: 'cc', spanId: 'c1', parentSpanId: 'r1', name: 'chat',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }, ...attrs],
            },
          ],
        }],
      }],
    })[0];
  }

  // The two receivers front the same store, and the span path dropped the spend
  // entirely: the identical `gen_ai.usage.cost` attribute produced a cost on
  // /v1/logs and nothing on /v1/traces, so `stats` showed "Total cost: -" and
  // `list --sort cost` was inert for every span-captured trace.
  it('records the cost a span reports', () => {
    expect(spanTrace([{ key: 'gen_ai.usage.cost', value: { doubleValue: 0.25 } }]).total_cost_usd).toBe(0.25);
  });

  it('reads a reported total when the input/output split is absent', () => {
    expect(spanTrace([{ key: 'gen_ai.usage.total_tokens', value: { intValue: '500' } }]).total_tokens).toBe(500);
  });

  // A span reporting all three must not be counted twice.
  it('prefers the split over a total, without adding both', () => {
    const t = spanTrace([
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '20' } },
      { key: 'gen_ai.usage.total_tokens', value: { intValue: '120' } },
    ]);
    expect(t.total_tokens).toBe(120);
  });

  it('leaves cost null when no span reports one', () => {
    expect(spanTrace([]).total_cost_usd ?? null).toBeNull();
  });
});

describe('a failed tool is a step error, not a failed run', () => {
  // These two receivers were the ONLY capture paths that promoted a child
  // span's failure to the trace's status. The other eight store `completed`
  // for a run containing a failed tool call, the telemetry-ingest spec says a
  // span error becomes a STEP error, and eval's design deliberately does not
  // hard-fail a preset for a recovered step error — so the identical session
  // scored the same and PASSED via `ingest` while FAILING at exit 1 here, and
  // `check --golden` reported a status regression between two captures of one
  // session.
  function traceFrom(rootErrored: boolean, childErrored: boolean): ReturnType<typeof mapOtlpTraces>[number] {
    const err = (on: boolean): unknown[] => (on
      ? [{ key: 'error.type', value: { stringValue: 'boom' } }]
      : []);
    return mapOtlpTraces({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeSpans: [{
          spans: [
            {
              traceId: 'ff', spanId: 'r1', name: 'invoke_agent',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000002000000000',
              ...(rootErrored ? { status: { code: 2 } } : {}),
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }, ...err(rootErrored)],
            },
            {
              traceId: 'ff', spanId: 't1', parentSpanId: 'r1', name: 'execute_tool',
              startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001000000000',
              ...(childErrored ? { status: { code: 2 } } : {}),
              attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } }, ...err(childErrored)],
            },
          ],
        }],
      }],
    })[0];
  }

  it('keeps the run completed when only a tool span failed', () => {
    const t = traceFrom(false, true);
    expect(t.status).toBe('completed');
    // The failure is still visible where it belongs.
    expect(t.steps!.some((s) => s.error != null)).toBe(true);
  });

  it('fails the run when the ROOT span failed, and says why', () => {
    const t = traceFrom(true, false);
    expect(t.status).toBe('failed');
    // A failed trace must carry a reason — it was stored with error: null, so
    // `show` rendered "✘ FAILED" with nothing to explain it.
    expect(t.error).toBeTruthy();
  });
});


describe('a span id repeated inside one batch is a redelivery too', () => {
  // The merge path already refuses a span id it saw in an EARLIER batch, which
  // is what makes an exporter's retry safe. That check compares against what is
  // STORED, so it cannot see a duplicate arriving twice inside one payload —
  // and a batch listing the same span twice was stored as two steps sharing an
  // `otel_span_id`, double-counting its tokens. The identity and the argument
  // are the same on either side of a batch boundary.
  const span = (spanId: string, name: string) => ({
    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    spanId,
    name,
    startTimeUnixNano: '1000000000',
    endTimeUnixNano: '2000000000',
    attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '15' } }],
  });
  const batch = (spans: unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });

  it('keeps the first occurrence and drops the repeat', () => {
    const [t] = mapOtlpTraces(batch([
      span('1111111111111111', 'chat gpt-4'),
      span('1111111111111111', 'chat gpt-4'),
      span('2222222222222222', 'execute_tool ls'),
    ]) as never);

    expect(t.steps).toHaveLength(2);
    expect(t.steps!.map((st) => (st.metadata as { otel_span_id?: string }).otel_span_id))
      .toEqual(['1111111111111111', '2222222222222222']);
    // The token total must not double-count either — that is the damage.
    expect(t.total_tokens).toBe(30);
  });

  it('leaves genuinely distinct spans alone', () => {
    const [t] = mapOtlpTraces(batch([
      span('1111111111111111', 'chat gpt-4'),
      span('2222222222222222', 'execute_tool ls'),
      span('3333333333333333', 'execute_tool cat'),
    ]) as never);
    expect(t.steps).toHaveLength(3);
    expect(t.total_tokens).toBe(45);
  });

  it('does not fuse spans that simply have no id', () => {
    // There is nothing to key on, so they must all survive rather than
    // collapsing into one.
    const [t] = mapOtlpTraces(batch([
      { ...span('', 'execute_tool a'), spanId: '' },
      { ...span('', 'execute_tool b'), spanId: '' },
    ]) as never);
    expect(t.steps).toHaveLength(2);
  });
});

describe('a nested agent span keeps its own gen_ai.agent.name', () => {
  // A multi-agent trace has nested `invoke_agent` spans, each naming its own
  // sub-agent. The grouping deliberately keeps them -- "every other span,
  // including nested agent/workflow roots, becomes a step, so nothing is
  // dropped" -- but `gen_ai.agent.name` sat in the CONSUMED list, which exists
  // to stop metadata duplicating what a column already holds. It is consumed
  // only from the ROOT span, where it becomes the trace's `agent_name`. On any
  // other span nobody consumed it and CONSUMED still dropped it, so a step
  // carried no record of which agent ran it.
  const T = '3af7651916cd43dd8448eb211c80319c';
  const multiAgent = () => otlp([
    span({
      traceId: T, spanId: 'e7ad6b7169203331', name: 'invoke_agent',
      start: 1767225700000000000, end: 1767225706000000000,
      attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'orchestrator' },
    }),
    span({
      traceId: T, spanId: 'e7ad6b7169203332', parentSpanId: 'e7ad6b7169203331',
      name: 'invoke_agent', // deliberately NOT "invoke_agent researcher"
      start: 1767225701000000000, end: 1767225704000000000,
      attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'researcher' },
    }),
  ]);

  it('preserves the sub-agent name on the step', () => {
    // The span NAME is deliberately the bare operation here. A producer that
    // repeats the agent in the span name ("invoke_agent researcher") kept the
    // value incidentally, through the step name -- which is what made the loss
    // easy to miss.
    const [trace] = mapOtlpTraces(multiAgent());
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0].metadata).toMatchObject({ 'gen_ai.agent.name': 'researcher' });
  });

  it('still names the trace from the root, and does not duplicate it in metadata', () => {
    // The root's copy IS consumed -- it becomes agent_name -- so it must stay
    // out of the metadata bag, which is the rule CONSUMED exists to enforce.
    const [trace] = mapOtlpTraces(multiAgent());
    expect(trace.agent_name).toBe('orchestrator');
    expect(trace.metadata).not.toHaveProperty('gen_ai.agent.name');
  });

  it('keeps every other consumed key out of step metadata', () => {
    // Guards the narrowness of the change: only agent.name moved, and only for
    // non-root spans. A model or conversation id is consumed on EVERY span, so
    // neither should appear in the bag.
    const [trace] = mapOtlpTraces(otlp([
      span({
        traceId: T, spanId: 'e7ad6b7169203341', name: 'invoke_agent',
        start: 1767225700000000000, end: 1767225706000000000,
        attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'orchestrator' },
      }),
      span({
        traceId: T, spanId: 'e7ad6b7169203342', parentSpanId: 'e7ad6b7169203341', name: 'chat',
        start: 1767225701000000000, end: 1767225704000000000,
        attrs: {
          'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-opus-5',
          'gen_ai.conversation.id': 'conv-1', 'gen_ai.custom.thing': 'kept',
        },
      }),
    ]));
    const meta = trace.steps[0].metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty('gen_ai.request.model');
    expect(meta).not.toHaveProperty('gen_ai.conversation.id');
    expect(meta).toMatchObject({ 'gen_ai.custom.thing': 'kept' }); // unmapped keys still kept
    expect(trace.steps[0].model).toBe('claude-opus-5');
    expect(trace.session_id).toBe('conv-1');
  });
});

describe('a root span keeps the attributes only a step would have consumed', () => {
  // The mirror image of the sub-agent case above. `gen_ai.request.model` and
  // `gen_ai.tool.name` are read by the STEP mapping -- model becomes the step's
  // column, the tool's name becomes the step's name. The root is not a step, so
  // on the root nothing reads them, yet they were excluded from metadata
  // anyway.
  //
  // That contradicted the intent stated on the trace's own metadata: "carry the
  // root's own attributes (model, provider, and any unmapped gen_ai.* keys) ...
  // they were dropped entirely, so a single-span trace recorded no model or
  // provider at all." The provider half worked -- it is written explicitly. The
  // model half did not.
  const soloAgent = () => otlp([
    span({
      traceId: '4af7651916cd43dd8448eb211c80319c', spanId: 'f7ad6b7169203331',
      name: 'invoke_agent', start: 1767225700000000000, end: 1767225706000000000,
      attrs: {
        'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'solo',
        'gen_ai.request.model': 'claude-opus-5', 'gen_ai.provider.name': 'anthropic',
        'gen_ai.usage.input_tokens': 10,
      },
    }),
  ]);

  it('records the model of a single-span agent trace', () => {
    // One root span and no children: there are no steps at all, so a step's
    // `model` column can never hold this. Metadata is the only home it has, and
    // without it the run recorded its agent, tokens and provider but not the
    // model it actually ran on.
    const [trace] = mapOtlpTraces(soloAgent());
    expect(trace.steps).toHaveLength(0);
    expect(trace.agent_name).toBe('solo');
    expect(trace.metadata).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('normalizes the root model across dialects, as it does the provider', () => {
    // OpenInference spells it `llm.model_name`, which is not a `gen_ai.*` key
    // and so was never eligible for the unmapped-key loop at all. Letting the
    // raw key through would therefore have fixed the GenAI spelling and left
    // this one broken -- the same dialect gap `llm.provider` was fixed for.
    const [trace] = mapOtlpTraces(otlp([
      span({
        traceId: '6af7651916cd43dd8448eb211c80319c', spanId: 'b1ad6b7169203331', name: 'agent',
        start: 1767225700000000000, end: 1767225706000000000,
        attrs: {
          'openinference.span.kind': 'AGENT', 'llm.model_name': 'gpt-4o',
          'llm.provider': 'openai', 'llm.token_count.prompt': 10,
        },
      }),
    ]));
    expect(trace.steps).toHaveLength(0);
    expect(trace.metadata).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
  });

  it('still keeps the model out of a step\'s metadata, where the column holds it', () => {
    // The narrowness guard: on a step the model IS consumed, into `model`, so
    // duplicating it in the bag is exactly what the exclusion list is for.
    const [trace] = mapOtlpTraces(otlp([
      span({
        traceId: '5af7651916cd43dd8448eb211c80319c', spanId: 'a1ad6b7169203331',
        name: 'invoke_agent', start: 1767225700000000000, end: 1767225706000000000,
        attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'solo' },
      }),
      span({
        traceId: '5af7651916cd43dd8448eb211c80319c', spanId: 'a1ad6b7169203332',
        parentSpanId: 'a1ad6b7169203331', name: 'chat',
        start: 1767225701000000000, end: 1767225704000000000,
        attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-opus-5' },
      }),
    ]));
    expect(trace.steps[0].model).toBe('claude-opus-5');
    expect(trace.steps[0].metadata).not.toHaveProperty('gen_ai.request.model');
    expect(trace.steps[0].metadata).not.toHaveProperty('model');
  });
});

describe('the /v1/traces endpoint rejects nothing, and says so by answering a bare 200', () => {
  // This endpoint once answered `partialSuccess: { rejectedSpans: N }` when a
  // batch mapped to zero traces, justified as "spans genuinely undecodable (no
  // traceId → dropped in flatten)". Nothing is dropped in flatten, and an
  // id-less span is deliberately KEPT as its own synthetic trace, so the
  // condition could not hold — an unreachable branch promising a report this
  // endpoint cannot make. These pin the two facts that make it unreachable, so
  // it cannot be reintroduced on the old reasoning.
  it('keeps a span with no trace id as a trace, and reports no rejection', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleTracesExport(
      db,
      JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'a1', name: 'chat', attributes: [] }] }] }] }),
      stats,
    );

    expect(res.status).toBe(200);
    expect(res.payload).toEqual({});
    expect(listTraces(db, {}).items).toHaveLength(1);
  });

  it('reports no rejection for spans carrying no recognizable attributes', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    const res = handleTracesExport(
      db,
      JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'zz', spanId: 'b1', name: 'something-random', attributes: [] }] }] }] }),
      stats,
    );

    expect(res.status).toBe(200);
    expect(res.payload).toEqual({});
    expect(listTraces(db, {}).items).toHaveLength(1);
  });

  it('still refuses a malformed body with 400, which is what the span walk is for', () => {
    const stats: OtelStats = { acceptedSpans: 0, acceptedTraces: 0 };
    for (const body of [
      { resourceSpans: 5 },
      { resourceSpans: { a: 1 } },
      { resourceSpans: [{ scopeSpans: [{ spans: 7 }] }] },
    ]) {
      expect(handleTracesExport(db, JSON.stringify(body), stats).status).toBe(400);
    }
    // An empty batch is well-formed, not a rejection.
    expect(handleTracesExport(db, JSON.stringify({ resourceSpans: [] }), stats)).toEqual({ status: 200, payload: {} });
  });
});

describe('a span-captured trace names its session', () => {
  // `gen_ai.conversation.id` is the GenAI semconv field; `session.id` is the
  // general OTel one, and it is what the harnesses actually stamp — this repo's
  // own LOG mapper groups by `session.id`. Reading only the GenAI attribute left
  // a span-captured trace with `session_id: null` while the same session's log
  // records carried it, so the two OTLP signals of one session could not be
  // correlated by anything.
  const span = (attrs: Record<string, unknown>) => ({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scopeSpans: [{ spans: [{
        traceId: '0000000000000000000000000000beef', spanId: '000000000000beef', name: 'chat',
        startTimeUnixNano: '1750000000000000000', endTimeUnixNano: '1750000002000000000',
        attributes: [
          { key: 'gen_ai.system', value: { stringValue: 'anthropic' } },
          ...Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
        ],
      }] }],
    }],
  });

  it('reads session.id when the GenAI conversation id is absent', () => {
    const [trace] = mapOtlpTraces(span({ 'session.id': 'sess-from-span' }) as never);
    expect(trace.session_id).toBe('sess-from-span');
  });

  it('still prefers the GenAI conversation id when both are present', () => {
    const [trace] = mapOtlpTraces(
      span({ 'gen_ai.conversation.id': 'conv-1', 'session.id': 'sess-2' }) as never,
    );
    expect(trace.session_id).toBe('conv-1');
  });

  it('synthesizes neither when the span carries no session at all', () => {
    const [trace] = mapOtlpTraces(span({}) as never);
    expect(trace.session_id).toBeNull();
  });
});
