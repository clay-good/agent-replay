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
  /**
   * Why the LAST `translate` call produced no events, or null if producing none
   * was normal.
   *
   * An empty return is ambiguous on its own: a second `init` line legitimately
   * yields nothing, and so does a line whose type this translator has never
   * heard of — but only one of those is data loss. `record` reports how many
   * lines it rejected precisely so a silent drop is impossible, and the
   * translated formats had no counter at all: a `tool_result` that paired with
   * no open call took its payload with it and the run still reported
   * "Warnings: 0". This lets the caller tell the two apart without the
   * translator having to invent an event.
   */
  lastSkip(): string | null;
}

abstract class BaseTranslator implements StreamTranslator {
  protected traceId: string | null = null;
  protected step = 0;
  protected totalTokens = 0;
  /** The agent's last message, carried into `trace_end.output`. */
  protected finalOutput = '';
  protected failed = false;
  protected errorText: string | null = null;
  protected ended = false;
  // Whether this stream has a terminal event that signals a clean end (Gemini's
  // `result`). If so, reaching EOF without it means the run was interrupted.
  protected expectsTerminalEvent = false;
  protected sawTerminal = false;
  /** Set by a translator when it drops a line; read and cleared by `lastSkip`. */
  protected skipReason: string | null = null;

  lastSkip(): string | null {
    const reason = this.skipReason;
    this.skipReason = null;
    return reason;
  }

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

  /**
   * The model the session's most recent model-bearing record named, or null
   * until one does.
   *
   * Neither translator recorded a model anywhere, while every sibling capture
   * path does — the claude-transcript and codex-rollout importers each track a
   * current model and stamp the steps a record produced, and the OTel span and
   * log mappers do the same. A step's `model` is the field `check --golden
   * --fields model` compares and the one `diff` reports a change in, so a
   * model swap between two `record --format codex-exec` / `gemini-stream` runs
   * was invisible, and `show`/`replay` never showed which model produced a
   * step.
   *
   * Tracked as a running cursor rather than read once: a session that switches
   * models mid-run says so on a later record, and the steps before it belong to
   * the earlier one. There is no trace-level model column, so an unstamped step
   * carries the value nowhere at all.
   */
  protected currentModel: string | null = null;

  /**
   * Read the model a record states, from the containers this file already
   * destructures (the record, its `item`, its `session`). Read from EVERY
   * record rather than only the ones that produce a model-bearing step: the
   * value names a property of the SESSION, and one read cannot miss a branch —
   * the mistake the OTel log mapper made by reading it in the error branch
   * alone. No vendor-internal name is guessed: `model` is the same key the
   * importers for these two harnesses read.
   */
  private readModel(obj: Record<string, unknown>): void {
    const m =
      str(obj.model) ??
      str((obj.item as Record<string, unknown> | undefined)?.model) ??
      str((obj.message as Record<string, unknown> | undefined)?.model) ??
      str((obj.session as Record<string, unknown> | undefined)?.model);
    if (m) this.currentModel = m;
  }

  translate(obj: Record<string, unknown>): CaptureEvent[] {
    // Before the record's own steps are built, so a record that both names a
    // model and produces steps stamps them with the model in effect at THEIR
    // time rather than the previous one.
    this.readModel(obj);
    const events = this.translateEvent(obj);
    if (this.currentModel) {
      for (const e of events) {
        if (e.type !== 'step' && e.type !== 'step_start') continue;
        // Never overwrite a value a branch set itself, and never invent one:
        // with no model reported, steps stay null, which is the honest absence
        // `check` skips rather than fails on.
        if (e.model == null) e.model = this.currentModel;
      }
    }
    return events;
  }

  /**
   * Map one native record. Every step this returns is stamped with the current
   * model by `translate` above, so a branch does not have to remember to.
   */
  protected abstract translateEvent(obj: Record<string, unknown>): CaptureEvent[];

