import { generateId } from '../utils/id.js';
import type { CaptureEvent } from './event-protocol.js';

/**
 * Translators for the documented non-interactive event streams of the major
 * CLIs into our native capture events (see event-protocol.ts). Each is a
 * stateful, line-at-a-time translator: `translate` maps one native event to
 * zero or more capture events, and `finalize` emits any trailing events at EOF.
 *
 * These map the documented event *types*; sub-fields whose exact names are
 * vendor-internal are preserved in step output/metadata rather than guessed.
 */
export interface StreamTranslator {
  translate(obj: Record<string, unknown>): CaptureEvent[];
  finalize(): CaptureEvent[];
}

abstract class BaseTranslator implements StreamTranslator {
  protected traceId: string | null = null;
  protected step = 0;
  protected totalTokens = 0;
  protected failed = false;
  protected errorText: string | null = null;
  protected ended = false;

  protected abstract agentName: string;

  /** Lazily open the trace (some streams emit items before the start event). */
  protected ensureStart(sessionId?: string, input?: Record<string, unknown>): CaptureEvent[] {
    if (this.traceId) return [];
    this.traceId = generateId('trc');
    return [
      {
        v: 1,
        type: 'trace_start',
        trace_id: this.traceId,
        agent_name: this.agentName,
        session_id: sessionId ?? null,
        input: input ?? {},
      },
    ];
  }

  protected nextStep(): number {
    return ++this.step;
  }

  abstract translate(obj: Record<string, unknown>): CaptureEvent[];

  finalize(): CaptureEvent[] {
    if (!this.traceId || this.ended) return [];
    this.ended = true;
    return [
      {
        v: 1,
        type: 'trace_end',
        trace_id: this.traceId,
        status: this.failed ? 'failed' : 'completed',
        error: this.errorText,
        total_tokens: this.totalTokens || null,
      },
    ];
  }
}

// ── Codex `codex exec --json` ───────────────────────────────────────────────

const CODEX_ITEM_STEP_TYPE: Record<string, string> = {
  agent_message: 'output',
  reasoning: 'thought',
  command_execution: 'tool_call',
  mcp_tool_call: 'tool_call',
  file_change: 'tool_call',
  web_search: 'retrieval',
};

export class CodexExecTranslator extends BaseTranslator {
  protected agentName = 'codex';

  translate(obj: Record<string, unknown>): CaptureEvent[] {
    const type = String(obj.type ?? '');

    if (type === 'thread.started') {
      const threadId = str(obj.thread_id);
      return this.ensureStart(threadId, {});
    }

    if (type === 'turn.completed') {
      const usage = obj.usage as Record<string, number> | undefined;
      if (usage) this.totalTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      return [];
    }

    if (type === 'turn.failed' || type === 'error') {
      this.failed = true;
      this.errorText = str((obj.error as Record<string, unknown>)?.message) ?? str(obj.message) ?? 'run failed';
      return [];
    }

    if (type === 'item.completed') {
      const item = (obj.item as Record<string, unknown>) ?? obj;
      const itemType = str(item.item_type) ?? str(item.type) ?? 'item';
      const stepType = CODEX_ITEM_STEP_TYPE[itemType] ?? 'thought';
      const pre = this.ensureStart();
      return [
        ...pre,
        {
          v: 1,
          type: 'step',
          trace_id: this.traceId!,
          step_number: this.nextStep(),
          step_type: stepType,
          name: itemType,
          input: item.command != null ? { command: item.command } : {},
          output: item as Record<string, unknown>,
          metadata: { source: 'codex-exec', item_type: itemType },
        } as CaptureEvent,
      ];
    }

    return [];
  }
}

// ── Gemini `--output-format stream-json` ────────────────────────────────────

export class GeminiStreamTranslator extends BaseTranslator {
  protected agentName = 'gemini';
  private openTools = new Map<string, number>();

  translate(obj: Record<string, unknown>): CaptureEvent[] {
    const type = String(obj.type ?? '');

    if (type === 'init') {
      const session = str(obj.session_id) ?? str((obj.session as Record<string, unknown>)?.id);
      return this.ensureStart(session, {});
    }

    if (type === 'tool_use') {
      const pre = this.ensureStart();
      const num = this.nextStep();
      const id = str(obj.id) ?? str(obj.tool_use_id);
      if (id) this.openTools.set(id, num);
      return [
        ...pre,
        {
          v: 1,
          type: 'step_start',
          trace_id: this.traceId!,
          step_number: num,
          step_type: 'tool_call',
          name: str(obj.name) ?? 'tool',
          input: (obj.input as Record<string, unknown>) ?? {},
          metadata: { source: 'gemini-stream' },
        } as CaptureEvent,
      ];
    }

    if (type === 'tool_result') {
      const id = str(obj.id) ?? str(obj.tool_use_id);
      const num = id ? this.openTools.get(id) : undefined;
      if (num == null) return [];
      this.openTools.delete(id!);
      return [
        {
          v: 1,
          type: 'step_end',
          trace_id: this.traceId!,
          step_number: num,
          output: ((obj.output ?? obj.result) as Record<string, unknown>) ?? null,
        } as CaptureEvent,
      ];
    }

    if (type === 'message') {
      const pre = this.ensureStart();
      const content = obj.content ?? obj.text;
      return [
        ...pre,
        {
          v: 1,
          type: 'step',
          trace_id: this.traceId!,
          step_number: this.nextStep(),
          step_type: 'output',
          name: 'message',
          output: typeof content === 'string' ? { text: content } : (content as Record<string, unknown>) ?? {},
          metadata: { source: 'gemini-stream' },
        } as CaptureEvent,
      ];
    }

    if (type === 'error') {
      this.failed = true;
      this.errorText = str(obj.message) ?? str((obj.error as Record<string, unknown>)?.message) ?? 'run failed';
      return [];
    }

    if (type === 'result') {
      // Exit-code convention: 0 ok; 1/42/53 are failures.
      const code = Number(obj.exit_code ?? obj.code ?? 0);
      if (code !== 0) {
        this.failed = true;
        this.errorText = this.errorText ?? `exited with code ${code}`;
      }
      return this.finalize();
    }

    return [];
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function makeTranslator(format: string): StreamTranslator | null {
  if (format === 'codex-exec') return new CodexExecTranslator();
  if (format === 'gemini-stream') return new GeminiStreamTranslator();
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
