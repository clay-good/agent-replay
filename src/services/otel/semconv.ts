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
  // Null-prototype: today's guard covered the step-type LOOKUP tables but not the
  // map being BUILT, so an attribute literally named `__proto__` reassigned this
  // object's prototype and its entries became inherited reads for every later
  // `attrs[...]` — enough to reclassify a span as a trace root and drop its step.
  const m: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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

/**
 * Look a span's operation/kind up in a step-type table, ignoring keys inherited
 * from Object.prototype.
 *
 * The keys come from untrusted telemetry — the `gen_ai.operation.name` attribute
 * and the span NAME's leading word — and these tables are plain object literals,
 * so a span named `constructor` or `toString` (an auto-instrumented JS class
 * method) resolved to a FUNCTION. That was typed as `string`, survived the
 * `?? 'thought'` fallback (it is not null), and reached the SQLite bind as a
 * function: the whole batch's transaction rolled back and the receiver answered
 * 500 — which OTLP exporters retry, so one such span resent a poisoned batch
 * forever and blackholed the pipeline. Mirrors the guards already in
 * hook-adapter and eval-service.
 */
function lookupStepType(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function classify(name: string, attrs: Record<string, unknown>): Classified {
  const op = str(attrs['gen_ai.operation.name']);
  if (op) {
    if (GENAI_OP_ROOT.has(op)) return { role: 'root' };
    const opStep = lookupStepType(GENAI_OP_STEP, op);
    if (opStep) return { role: 'step', stepType: opStep };
  }
  const kind = str(attrs['openinference.span.kind']);
  if (kind) {
    const upper = kind.toUpperCase();
    if (upper === 'AGENT' || upper === 'CHAIN') return { role: 'root' };
    const kindStep = lookupStepType(OPENINFERENCE_KIND, upper);
    if (kindStep) return { role: 'step', stepType: kindStep };
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
  const nameStep = lookupStepType(GENAI_OP_STEP, first);
  if (nameStep) return { role: 'step', stepType: nameStep };
  return { role: 'step', stepType: 'thought' };
}

// ── Token accounting with drift aliases ─────────────────────────────────────

/**
 * A usage counter, floored at zero. protobuf `int64` is signed, so a negative
 * count is wire-legal — and it was stored verbatim, which drags `stats` sums
 * negative and breaks the export → `ingest` round trip (`ingest` requires a
 * non-negative total). Same clamp the importers and stream translators apply.
 */
function usage(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function inputTokens(a: Record<string, unknown>): number {
  return usage(num(a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? a['llm.token_count.prompt']));
}
function outputTokens(a: Record<string, unknown>): number {
  return usage(num(a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? a['llm.token_count.completion']));
}
/**
 * A span's total, for emitters that report only the total and not the split.
 * Used ONLY when neither component is present, so a span reporting all three
 * can't be counted twice.
 */
function totalTokensOnly(a: Record<string, unknown>): number {
  return usage(num(a['gen_ai.usage.total_tokens'] ?? a['llm.token_count.total']));
}
/**
 * The spend a span reports, read with the same keys as the log path
 * (`log-events.ts`). The two receivers front the same store, and this one
 * dropped the number entirely: the identical `gen_ai.usage.cost` attribute
 * produced a cost on `/v1/logs` and nothing on `/v1/traces`, so `stats` showed
 * "Total cost: -" and `list --sort cost` was inert for every span-captured
 * trace while the value sat unread in the payload.
 */
function costUsd(a: Record<string, unknown>): number {
  const c = num(a['gen_ai.usage.cost'] ?? a['cost_usd'] ?? a['cost']);
  return Number.isFinite(c) && c > 0 ? c : 0;
}
/** Tokens for one span: the split when present, else a reported total. */
function spanTokens(a: Record<string, unknown>): number {
  const split = inputTokens(a) + outputTokens(a);
  return split > 0 ? split : totalTokensOnly(a);
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

/**
 * An ISO timestamp from OTLP nanoseconds, or undefined when the value is not a
 * usable instant.
 *
 * Two failures came from converting unguarded. A value beyond the Date range
 * (a producer sending `Date.now() * 1e9`, or a negative) threw `RangeError:
 * Invalid time value` — and because the mapper runs inside the receiver's
 * try, the WHOLE batch was answered 400 ("resourceSpans must be arrays",
 * blaming the wrong thing) and every well-formed span alongside it was
 * discarded, permanently, since 400 is not retryable. A value merely far in
 * the future stayed in range but produced the expanded-year form
 * (`+057583-09-27T…`), which `julianday()` cannot parse — so that trace sorted
 * LAST in `list`, vanished from every `--since` window, and had no computable
 * duration. Bound it to four-digit years, the range every reader can handle.
 */
export function isoFromNanos(nanos: number): string | undefined {
  if (!nanos || !Number.isFinite(nanos)) return undefined;
  const ms = nanos / 1e6;
  // Date's own range is ±8.64e15 ms; the four-digit-year window is narrower.
  const MIN_MS = Date.UTC(1000, 0, 1);
  const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
  if (ms < MIN_MS || ms > MAX_MS) return undefined;
  const iso = new Date(ms).toISOString();
  return iso.startsWith('+') || iso.startsWith('-') ? undefined : iso;
}

/** Map an OTLP/JSON traces payload into one IngestTraceInput per OTel trace ID. */
/**
 * Map one span to a step. Extracted so the identity root can be rendered as a
 * step too when a batch merges into a trace that already has its identity —
 * otherwise that span is dropped entirely (see `otel_identity_root_step`).
 */
function spanToStep(
  s: FlatSpan,
  i: number,
  stepNumberOf: Map<string, number>,
): IngestStepInput {
  // A nested root (invoke_agent/workflow that isn't the identity root) has
  // no step type of its own — anchor it as a thought so children can nest.
  const stepType = classify(s.name, s.attrs).stepType ?? 'thought';
  const tokens = spanTokens(s.attrs);
  // Step numbers follow start-time order, but parentage is resolved by span
  // id regardless of order — so a child that STARTS BEFORE its parent
  // (clock skew, or an async wrapper) resolved to a forward reference, and
  // a span naming itself as parent resolved to itself. `validateTraceInput`
  // rejects both, so `otel serve` was persisting rows that `ingest` refuses
  // — an export → ingest round-trip of an OTel trace failed. Keep only a
  // strictly-earlier parent; `otel_parent_span_id` stays in metadata either
  // way, which is what the cross-batch re-link uses.
  const resolvedParent = s.parentSpanId ? stepNumberOf.get(s.parentSpanId) : undefined;
  const parent = resolvedParent != null && resolvedParent < i + 1 ? resolvedParent : undefined;
  // A span whose end precedes its own start (clock skew across hosts, or a
  // hand-rolled exporter) produced a NEGATIVE duration, which
  // `validateTraceInput` rejects — so `otel serve` persisted rows `ingest`
  // refuses, the same round-trip break already fixed for parentage above,
  // and the UI rendered a negative millisecond count. Drop the contradictory
  // value rather than clamping it to 0: 0 would assert the call was instant,
  // where null truthfully says the timing is unknown — exactly what the
  // no-timing branch does, and what `effectiveDurationMs` already does with
  // a backwards started_at/ended_at pair.
  // Both stamps must be ones `isoFromNanos` can render, exactly like the
  // trace-level window below. Guarding only the FORMATTING left a step with
  // `ended_at: null` beside a duration of ~56,000 years, computed from the
  // very stamp the formatter had just rejected — and the value is finite and
  // non-negative, so validation stores it.
  const stepEnd = s.end != null && isoFromNanos(s.end) != null ? s.end : null;
  const stepStart = s.start != null && isoFromNanos(s.start) != null ? s.start : null;
  const duration = stepEnd != null && stepStart != null && stepEnd >= stepStart
    ? Math.round((stepEnd - stepStart) / 1e6)
    : null;
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
    // `tool.name` is OpenInference's spelling, alongside GenAI's
    // `gen_ai.tool.name` and OpenLLMetry's `traceloop.entity.name`; without
    // it an OpenInference tool span fell back to the raw span name.
    // A step name is REQUIRED and must be non-empty: `ingest` refuses an empty
    // one (validators.ts) and so does the native `record` path, but this mapper
    // stored `String(s.name ?? '')` — so a span with no `name` (legal OTLP;
    // exporters that carry the operation only in attributes emit it) produced a
    // step named "" that this tool's own `export --format json` could not feed
    // back through `ingest`. That is the record/ingest drift class this file has
    // already been bitten by twice. Fall through to the operation name, then a
    // generic label, so the value is always something a reader can act on.
    name:
      str(s.attrs['gen_ai.tool.name']) ??
      str(s.attrs['tool.name']) ??
      str(s.attrs['traceloop.entity.name']) ??
      str(s.name) ??
      str(s.attrs['gen_ai.operation.name']) ??
      'span',
    input: messageContent(s.attrs, 'input'),
    output,
    started_at: isoFromNanos(s.start),
    // `?? null` because isoFromNanos returns undefined for a stamp it cannot
    // render; the column's "no end" value is null, not an absent key.
    ended_at: (s.end ? isoFromNanos(s.end) : null) ?? null,
    duration_ms: duration,
    tokens_used: tokens || null,
    model: str(s.attrs['gen_ai.request.model']) ?? str(s.attrs['gen_ai.response.model']) ?? str(s.attrs['llm.model_name']) ?? null,
    error: s.errorMessage,
    parent_step: parent ?? null,
    metadata: stepMetadata(s.attrs, s.spanId, s.parentSpanId),
  };
}

/**
 * A mapped batch, plus the identity root rendered as a step.
 *
 * The first root span becomes the TRACE (its name, agent, timing and messages
 * are the trace's own), so it is deliberately not among `steps`. That is right
 * for the batch that opens the trace, and wrong for every later one: a span
 * exporter flushes inner spans first, so a second batch carrying another root
 * (GenAI emits `create_agent` before `invoke_agent`; multi-agent runs nest
 * `invoke_agent`) promoted that root to an identity the trace already had, and
 * merging inserts only `steps` — so the span produced no row at all, and the
 * accepted-span count reported more than was stored. Whether a span survives
 * must not depend on where the exporter cut its batches. The field is transport
 * only: `ingestTrace` ignores it (a new trace keeps the root as identity, with
 * no duplicate step) and the merge path appends it.
 */
export type MappedOtelTrace = IngestTraceInput & { otel_identity_root_step?: IngestStepInput };

export function mapOtlpTraces(otlp: Record<string, unknown>): MappedOtelTrace[] {
  const spans = flattenSpans(otlp);
  const byTrace = new Map<string, FlatSpan[]>();
  spans.forEach((s, i) => {
    // A span with no trace id still becomes a synthetic trace rather than being
    // rejected (a deliberate choice — see the orphan-span test), but it must not
    // be GROUPED with other id-less spans: flattenSpans normalizes a missing
    // traceId to '', and grouping on that value fused every orphan in the batch
    // — across unrelated `resourceSpans` entries — into one trace, attributed to
    // whichever service sorted earliest and with all their tokens summed. A
    // collector fanning in two services was enough. The trace id is the only
    // correlation key there is, so with none present, correlate nothing: give
    // each orphan its own group. The stored `otel_trace_id` stays '', which
    // findMergeTarget already refuses to merge across batches.
    const key = s.traceId || `!orphan:${i}`;
    const list = byTrace.get(key) ?? [];
    list.push(s);
    byTrace.set(key, list);
  });

  const traces: MappedOtelTrace[] = [];
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

    // The root's own usage counts toward the trace. It is excluded from
    // stepSpans, so summing only those dropped it: a single-span agent trace
    // reported `total_tokens: null` despite carrying 150 tokens.
    let totalTokens = root ? spanTokens(root.attrs) : 0;
    let totalCost = root ? costUsd(root.attrs) : 0;
    // The TRACE's outcome is the ROOT span's outcome, not "did any span fail".
    //
    // Deriving it from any child made this the only capture path that promotes
    // a step failure to a run failure: the other eight all store `completed`
    // for a run containing a failed tool call, `openspec/specs/telemetry-ingest`
    // says a span error becomes a STEP error and nothing more, and the eval
    // design says so explicitly — `no_error_steps` is deliberately not critical
    // for a recovered error, "every imported session containing a single failed
    // shell command would otherwise fail it outright". Promoting it reintroduced
    // that through the back door: the identical run scored 0.700 and PASSED via
    // `ingest` while FAILING at exit 1 via OTel, and `check --golden` reported a
    // status regression between two captures of the same session.
    //
    // A trace with no root at all (a rootless synthetic group) has no outcome of
    // its own to read, so there it still falls back to the child spans.
    const rootError = root ? root.errorMessage : undefined;
    const anyError = root ? rootError != null : group.some((s) => s.errorMessage);

    const steps: IngestStepInput[] = stepSpans.map((s, i) => {
      totalTokens += spanTokens(s.attrs);
      totalCost += costUsd(s.attrs);
      return spanToStep(s, i, stepNumberOf);
    });

    // The trace spans from the earliest span start (group is sorted by start)
    // to the latest span end; derive the trace-level end time and duration so
    // OTel-ingested traces show a duration instead of "-".
    // Only stamps `isoFromNanos` can actually render count. It rejects a value
    // outside the four-digit-year window, so keeping such a stamp in this set
    // produced a trace with `ended_at: null` and a ~31-million-year
    // `total_duration_ms` on the same row — the duration was derived from the raw
    // nanos while the formatting guard silently dropped the timestamp.
    const spanEnds = group.map((s) => s.end).filter((e): e is number => e != null && isoFromNanos(e) != null);
    const maxEnd = spanEnds.length ? Math.max(...spanEnds) : undefined;
    // Earliest VALID start (a span missing startTimeUnixNano flattens to 0, which
    // is not a real 1970 timestamp), so one start-less span can't null the whole
    // trace's start/duration when other spans are properly timed.
    const spanStarts = group.map((s) => s.start).filter((st): st is number => st > 0 && isoFromNanos(st) != null);
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
      // Numbered after the real steps; the merge renumbers by start time anyway,
      // and a new trace never reads this field.
      otel_identity_root_step: root ? spanToStep(root, stepSpans.length, stepNumberOf) : undefined,
      agent_name: agentName,
      trigger: 'api',
      status: anyError ? 'failed' : 'completed',
      // A failed trace must say why. It was stored `failed` with `error: null`,
      // so `show` rendered "✘ FAILED" with no reason anywhere on the page.
      error: anyError ? (rootError ?? group.map((s) => s.errorMessage).find(Boolean) ?? 'error') : null,
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
      // Same skew guard as the per-step duration: maxEnd and minStart come from
      // independent sets, so one backwards span can put the latest end before
      // the earliest start and make the whole trace's duration negative.
      total_duration_ms:
        maxEnd != null && minStart != null && maxEnd >= minStart
          ? Math.round((maxEnd - minStart) / 1e6)
          : null,
      total_tokens: totalTokens || null,
      total_cost_usd: totalCost || null,
      // Carry the root's own attributes (model, provider, and any unmapped
      // gen_ai.* keys) the way every step already does — they were dropped
      // entirely, so a single-span trace recorded no model or provider at all.
      // The source keys are written last so they can't be shadowed.
      metadata: {
        ...(root ? stepMetadata(root.attrs, root.spanId, root.parentSpanId) : {}),
        source_format: 'otel-genai',
        otel_trace_id: group[0].traceId,
        ...(root ? {} : { synthetic_trace: true }),
      },
      steps,
    });
  }

  return traces;
}