  finalize(): CaptureEvent[] {
    if (!this.traceId || this.ended) return [];
    // A stream that declares a terminal event but hit EOF without one (and
    // without a recorded failure) was interrupted — killed or crashed. Emit no
    // trace_end so the trace stays running and `record` finalizes it as timeout
    // (or `--leave-open` keeps it open), matching the native protocol. Without
    // this, an interrupted gemini-stream run was silently recorded as completed.
    if (this.expectsTerminalEvent && !this.sawTerminal && !this.failed) {
      this.ended = true;
      return [];
    }
    this.ended = true;
    return [
      {
        v: 1,
        type: 'trace_end',
        trace_id: this.traceId,
        status: this.failed ? 'failed' : 'completed',
        error: this.errorText,
        // The agent's final message. Both translators already see it (a codex
        // `agent_message` item, a gemini `message`) and neither passed it on,
        // so a run captured this way stored `output: null` — and its golden
        // export therefore carried `expected_output: null` while an import of
        // the same session carried the text. `diff` between the two reported a
        // `trace_output` divergence for one identical run.
        output: this.finalOutput ? { text: this.finalOutput } : null,
        total_tokens: this.totalTokens || null,
      },
    ];
  }
}

/** The first whitespace-separated token of a command, as a step name. */
function firstToken(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().split(/\s+/)[0];
  return t || undefined;
}

/** Text from a string, or from a content array of `{text}` parts. */
function asTextValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? '')).filter(Boolean).join('\n');
  }
  return '';
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
  // `turn.completed` is this stream's terminal event, so reaching EOF without
  // it means the run was interrupted. Without this the trace was closed as
  // `completed`, reporting a killed run as a clean one — the same defect
  // already fixed for the gemini stream.
  protected expectsTerminalEvent = true;

  protected translateEvent(obj: Record<string, unknown>): CaptureEvent[] {
    const type = String(obj.type ?? '');

    if (type === 'thread.started') {
      const threadId = str(obj.thread_id);
      return this.ensureStart(threadId, {});
    }

    if (type === 'turn.completed') {
      this.sawTerminal = true;
      const usage = obj.usage as Record<string, unknown> | undefined;
      // Coerce: `usage` is only *cast* to numbers, so a producer sending
      // "5"/"7" made `0 + "5" + "7"` concatenate to "057" and store 57 tokens
      // instead of 12, silently and with no warning.
      if (usage) this.totalTokens += toNum(usage.input_tokens) + toNum(usage.output_tokens);
      return [];
    }

    if (type === 'turn.failed' || type === 'error') {
      this.failed = true;
      this.errorText = str((obj.error as Record<string, unknown>)?.message) ?? str(obj.message) ?? 'run failed';
      return [];
    }

    if (type === 'item.completed') {
      // Normalize a non-object item — `{"type":"item.completed","item":"text"}`
      // is a shape the CLI can emit, and storing the bare string put a JSON
      // scalar in the `output` column where every reader expects an object.
      // The gemini tool_result branch already wraps a bare string for exactly
      // this reason; the two branches now agree.
      const rawItem = obj.item ?? obj;
      const item: Record<string, unknown> =
        rawItem !== null && typeof rawItem === 'object' && !Array.isArray(rawItem)
          ? (rawItem as Record<string, unknown>)
          : { output: rawItem };
      const itemType = str(item.item_type) ?? str(item.type) ?? 'item';
      const stepType = CODEX_ITEM_STEP_TYPE[itemType] ?? 'thought';
      const pre = this.ensureStart();
      // Same gap the gemini tool_result branch had, in the same file: a failed
      // item was stored as a clean step, so nothing downstream could see the
      // failure (ai-root-cause is "not applicable" without a failing step and
      // scores a 100% PASS; a golden step_errors baseline has no failure to
      // regress against). Only unambiguous, shape-generic signals are read, and
      // the whole item is preserved as `output` either way.
      const itemError = codexItemError(item);
      if (stepType === 'output') {
        const text = asTextValue(item.text ?? item.message ?? item.content ?? item.output);
        if (text) this.finalOutput = text;
      }
      return [
        ...pre,
        {
          v: 1,
          type: 'step',
          trace_id: this.traceId!,
          step_number: this.nextStep(),
          step_type: stepType,
          // A specific name when the item carries one. Naming every step after
          // the item TYPE made `command_execution` the name of every tool call,
          // so `check --golden --fields step_names` was permanently inert for
          // this format — two completely unrelated codex sessions produced
          // byte-identical step names — and it disagreed with the
          // codex-rollout importer, which names the same steps `search_flights`
          // / `book_flight`. Falls back to the type, which is all some items
          // have.
          name: str(item.name) ?? str(item.tool) ?? firstToken(item.command) ?? itemType,
          input: codexItemInput(item),
          output: item as Record<string, unknown>,
          error: itemError,
          metadata: { source: 'codex-exec', item_type: itemType },
        } as CaptureEvent,
      ];
    }

    // A line of a kind this translator does not know. Harnesses add event types
    // between releases, so this is expected — but it must be counted, since the
    // alternative is a stream that silently loses whatever the new type carries
    // while reporting a clean capture.
    this.skipReason = `unrecognized codex-exec event type ${JSON.stringify(type)}`;
    return [];
  }
}

