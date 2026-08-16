import type { IngestTraceInput, IngestStepInput } from '../../models/types.js';

/**
 * Map OpenTelemetry GenAI semantic-convention spans (OTLP/JSON) onto the trace
 * model. Because the conventions are still status Development, an alias table
 * normalizes known deprecated forms and OpenInference's `openinference.span.kind`
 * is accepted as a fallback; unmapped `gen_ai.*` attributes are preserved in
 * step metadata rather than dropped.
 */

// ── OTLP/JSON value + attribute decoding ────────────────────────────────────

type AnyValue = Record<string, unknown>;

export function decodeAnyValue(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return v;
  const o = v as AnyValue;
  if ('stringValue' in o) return o.stringValue;
  if ('intValue' in o) return typeof o.intValue === 'string' ? Number(o.intValue) : o.intValue;
  if ('doubleValue' in o) return o.doubleValue;
  if ('boolValue' in o) return o.boolValue;
  if ('arrayValue' in o) return ((o.arrayValue as AnyValue)?.values as unknown[] ?? []).map(decodeAnyValue);
  if ('kvlistValue' in o) return attrsToMap((o.kvlistValue as AnyValue)?.values as unknown[]);
  return undefined;
}

export function attrsToMap(attributes: unknown[] | undefined): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const a of attributes ?? []) {
    const kv = a as { key?: string; value?: unknown };
    if (typeof kv.key === 'string') m[kv.key] = decodeAnyValue(kv.value);
  }
  return m;
}

// ── Operation classification ────────────────────────────────────────────────

type Role = 'root' | 'step';

const GENAI_OP_STEP: Record<string, string> = {
  execute_tool: 'tool_call',
  chat: 'llm_call',
  generate_content: 'llm_call',
  text_completion: 'llm_call',
  embeddings: 'retrieval',
  retrieval: 'retrieval',
  plan: 'thought',
};
const GENAI_OP_ROOT = new Set(['invoke_agent', 'invoke_workflow', 'create_agent']);

const OPENINFERENCE_KIND: Record<string, string> = {
  TOOL: 'tool_call',
  LLM: 'llm_call',
  RETRIEVER: 'retrieval',
  EMBEDDING: 'retrieval',
  GUARDRAIL: 'guard_check',
};

interface Classified {
  role: Role;
  stepType?: string;
}

function classify(name: string, attrs: Record<string, unknown>): Classified {
  const op = str(attrs['gen_ai.operation.name']);
  if (op) {
    if (GENAI_OP_ROOT.has(op)) return { role: 'root' };
    if (GENAI_OP_STEP[op]) return { role: 'step', stepType: GENAI_OP_STEP[op] };
  }
  const kind = str(attrs['openinference.span.kind']);
  if (kind) {
    const upper = kind.toUpperCase();
    if (upper === 'AGENT' || upper === 'CHAIN') return { role: 'root' };
    if (OPENINFERENCE_KIND[upper]) return { role: 'step', stepType: OPENINFERENCE_KIND[upper] };
  }
  // OpenLLMetry (traceloop.*): workflow/agent anchor a trace; tool → tool_call;
  // task → thought; an llm.request.type marks an inference span.
  const tlKind = str(attrs['traceloop.span.kind']);
  if (tlKind) {
    const lower = tlKind.toLowerCase();
    if (lower === 'workflow' || lower === 'agent') return { role: 'root' };
    if (lower === 'tool') return { role: 'step', stepType: 'tool_call' };
    if (lower === 'task') return { role: 'step', stepType: 'thought' };
  }
  if (attrs['llm.request.type'] != null) return { role: 'step', stepType: 'llm_call' };
  // Fall back to the span name's leading verb.
  const first = name.trim().split(/\s+/)[0];
  if (GENAI_OP_ROOT.has(first)) return { role: 'root' };
  if (GENAI_OP_STEP[first]) return { role: 'step', stepType: GENAI_OP_STEP[first] };
  return { role: 'step', stepType: 'thought' };
}

// ── Token accounting with drift aliases ─────────────────────────────────────

function inputTokens(a: Record<string, unknown>): number {
  return num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? a['llm.token_count.prompt']);
}
function outputTokens(a: Record<string, unknown>): number {
  return num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? a['llm.token_count.completion']);
}

// ── Span flattening ─────────────────────────────────────────────────────────

interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  start: number; // unix nanos
  end: number | undefined;
  attrs: Record<string, unknown>;
  resource: Record<string, unknown>;
  errorMessage: string | null;
}

