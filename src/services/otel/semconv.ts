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
        const isError = String(status?.code) === '2' || String(status?.code) === 'STATUS_CODE_ERROR';
        out.push({
          traceId: String(s.traceId ?? ''),
          spanId: String(s.spanId ?? ''),
          parentSpanId: s.parentSpanId ? String(s.parentSpanId) : undefined,
          name: String(s.name ?? ''),
          start: num(s.startTimeUnixNano),
          end: s.endTimeUnixNano != null ? num(s.endTimeUnixNano) : undefined,
          attrs,
          resource,
          errorMessage: isError ? (status?.message ?? str(attrs['error.type']) ?? 'error') : null,
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
    group.sort((a, b) => a.start - b.start);

    const roots = group.filter((s) => classify(s.name, s.attrs).role === 'root');
    const stepSpans = group.filter((s) => classify(s.name, s.attrs).role === 'step');

    const root = roots[0];
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
      const { stepType } = classify(s.name, s.attrs);
      const tokens = inputTokens(s.attrs) + outputTokens(s.attrs);
      totalTokens += tokens;
      const parent = s.parentSpanId ? stepNumberOf.get(s.parentSpanId) : undefined;
      const duration = s.end && s.start ? Math.round((s.end - s.start) / 1e6) : null;

      return {
        step_number: i + 1,
        step_type: stepType!,
        name: str(s.attrs['gen_ai.tool.name']) ?? s.name,
        input: messageContent(s.attrs, 'input'),
        output: messageContent(s.attrs, 'output'),
        started_at: isoFromNanos(s.start),
        ended_at: s.end ? isoFromNanos(s.end) : null,
        duration_ms: duration,
        tokens_used: tokens || null,
        model: str(s.attrs['gen_ai.request.model']) ?? str(s.attrs['gen_ai.response.model']) ?? str(s.attrs['llm.model_name']) ?? null,
        error: s.errorMessage,
        parent_step: parent ?? null,
        metadata: stepMetadata(s.attrs, s.spanId),
      };
    });

    traces.push({
      agent_name: agentName,
      trigger: 'api',
      status: anyError ? 'failed' : 'completed',
      // gen_ai.conversation.id is never synthesized when absent.
      session_id: anyConversation ?? null,
      input: root ? messageContent(root.attrs, 'input') ?? {} : {},
      output: root ? messageContent(root.attrs, 'output') ?? null : null,
      started_at: isoFromNanos(group[0].start),
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

function stepMetadata(a: Record<string, unknown>, spanId: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { otel_span_id: spanId };
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