// ── Gemini `--output-format stream-json` ────────────────────────────────────

export class GeminiStreamTranslator extends BaseTranslator {
  protected agentName = 'gemini';
  // A clean Gemini run always emits a terminal `result` event; EOF without it
  // means the run was interrupted, so it should be timed out, not completed.
  protected expectsTerminalEvent = true;
  private openTools = new Map<string, number>();
  /**
   * Every still-open tool step in the order it started, so a result that cannot
   * be matched by id can still be paired. A `tool_result` used to be DISCARDED
   * outright whenever the id was missing, unknown, or arrived before its
   * `tool_use` — and the branch accepts a `tool_use` with no id in the first
   * place, so an entirely id-less stream lost every result. The step was left
   * open forever with no output and, worse, no `error`: a run whose every tool
   * call failed was stored clean, which is the same fail-open the error path
   * below was written to close.
   *
   * Matched OLDEST-FIRST, and a result naming a tool that no open call matches
   * is left UNPAIRED. An earlier version took the most recent open step, citing
   * `hook-adapter`'s `findOpenToolStep` as precedent — but that function
   * documents its own `ORDER BY step_number DESC` as the CAUSE of a mis-pairing
   * bug, for exactly the reason that applies here: harnesses dispatch tools in
   * parallel batches and the results come back in call order. With two calls
   * open, LIFO handed each result to the other one's step: both outputs
   * swapped, the call that SUCCEEDED marked failed, and the call that failed
   * stored clean. A wrong precedent is worse than none.
   */
  private openOrder: Array<{ num: number; name: string }> = [];

  /** Resolve a result to the step it closes, by id when possible. */
  private resolveToolStep(id: string | undefined, name: string | undefined): number | undefined {
    if (id != null) {
      const byId = this.openTools.get(id);
      if (byId != null) return byId;
    }
    if (name != null) {
      // Oldest open call with this name — results arrive in call order.
      const named = this.openOrder.find((o) => o.name === name);
      // A NAME matching nothing open is not evidence about some other call.
      // Attaching here would move a failure onto an unrelated tool, and
      // fabricating a failure is the expensive direction — the same asymmetry
      // the codex exit-code reader applies. Leave it unpaired instead.
      return named?.num;
    }
    return this.openOrder.length > 0 ? this.openOrder[0].num : undefined;
  }

  /** Forget a step once its result has closed it. */
  private closeToolStep(num: number): void {
    for (const [key, value] of this.openTools) if (value === num) this.openTools.delete(key);
    this.openOrder = this.openOrder.filter((o) => o.num !== num);
  }

