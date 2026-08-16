import type { IngestTraceInput, IngestStepInput, IngestDecisionInput } from '../../models/types.js';
import { attrsToMap, decodeAnyValue } from './semconv.js';

/**
 * Map the OTLP log events emitted by the two CLIs that carry richer signal as
 * logs than as spans — Gemini CLI (`gemini_cli.*`) and Claude Code
 * (`claude_code.*`) — onto the trace model. Content fields are stored only when
 * present, since both CLIs redact prompt/response content unless the user opts
 * in on their side.
 */

interface FlatLog {
  eventName: string;
  attrs: Record<string, unknown>;
  time: number;
  body: unknown;
}

export function flattenLogs(otlp: Record<string, unknown>): FlatLog[] {
  const out: FlatLog[] = [];
  for (const rl of (otlp.resourceLogs as unknown[]) ?? []) {
    const rlObj = rl as { resource?: { attributes?: unknown[] }; scopeLogs?: unknown[] };
    const resource = attrsToMap(rlObj.resource?.attributes);
    for (const sl of rlObj.scopeLogs ?? []) {
      for (const lr of ((sl as { logRecords?: unknown[] }).logRecords) ?? []) {
        const r = lr as Record<string, unknown>;
        const attrs = { ...resource, ...attrsToMap(r.attributes as unknown[]) };
        const eventName = str(r.eventName) ?? str(attrs['event.name']) ?? str(r.name) ?? '';
        out.push({ eventName, attrs, time: num(r.timeUnixNano), body: decodeAnyValue(r.body) });
      }
    }
  }
  return out;
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? p : { args: v };
    } catch {
      return { args: v };
    }
  }
  return {};
}