export function flattenSpans(otlp: Record<string, unknown>): FlatSpan[] {
  const out: FlatSpan[] = [];
  for (const rs of (otlp.resourceSpans as unknown[]) ?? []) {
    const rsObj = rs as { resource?: { attributes?: unknown[] }; scopeSpans?: unknown[] };
    const resource = attrsToMap(rsObj.resource?.attributes);
    for (const ss of rsObj.scopeSpans ?? []) {
      const spans = (ss as { spans?: unknown[] }).spans ?? [];
      for (const sp of spans) {
        const s = sp as Record<string, unknown>;
        const status = s.status as { code?: unknown; message?: string } | undefined;
        const attrs = attrsToMap(s.attributes as unknown[]);
        // A failure reaches us three ways, and keying on `status` alone missed
        // two of them:
        //   1. status.code = ERROR — the explicit case
        //   2. an `exception` span event — what `recordException` records, and
        //      several instrumentations call it WITHOUT also setting the status
        //   3. an `error.type` attribute — what GenAI semconv sets on a failed
        //      operation
        // Missing 2 and 3 meant a span that captured its own exception was
        // stored as a completed step on a completed trace, with the exception
        // text preserved nowhere at all.
        const exception = ((s.events as unknown[]) ?? [])
          .map((e) => e as { name?: unknown; attributes?: unknown[] })
          .find((e) => String(e.name ?? '') === 'exception');
        const exAttrs = exception ? attrsToMap(exception.attributes) : {};
        const exceptionMessage = str(exAttrs['exception.message']) ?? str(exAttrs['exception.type']);
        const errorType = str(attrs['error.type']);
        // An explicit OK status is a deliberate statement that the operation
        // succeeded, so it wins over the weaker signals.
        const explicitOk = String(status?.code) === '1' || String(status?.code) === 'STATUS_CODE_OK';
        const isError =
          String(status?.code) === '2' ||
          String(status?.code) === 'STATUS_CODE_ERROR' ||
          (!explicitOk && (exceptionMessage != null || errorType != null));
        out.push({
          traceId: String(s.traceId ?? ''),
          spanId: String(s.spanId ?? ''),
          parentSpanId: s.parentSpanId ? String(s.parentSpanId) : undefined,
          name: String(s.name ?? ''),
          start: num(s.startTimeUnixNano),
          end: s.endTimeUnixNano != null ? num(s.endTimeUnixNano) : undefined,
          attrs,
          resource,
          // An error span must yield a non-empty message: some exporters set
          // status.code=2 with an empty description, and an empty string here
          // would read as falsy in `anyError` below — silently recording the
          // failure as a completed trace. `str` treats '' as absent, so this
          // falls through to error.type, then a generic 'error'.
          errorMessage: isError
            ? (str(status?.message) ?? exceptionMessage ?? errorType ?? 'error')
            : null,
        });
      }
    }
  }
  return out;
}

// ── Mapping ─────────────────────────────────────────────────────────────────

function isoFromNanos(nanos: number): string | undefined {
  if (!nanos) return undefined;
  return new Date(nanos / 1e6).toISOString();
}