  protected translateEvent(obj: Record<string, unknown>): CaptureEvent[] {
    const type = String(obj.type ?? '');

    if (type === 'init') {
      const session = str(obj.session_id) ?? str((obj.session as Record<string, unknown>)?.id);
      return this.ensureStart(session, {});
    }

    if (type === 'tool_use') {
      const pre = this.ensureStart();
      const num = this.nextStep();
      const id = str(obj.id) ?? str(obj.tool_use_id);
      const toolName = str(obj.name) ?? 'tool';
      if (id) this.openTools.set(id, num);
      this.openOrder.push({ num, name: toolName });
      return [
        ...pre,
        {
          v: 1,
          type: 'step_start',
          trace_id: this.traceId!,
          step_number: num,
          step_type: 'tool_call',
          name: toolName,
          input: (obj.input as Record<string, unknown>) ?? {},
          metadata: { source: 'gemini-stream' },
        } as CaptureEvent,
      ];
    }

    if (type === 'tool_result') {
      const id = str(obj.id) ?? str(obj.tool_use_id);
      const num = this.resolveToolStep(id, str(obj.name));
      if (num == null) {
        // This is the costly drop: the result carries the tool's OUTPUT, and
        // with no open call to attach it to the payload is gone. Leaving the
        // call open is the right repair — inventing a step for it would
        // fabricate a call the agent never made — but it must be reported, or
        // a tool call is stored looking clean and output-less.
        this.skipReason = `tool_result matched no open tool call${id ? ` (id ${id})` : ''}`;
        return [];
      }
      this.closeToolStep(num);
      // Wrap a bare-string result in an object (like the `message` handler
      // below). A raw string is stored verbatim as TEXT and then fails to
      // JSON.parse on read, so the tool output would silently come back null.
      const out = obj.output ?? obj.result;
      // Mirror every sibling capture path (hook-adapter, claude-transcript): a
      // failed tool call keeps step_type 'tool_call' but populates `error`, so
      // the failure survives into the store. This branch had no error path at
      // all, so a run whose every tool call failed was recorded as clean —
      // `isErrorStep` saw nothing, `eval --preset ai-root-cause` was therefore
      // "not applicable" and scored a 100% PASS, and a `check --golden`
      // step_errors baseline had no failure to regress against.
      //
      // Only unambiguous, shape-generic signals are read, per this file's rule
      // of not guessing vendor-internal field names: the whole result object is
      // preserved in `output` either way, so a stream that signals failure some
      // other way is no worse off than before.
      //
      // Both signals are read the way `otel/log-events.toolError` reads its
      // own: an exporter that stringifies values sends `"true"`, and — the
      // dangerous direction — a producer that always emits the key sends
      // `error: ""` or `error: false` on SUCCESS. Keying on `!= null` turned
      // those into fabricated failing steps, which feed `check --golden`
      // step_errors and the eval error criteria: exit 1 on a clean run. An
      // error must be a non-empty value to count.
      const failed = isTrueish(obj.is_error) || errText(obj.error) != null;
      return [
        {
          v: 1,
          type: 'step_end',
          trace_id: this.traceId!,
          step_number: num,
          output: typeof out === 'string' ? { output: out } : ((out as Record<string, unknown>) ?? null),
          error: failed ? (errText(obj.error) ?? errText(out) ?? 'tool failed') : undefined,
        } as CaptureEvent,
      ];
    }

    if (type === 'message') {
      const pre = this.ensureStart();
      const content = obj.content ?? obj.text;
      const text = asTextValue(content);
      if (text) this.finalOutput = text;
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
      // The terminal event — a clean end. Exit-code convention: 0 ok; nonzero
      // is a failure.
      this.sawTerminal = true;
      // Guarded the same way `codexItemError` is, and for the same reason: an
      // unparseable value made `Number()` NaN, which is `!== 0`, so a
      // non-numeric exit code (`"abc"`, a Node-style `code: "ENOENT"` reaching
      // the `?? obj.code` fallback, an object) FABRICATED a trace-level failure
      // and reported its reason as the literal "exited with code NaN". A code we
      // cannot read is not evidence the run failed.
      // Token usage, read the same way the codex translator reads its own —
      // this branch ignored it entirely, so EVERY gemini-stream capture stored
      // "-" tokens while the identical field worked for codex-exec, leaving
      // `stats`, `list --sort tokens` and every budget-shaped reading inert for
      // one of the two supported formats. Coerced with toNum for the same
      // reason: a producer sending "5"/"7" would otherwise concatenate.
      const usage = (obj.usage as Record<string, unknown> | undefined)
        ?? ((obj.stats as Record<string, unknown> | undefined)?.tokens as Record<string, unknown> | undefined);
      if (usage) {
        // Prefer an explicit total; fall back to the input/output pair. A
        // producer sends one shape or the other, and adding both would double
        // count a stream that sends a total ALONGSIDE its components.
        const total = toNum(usage.total_tokens) || toNum(usage.total);
        this.totalTokens += total || toNum(usage.input_tokens) + toNum(usage.output_tokens);
      }

      const raw = obj.exit_code ?? obj.code ?? 0;
      const code = typeof raw === 'number' ? raw
        : typeof raw === 'string' && raw.trim() !== '' ? Number(raw)
        : NaN;
      if (Number.isFinite(code) && code !== 0) {
        this.failed = true;
        this.errorText = this.errorText ?? `exited with code ${code}`;
      }
      return this.finalize();
    }

    this.skipReason = `unrecognized gemini-stream event type ${JSON.stringify(type)}`;
    return [];
  }
}