/** Map an OTLP/JSON logs payload into one IngestTraceInput per session id. */
export function mapOtlpLogs(otlp: Record<string, unknown>): IngestTraceInput[] {
  const logs = flattenLogs(otlp).filter((l) => l.eventName.startsWith('gemini_cli.') || l.eventName.startsWith('claude_code.'));

  const bySession = new Map<string, FlatLog[]>();
  for (const l of logs) {
    const sid = str(l.attrs['session.id']) ?? '__nosession__';
    const list = bySession.get(sid) ?? [];
    list.push(l);
    bySession.set(sid, list);
  }

  const traces: IngestTraceInput[] = [];
  for (const [sid, group] of bySession) {
    // Order by event time, but sort a record missing timeUnixNano (which num()
    // flattens to 0) LAST rather than first — otherwise a timestamp-less log
    // record (timeUnixNano is optional in OTLP) sorts ahead of real, timed events
    // and steals step_number 1, mis-ordering the steps. Mirrors the start-less
    // span guard in semconv.ts. (startedAt is already guarded by `&& l.time`.)
    group.sort((a, b) => (a.time || Infinity) - (b.time || Infinity));
    const isGemini = group.some((l) => l.eventName.startsWith('gemini_cli.'));

    let input: Record<string, unknown> | undefined;
    let totalTokens = 0;
    const steps: IngestStepInput[] = [];
    let stepNumber = 1;
    let startedAt: string | undefined;

    for (const l of group) {
      if (!startedAt && l.time) startedAt = new Date(l.time / 1e6).toISOString();
      const a = l.attrs;
      const evt = l.eventName;

      if (evt.endsWith('.user_prompt')) {
        const prompt = str(a.prompt) ?? str(a.prompt_text) ?? (typeof l.body === 'string' ? l.body : undefined);
        if (prompt) input = { prompt };
        continue;
      }

      if (evt === 'gemini_cli.tool_call') {
        const name = str(a.function_name) ?? 'tool';
        const toolStep = stepNumber++;
        steps.push({
          step_number: toolStep,
          step_type: 'tool_call',
          name,
          input: parseArgs(a.function_args),
          output: a.success != null ? { success: a.success } : null,
          duration_ms: numOrNull(a.duration_ms),
          error: toolError(a),
          metadata: { source: 'gemini_cli' },
        });
        const decision = str(a.decision);
        if (decision) {
          steps.push({
            step_number: stepNumber++,
            step_type: 'decision',
            name: `tool_decision:${name}`,
            caused_by_step: toolStep,
            decision: geminiDecision(decision),
          });
        }
        continue;
      }

      if (evt === 'claude_code.tool_result') {
        steps.push({
          step_number: stepNumber++,
          step_type: 'tool_call',
          name: str(a.tool_name) ?? str(a.name) ?? 'tool',
          output: a.success != null ? { success: a.success } : null,
          duration_ms: numOrNull(a.duration_ms),
          error: toolError(a),
          metadata: { source: 'claude_code' },
        });
        continue;
      }

      if (evt === 'claude_code.tool_decision') {
        const name = str(a.tool_name) ?? 'tool';
        const decision = str(a.decision);
        if (decision) {
          steps.push({
            step_number: stepNumber++,
            step_type: 'decision',
            name: `tool_decision:${name}`,
            decision: { chosen: decision, decided_by: decision === 'allow' || decision === 'deny' ? 'user' : 'policy' },
          });
        }
        continue;
      }

      // A failed model call. Previously this matched no branch at all, so the
      // record vanished: a batch of only api_error events mapped to zero traces
      // and still answered 200. Recorded as the llm_call it is, with the failure
      // on `error` — the same shape every other capture path uses for a failure.
      if (evt.endsWith('.api_error')) {
        steps.push({
          step_number: stepNumber++,
          step_type: 'llm_call',
          name: str(a['gen_ai.request.model']) ?? str(a.model) ?? 'api_error',
          error:
            str(a.error) ??
            str(a.error_message) ??
            str(a.error_type) ??
            (a.status_code != null ? `status ${String(a.status_code)}` : 'api error'),
          duration_ms: numOrNull(a.duration_ms),
          metadata: { source: isGemini ? 'gemini_cli' : 'claude_code' },
        });
        continue;
      }

      if (evt.endsWith('.api_response') || evt.endsWith('.api_request')) {
        totalTokens +=
          num(a.input_token_count ?? a['gen_ai.usage.input_tokens'] ?? a.input_tokens) +
          num(a.output_token_count ?? a['gen_ai.usage.output_tokens'] ?? a.output_tokens);
        continue;
      }
    }

    if (steps.length === 0 && !input) continue;

    traces.push({
      agent_name: isGemini ? 'gemini' : 'claude-code',
      trigger: 'user_message',
      // Derived, not hardcoded. `completed` was unconditional, so a session
      // whose tool calls or model calls all failed was still reported as a
      // clean run — the failure was invisible to `list`, `check --golden`, and
      // eval's error criteria alike.
      status: steps.some((st) => st.error != null) ? 'failed' : 'completed',
      session_id: sid === '__nosession__' ? null : sid,
      input: input ?? {},
      started_at: startedAt,
      total_tokens: totalTokens || null,
      metadata: { source_format: isGemini ? 'gemini-cli-logs' : 'claude-code-logs' },
      steps,
    });
  }

  return traces;
}

/** Gemini decision → decision record. auto_accept is a policy call; the rest are the user's. */
function geminiDecision(decision: string): IngestDecisionInput {
  return {
    chosen: decision,
    decided_by: decision === 'auto_accept' ? 'policy' : 'user',
  };
}

/**
 * The failure text for a tool-call log record, or undefined if it succeeded.
 *
 * `success: false` used to produce only `output: {success: false}` — the error
 * text and error_type were dropped and the step carried no `error` at all, so
 * every error-aware consumer (eval's error criteria, `check --golden`, the
 * timeline) read a failed run as a clean one. A failed tool is recorded as a
 * `tool_call` step with `error` set, matching every other capture path.
 */
function toolError(a: Record<string, unknown>): string | undefined {
  if (a.success !== false) return undefined;
  return str(a.error) ?? str(a.error_message) ?? str(a.error_type) ?? 'tool failed';
}

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
function numOrNull(v: unknown): number | null {
  // Preserve a genuine 0 (an instant/cached tool call really does take 0 ms) —
  // `num(v) || null` collapsed it to null, the same class as the hook 0 ms
  // duration fix. Only an absent or non-numeric value becomes null.
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
