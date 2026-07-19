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
    group.sort((a, b) => a.time - b.time);
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
      status: 'completed',
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
  const n = num(v);
  return n || null;
}