// ── Claude Code `--output-format stream-json` ───────────────────────────────

/** One content block of an Anthropic message, as the stream carries them. */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * `claude -p "..." --output-format stream-json`.
 *
 * Claude Code was reachable through hooks and OpenTelemetry but not by piping,
 * which is the path a CI job actually uses — `claude -p` in a script has no
 * settings file to register hooks in and no collector to point at.
 *
 * The record shapes are not guessed: this stream carries the same `system` /
 * `assistant` / `user` / `result` records, with the same Anthropic content
 * blocks, that `importers/claude-transcript.ts` already reads off disk, so the
 * two paths are kept deliberately in step — `text` becomes an `output` step,
 * `thinking` a `thought` step, and a `tool_use`/`tool_result` pair one
 * `tool_call` step that records the result's failure on its `error` field.
 *
 * The prompt is NOT read from the stream: `claude -p` takes it as a
 * command-line argument, exactly as codex and gemini do, and `record --input`
 * is how it gets supplied. Inventing one from the first `user` record would
 * capture a tool-result echo as the run's question.
 */
export class ClaudeStreamTranslator extends BaseTranslator {
  protected agentName = 'claude-code';
  // `result` is this stream's terminal event, so EOF without it means the run
  // was interrupted — the same rule both sibling translators follow.
  protected expectsTerminalEvent = true;
  /** Open tool steps by `tool_use` id, which this stream always supplies. */
  private openTools = new Map<string, number>();