/** Map an OTLP/JSON traces payload into one IngestTraceInput per OTel trace ID. */
export function mapOtlpTraces(otlp: Record<string, unknown>): IngestTraceInput[] {
  const spans = flattenSpans(otlp);
  const byTrace = new Map<string, FlatSpan[]>();
  for (const s of spans) {
    const list = byTrace.get(s.traceId) ?? [];
    list.push(s);
    byTrace.set(s.traceId, list);
  }

  const traces: IngestTraceInput[] = [];
  for (const [, group] of byTrace) {
    // Order by start time, but sort a span missing startTimeUnixNano (flattened
    // to 0 by num()) to the END, not the front — otherwise it steals step_number
    // 1 and the trace's start time from genuinely-earlier, fully-timed spans.
    group.sort((a, b) => (a.start || Infinity) - (b.start || Infinity));

    const roots = group.filter((s) => classify(s.name, s.attrs).role === 'root');

    // The first root span defines the trace identity; every other span — including
    // nested agent/workflow roots — becomes a step, so nothing is dropped and
    // children keep a resolvable parent. (Orphan traces have no root, so all
    // spans are steps.)
    const root = roots[0];
    const stepSpans = group.filter((s) => s !== root);
    const anyConversation = group.map((s) => str(s.attrs['gen_ai.conversation.id'])).find(Boolean);
    const agentName =
      str(root?.attrs['gen_ai.agent.name']) ??
      str(group[0]?.resource['service.name']) ??
      'otel-agent';

    // spanId → step_number for parentage.
    const stepNumberOf = new Map<string, number>();
    stepSpans.forEach((s, i) => stepNumberOf.set(s.spanId, i + 1));

    let totalTokens = 0;
    const anyError = group.some((s) => s.errorMessage);

    const steps: IngestStepInput[] = stepSpans.map((s, i) => {
      // A nested root (invoke_agent/workflow that isn't the identity root) has
      // no step type of its own — anchor it as a thought so children can nest.
      const stepType = classify(s.name, s.attrs).stepType ?? 'thought';
      const tokens = inputTokens(s.attrs) + outputTokens(s.attrs);
      totalTokens += tokens;
      const parent = s.parentSpanId ? stepNumberOf.get(s.parentSpanId) : undefined;
      const duration = s.end && s.start ? Math.round((s.end - s.start) / 1e6) : null;
      // Same guard as the trace root below: messageContent never returns null (it
      // omits the `messages` key when the span has no output messages), so a
      // message-less step — the common case for tool/thought spans — must be
      // mapped to null explicitly. Otherwise it persists a spurious `{}` that
      // reads as truthy downstream ("OUTPUT: {}" in summaries, golden stores `{}`
      // not null). Input keeps `{}` as its empty value, exactly like the root.
      const outputContent = messageContent(s.attrs, 'output');
      const output = 'messages' in outputContent ? outputContent : null;

      return {
        step_number: i + 1,
        step_type: stepType,
        name: str(s.attrs['gen_ai.tool.name']) ?? str(s.attrs['traceloop.entity.name']) ?? s.name,
        input: messageContent(s.attrs, 'input'),
        output,
        started_at: isoFromNanos(s.start),
        ended_at: s.end ? isoFromNanos(s.end) : null,
        duration_ms: duration,
        tokens_used: tokens || null,
        model: str(s.attrs['gen_ai.request.model']) ?? str(s.attrs['gen_ai.response.model']) ?? str(s.attrs['llm.model_name']) ?? null,
        error: s.errorMessage,
        parent_step: parent ?? null,
        metadata: stepMetadata(s.attrs, s.spanId, s.parentSpanId),
      };
    });

    // The trace spans from the earliest span start (group is sorted by start)
    // to the latest span end; derive the trace-level end time and duration so
    // OTel-ingested traces show a duration instead of "-".
    const spanEnds = group.map((s) => s.end).filter((e): e is number => e != null);
    const maxEnd = spanEnds.length ? Math.max(...spanEnds) : undefined;
    // Earliest VALID start (a span missing startTimeUnixNano flattens to 0, which
    // is not a real 1970 timestamp), so one start-less span can't null the whole
    // trace's start/duration when other spans are properly timed.
    const spanStarts = group.map((s) => s.start).filter((st): st is number => st > 0);
    const minStart = spanStarts.length ? Math.min(...spanStarts) : undefined;

    // messageContent always returns an object (never null) — it just omits the
    // `messages` key when the span carries no message attributes. So a root with
    // no output must be mapped to null EXPLICITLY: the bare `?? null` would be
    // dead and persist a spurious empty `{}` output, which reads as truthy
    // downstream (e.g. a summary prints "OUTPUT: {}", golden export stores `{}`
    // instead of null). Input keeps `{}` as its empty value — it is a non-null
    // Record either way, so the distinction doesn't arise there.
    const rootInput = root ? messageContent(root.attrs, 'input') : {};
    const rootOutputContent = root ? messageContent(root.attrs, 'output') : null;
    const rootOutput = rootOutputContent && 'messages' in rootOutputContent ? rootOutputContent : null;

    traces.push({
      agent_name: agentName,
      trigger: 'api',
      status: anyError ? 'failed' : 'completed',
      // gen_ai.conversation.id is never synthesized when absent.
      session_id: anyConversation ?? null,
      input: rootInput,
      output: rootOutput,
      started_at: minStart != null ? isoFromNanos(minStart) : undefined,
      ended_at: maxEnd != null ? isoFromNanos(maxEnd) : null,
      // Derive the duration from the earliest valid start (not group[0], which
      // may be a start-less span): a span missing startTimeUnixNano flattens to
      // nanos 0, so trusting it would give `maxEnd - 0` — an absurd epoch-based
      // duration — or, once such spans sort last, would wrongly null a duration
      // that the timed spans do define.
      total_duration_ms:
        maxEnd != null && minStart != null ? Math.round((maxEnd - minStart) / 1e6) : null,
      total_tokens: totalTokens || null,
      metadata: { source_format: 'otel-genai', otel_trace_id: group[0].traceId, ...(root ? {} : { synthetic_trace: true }) },
      steps,
    });
  }

  return traces;
}

function messageContent(a: Record<string, unknown>, dir: 'input' | 'output'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (dir === 'input') {
    const msgs = a['gen_ai.input.messages'] ?? a['gen_ai.prompt'];
    if (msgs != null) out.messages = msgs;
  } else {
    const msgs = a['gen_ai.output.messages'] ?? a['gen_ai.completion'];
    if (msgs != null) out.messages = msgs;
  }
  return out;
}

function stepMetadata(a: Record<string, unknown>, spanId: string, parentSpanId?: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { otel_span_id: spanId };
  // Preserve the OTel parent span id so a child arriving in a later export batch
  // can be re-linked to a parent step already stored from an earlier batch.
  if (parentSpanId) meta.otel_parent_span_id = parentSpanId;
  const provider = str(a['gen_ai.provider.name']) ?? str(a['gen_ai.system']);
  if (provider) meta.provider = provider;
  // Preserve any gen_ai.* attributes we didn't explicitly map.
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith('gen_ai.') && !CONSUMED.has(k)) meta[k] = v;
  }
  return meta;
}

const CONSUMED = new Set([
  'gen_ai.operation.name', 'gen_ai.agent.name', 'gen_ai.conversation.id', 'gen_ai.tool.name',
  'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.provider.name', 'gen_ai.system',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.prompt_tokens',
  'gen_ai.usage.completion_tokens', 'gen_ai.input.messages', 'gen_ai.output.messages',
  'gen_ai.prompt', 'gen_ai.completion',
]);

// ── small helpers ───────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