/**
 * The span's prompt/response content.
 *
 * GenAI first, then the two other dialects this receiver already classifies by:
 * OpenInference (`input.value` / `output.value`, and the `llm.prompts` /
 * `llm.completions` pair) and OpenLLMetry (`traceloop.entity.input/output`).
 * Only the `gen_ai.*` forms were read, so a LangChain or LlamaIndex app — the
 * frameworks these conventions come from, and the ones the README names —
 * produced traces whose every step had `input: {}` and `output: null`. The
 * spans were classified, timed and token-counted correctly; they just carried
 * no content, and the raw attributes were not preserved anywhere either, so
 * nothing downstream could recover them.
 *
 * These values are frequently JSON *strings* rather than objects, which is
 * fine: the storage layer passes a JSON string through as-is and encodes
 * anything else, so both survive a round-trip.
 */
function messageContent(a: Record<string, unknown>, dir: 'input' | 'output'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const msgs =
    dir === 'input'
      ? (a['gen_ai.input.messages'] ??
        a['gen_ai.prompt'] ??
        a['input.value'] ??
        a['llm.prompts'] ??
        a['traceloop.entity.input'])
      : (a['gen_ai.output.messages'] ??
        a['gen_ai.completion'] ??
        a['output.value'] ??
        a['llm.completions'] ??
        a['traceloop.entity.output']);
  if (msgs != null) out.messages = msgs;
  return out;
}

function stepMetadata(a: Record<string, unknown>, spanId: string, parentSpanId?: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { otel_span_id: spanId };
  // The span's own spend, kept per step so a batch's contribution can be
  // recomputed from the steps actually retained. The trace-level total is the
  // sum over a whole batch, and a redelivered batch has some of its spans
  // dropped as duplicates — without a per-span figure, the receiver could only
  // add the batch total again and inflate the trace's cost.
  const cost = num(a['gen_ai.usage.cost'] ?? a['cost_usd'] ?? a['cost']);
  if (Number.isFinite(cost) && cost > 0) meta.otel_cost_usd = cost;
  // Preserve the OTel parent span id so a child arriving in a later export batch
  // can be re-linked to a parent step already stored from an earlier batch.
  if (parentSpanId) meta.otel_parent_span_id = parentSpanId;
  // `llm.provider` is OpenInference's spelling — dropped entirely before, so an
  // OpenInference trace recorded no provider despite carrying one.
  const provider = str(a['gen_ai.provider.name']) ?? str(a['gen_ai.system']) ?? str(a['llm.provider']);
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