  protected translateEvent(obj: Record<string, unknown>): CaptureEvent[] {
    const type = String(obj.type ?? '');

    if (type === 'system') {
      // `subtype: "init"` opens the session; any other system record is
      // informational and opens nothing on its own.
      const session = str(obj.session_id);
      return str(obj.subtype) === 'init' ? this.ensureStart(session, {}) : [];
    }

    if (type === 'assistant' || type === 'user') {
      const message = obj.message as Record<string, unknown> | undefined;
      // Usage is counted from the ASSISTANT record only. A `user` record in this
      // stream carries tool results, and any usage echoed on it belongs to the
      // turn already counted — adding both double counts the session.
      if (type === 'assistant' && message?.usage) {
        this.totalTokens += claudeUsageTokens(message.usage as Record<string, unknown>);
      }
      const content = message?.content;
      const blocks: ContentBlock[] = Array.isArray(content)
        ? (content as ContentBlock[])
        // A string `content` is the whole message, which the transcript
        // importer handles too — normalized here so one code path covers both.
        : typeof content === 'string'
          ? [{ type: type === 'assistant' ? 'text' : 'input_text', text: content }]
          : [];

      const pre = this.ensureStart(str(obj.session_id));
      const events: CaptureEvent[] = [...pre];
      for (const block of blocks) {
        switch (block?.type) {
          case 'text': {
            if (type !== 'assistant' || !block.text) break;
            this.finalOutput = block.text;
            events.push({
              v: 1,
              type: 'step',
              trace_id: this.traceId!,
              step_number: this.nextStep(),
              step_type: 'output',
              name: 'assistant_message',
              output: { text: block.text },
              metadata: { source: 'claude-stream' },
            } as CaptureEvent);
            break;
          }
          case 'thinking': {
            events.push({
              v: 1,
              type: 'step',
              trace_id: this.traceId!,
              step_number: this.nextStep(),
              step_type: 'thought',
              name: 'thinking',
              output: { text: block.thinking ?? block.text ?? '' },
              metadata: { source: 'claude-stream' },
            } as CaptureEvent);
            break;
          }
          case 'tool_use': {
            const num = this.nextStep();
            if (block.id) this.openTools.set(block.id, num);
            events.push({
              v: 1,
              type: 'step_start',
              trace_id: this.traceId!,
              step_number: num,
              step_type: 'tool_call',
              name: str(block.name) ?? 'tool',
              input: block.input ?? {},
              metadata: { source: 'claude-stream', tool_use_id: block.id ?? null },
            } as CaptureEvent);
            break;
          }
          case 'tool_result': {
            const num = block.tool_use_id != null ? this.openTools.get(block.tool_use_id) : undefined;
            if (num == null) {
              // Reported, not swallowed: the result carries the tool's output,
              // and with no open call to attach it to that payload is gone —
              // the same loss the gemini branch counts.
              this.skipSkipped(`tool_result matched no open tool call${block.tool_use_id ? ` (id ${block.tool_use_id})` : ''}`);
              break;
            }
            if (block.tool_use_id) this.openTools.delete(block.tool_use_id);
            const text = blockText(block.content);
            events.push({
              v: 1,
              type: 'step_end',
              trace_id: this.traceId!,
              step_number: num,
              output: text ? { result: text } : (block.content as Record<string, unknown>) ?? null,
              // `is_error` is how this stream reports a failed tool call, and
              // every sibling path records that on the step's `error` so the
              // failure survives into the store. Read the same generous way
              // (`"true"`, 1) the gemini branch reads its own.
              error: isTrueish(block.is_error) ? (text || 'tool failed') : undefined,
            } as CaptureEvent);
            break;
          }
          default:
            break;
        }
      }
      // A record whose blocks produced nothing (a user turn echoing text, an
      // unknown block type) is a line this translator did not use. Say so, for
      // the reason the unknown-type branches below do.
      if (events.length === pre.length) {
        this.skipSkipped(`no usable content in ${JSON.stringify(type)} record`);
      }
      return events;
    }

    if (type === 'result') {
      this.sawTerminal = true;
      // The final text, when the record carries one — `finalOutput` already
      // holds the last assistant message otherwise.
      const text = str(obj.result);
      if (text) this.finalOutput = text;
      // `is_error` is this stream's failure signal, and `subtype` names the
      // kind (`error_max_turns`, `error_during_execution`). A `subtype` that is
      // not "success" counts as a failure on its own, since a run can end in an
      // error subtype without the boolean.
      const subtype = str(obj.subtype);
      if (isTrueish(obj.is_error) || (subtype != null && subtype !== 'success')) {
        this.failed = true;
        this.errorText = this.errorText ?? text ?? subtype ?? 'run failed';
      }
      return this.finalize();
    }

    this.skipReason = `unrecognized claude-stream event type ${JSON.stringify(type)}`;
    return [];
  }

