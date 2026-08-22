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

  abstract translate(obj: Record<string, unknown>): CaptureEvent[];

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

  translate(obj: Record<string, unknown>): CaptureEvent[] {
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
          input: item.command != null ? { command: item.command } : {},
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

// ── Factory ─────────────────────────────────────────────────────────────────

export function makeTranslator(format: string): StreamTranslator | null {
  if (format === 'codex-exec') return new CodexExecTranslator();
  if (format === 'gemini-stream') return new GeminiStreamTranslator();
  return null;
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