  /** Record a skip without clobbering one already set for this line. */
  private skipSkipped(reason: string): void {
    this.skipReason = this.skipReason ?? reason;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function makeTranslator(format: string): StreamTranslator | null {
  if (format === 'codex-exec') return new CodexExecTranslator();
  if (format === 'gemini-stream') return new GeminiStreamTranslator();
  if (format === 'claude-stream') return new ClaudeStreamTranslator();
  return null;
}

/**
 * Tokens from an Anthropic `usage` object, including BOTH cache fields — where
 * most of a real session's consumption lives. The same four keys the
 * claude-transcript importer sums, so a piped run and an imported one of the
 * same session report the same total.
 */
function claudeUsageTokens(usage: Record<string, unknown>): number {
  return (
    toNum(usage.input_tokens) +
    toNum(usage.output_tokens) +
    toNum(usage.cache_creation_input_tokens) +
    toNum(usage.cache_read_input_tokens)
  );
}

/** Text of a tool result's content, which is a string or an array of blocks. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b as ContentBlock)?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A finite number from a producer value, or 0 — never a string to concatenate. */
function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  // Clamp at zero, like the importers': a negative usage count is not a token
  // total, and it survived capture only to be REJECTED on re-ingest, so an
  // export of such a trace could not be restored.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Error text from a value a harness may report either as a string or as a
 * structured `{message, code, stderr}` object — the same coercion
 * `hook-adapter` applies, so a structured error is not collapsed to the
 * generic "tool failed".
 */
function errText(v: unknown): string | undefined {
  // `false`, `''`, `[]` and `{}` are all SUCCESS values of an always-present
  // error field — never error text. Treating any of them as an error fabricates
  // a failing step, which feeds `check --golden` step_errors and the eval error
  // criteria and fails a clean run. 0 is likewise the success exit code.
  if (typeof v === 'string') return v.trim() ? v : undefined;
  if (v === false || v === 0) return undefined;
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.length > 0 ? JSON.stringify(v) : undefined;
  // A non-finite number is not an error code. `JSON.stringify(NaN)` is the
  // string "null", so an `error: NaN` field produced a failing step whose
  // reported reason was the word "null".
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    return json && json !== '{}' ? json : undefined;
  }
  return JSON.stringify(v);
}

/**
 * A codex item's tool input.
 *
 * Only `command` was read, so an `mcp_tool_call` — whose arguments live under
 * `arguments`, exactly as the codex-rollout importer for the same harness reads
 * them — stored `input: {}`. `show` then displayed no input for the call, and
 * `diff` could not report a changed MCP query between two runs, because the
 * field it compares was empty on both sides. The whole item is still preserved
 * as the step's `output`; this puts the arguments in the column every reader
 * looks in.
 *
 * Shape-tolerant the way `parseArgs` is: a JSON string is parsed, an
 * unparseable or freeform one is kept verbatim under `arguments` rather than
 * dropped. No vendor-internal name is guessed — `arguments` and `input` are the
 * two the sibling importer reads. Anything else an item carries stays in
 * `output`.
 */
function codexItemInput(item: Record<string, unknown>): Record<string, unknown> {
  if (item.command != null) return { command: item.command };
  const args = item.arguments ?? item.input;
  if (args == null) return {};
  // An ARRAY is wrapped, not returned: the input column is read as an object
  // everywhere, the same reason this file wraps a non-object `item`.
  if (typeof args === 'object') {
    return Array.isArray(args) ? { arguments: args } : (args as Record<string, unknown>);
  }
  if (typeof args === 'string') {
    if (!args.trim()) return {};
    try {
      const parsed = JSON.parse(args);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Freeform, which a custom tool call legitimately is.
    }
    return { arguments: args };
  }
  return { arguments: args };
}

/**
 * A codex item's error text, or undefined when it did not fail.
 *
 * Written out rather than inlined because the first attempt was a nested ternary
 * whose OR-ed trigger and `??` fallback chain did not line up: an item that
 * failed by exit code fell through to `str(item.status)` and was recorded with
 * the error text "completed" — the SUCCESS status shown as the failure reason by
 * `show`, `watch`, `why` and the ai-root-cause prompt — and `{is_error: true}`
 * with no exit code produced the literal "exited with code undefined". Decide
 * whether it failed first, then say the most specific true thing about it.
 */
function codexItemError(item: Record<string, unknown>): string | undefined {
  const explicit = errText(item.error);
  // Lower-cased for the same reason `isTrueish` is: an exporter that stringifies
  // its values may send "Failed".
  const status = str(item.status)?.trim().toLowerCase();
  // A stringified exit code counts too — same shape-tolerance, same reason.
  const rawExit = item.exit_code;
  const exit =
    typeof rawExit === 'number' ? rawExit
    : typeof rawExit === 'string' && rawExit.trim() !== '' ? Number(rawExit)
    : NaN;
  const failedByExit = Number.isFinite(exit) && exit !== 0;

  if (explicit == null && !isTrueish(item.is_error) && status !== 'failed' && !failedByExit) {
    return undefined;
  }
  if (explicit != null) return explicit;
  // The PARSED value, so a padded `" 2 "` does not reach the message untrimmed.
  if (failedByExit) return `exited with code ${exit}`;
  return 'tool failed';
}

/**
 * `true`, or one of the forms an exporter that coerces its values sends: the
 * string `"true"`, or a numeric 1 (`str(bool)` and `int(bool)` are both common).
 * Read generously on purpose: MISSING a failure signal here is the fail-open
 * direction — a failed tool call stored as clean, which reports green through
 * `check --golden` and the eval error criteria — while a field literally named
 * `is_error` holding 1 has no other plausible meaning.
 */
function isTrueish(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v !== 'string') return false;
  const t = v.trim().toLowerCase();
  return t === 'true' || t === '1';
}
