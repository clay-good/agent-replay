import type { IngestTraceInput, IngestStepInput, IngestDecisionInput } from '../../models/types.js';
import { attrsToMap, decodeAnyValue } from './semconv.js';
import { isoFromNanos } from './semconv.js';
import { isFalseish } from '../../utils/json.js';

/** Bucket key for a record with no session.id — never persisted as one. */
const NO_SESSION_PREFIX = '!nosession:';

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
/**
 * Event names this mapper understands.
 *
 * Exported through {@link countRecognizedLogRecords} so the receiver can report
 * how many records it actually consumed WITHOUT a second copy of this rule —
 * two copies would drift the moment a family is added, and the whole point of
 * the count is to be trustworthy.
 */
function isRecognizedEventName(eventName: string): boolean {
  return eventName.startsWith('gemini_cli.') || eventName.startsWith('claude_code.');
}

/** How many records in this batch are events the mapper understands. */
export function countRecognizedLogRecords(otlp: Record<string, unknown>): number {
  return flattenLogs(otlp).filter((l) => isRecognizedEventName(l.eventName)).length;
}

export function mapOtlpLogs(otlp: Record<string, unknown>): IngestTraceInput[] {
  const logs = flattenLogs(otlp).filter((l) => isRecognizedEventName(l.eventName));

  const bySession = new Map<string, FlatLog[]>();
  logs.forEach((l, i) => {
    // A record with no session.id gets its own group rather than joining one
    // shared '__nosession__' bucket. Grouping on a placeholder fused every
    // session-less record in the batch — across unrelated resourceLogs, so
    // across unrelated services — into a single trace with summed tokens and
    // one arbitrary agent name. The span path refuses the same fusion for the
    // same reason: the correlation key is absent, so correlate nothing.
    const sid = str(l.attrs['session.id']) ?? `${NO_SESSION_PREFIX}${i}`;
    const list = bySession.get(sid) ?? [];
    list.push(l);
    bySession.set(sid, list);
  });

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
    const followUpPrompts: string[] = [];
    let totalTokens = 0;
    let totalCost = 0;
    const steps: IngestStepInput[] = [];
    /** Whether the SESSION failed (a failed model call), not merely a tool. */
    let sessionFailed = false;
    let stepNumber = 1;
    let startedAt: string | undefined;
    let endedAtNanos = 0;
    /** The model the session's most recent model-bearing record reported. */
    let currentModel: string | undefined;
    /** The FIRST model the session reported, used to back-fill steps before it. */
    let firstModel: string | undefined;
    /** How far `stampModel` has already stamped, so each step is visited once. */
    let stampedUpTo = 0;
    /**
     * Give the steps produced so far the model that was in effect when their
     * record arrived. Only `.api_error` ever set a step's `model`, so a session
     * whose model calls all SUCCEEDED carried the model nowhere at all — not on
     * a step, and there is no trace-level model column — even though every
     * `api_request`/`api_response` record states it. `check --golden --fields
     * model` then exits 2 ("no baseline entry carries that data") for every
     * OTel-log capture, which is the same gate the importers were unusable for
     * until they started reading the model each record carries.
     *
     * Stamped from ONE site rather than at each `steps.push`: the branches below
     * all `continue`, and both importers document having missed a branch doing
     * exactly this. Called at the top of each iteration (before this record's
     * own model is read) so a step is stamped with the model in effect at ITS
     * time, not a later one — a session that falls back to a smaller model
     * mid-run must not have its earlier steps relabelled.
     *
     * `decision` steps are deliberately left alone: a tool decision is the
     * user's or the policy's call, not the model's, and `check` skips a
     * null-model baseline step, so an honest absence costs the gate nothing.
     */
    const stampModel = () => {
      for (; stampedUpTo < steps.length; stampedUpTo++) {
        const st = steps[stampedUpTo];
        if (st.model == null && (st.step_type === 'tool_call' || st.step_type === 'llm_call')) {
          st.model = currentModel;
        }
      }
    };

    for (const l of group) {
      stampModel();
      // Read from EVERY record, not just the model-call branches: the attribute
      // names a property of the session, so any record stating it is reporting
      // the model in effect, and one read cannot miss a branch.
      const recordModel = logModel(l.attrs);
      if (recordModel) {
        currentModel = recordModel;
        firstModel ??= recordModel;
      }
      // The record's own event time. No log-derived step set `started_at`, and
      // the writer falls back to the ingest wall-clock, so every step of an
      // imported session carried the same fabricated timestamp — the moment the
      // batch happened to arrive. Timelines showed every step as simultaneous,
      // and the trace never gained a duration at all.
      const at = isoFromNanos(l.time);
      if (!startedAt && at) startedAt = at;
      // Only fold in a stamp that can actually be rendered. Maxing the RAW nanos
      // let ONE out-of-range record (a skewed clock, a stamp in the wrong unit)
      // poison the aggregate: isoFromNanos then returned undefined for the max,
      // so the whole session's ended_at and duration went null even though every
      // other record was properly timed. The span path filters its start/end sets
      // for exactly this reason.
      if (at) endedAtNanos = Math.max(endedAtNanos, l.time);
      const a = l.attrs;
      const evt = l.eventName;

      if (evt.endsWith('.user_prompt')) {
        const prompt = str(a.prompt) ?? str(a.prompt_text) ?? (typeof l.body === 'string' ? l.body : undefined);
        // A session shares one session.id across every turn, and each later
        // prompt OVERWROTE the trace input — so a multi-turn session kept only
        // the LAST question and nothing anywhere carried the earlier ones. The
        // first prompt is what the run started from (and stays stable as the
        // session grows); the rest are retained as metadata, since there is no
        // step type for a user turn.
        if (prompt) {
          // Trimmed, like `trace-service.hasPromptValue` and both importers: a
          // whitespace-only first prompt is truthy, so it claimed the input slot
          // and demoted the REAL question to a follow-up. Third site of the same
          // defect.
          if (!input || !String((input as { prompt?: unknown }).prompt ?? '').trim()) input = { prompt };
          else followUpPrompts.push(prompt);
        }
        continue;
      }

      if (evt === 'gemini_cli.tool_call') {
        const name = str(a.function_name) ?? 'tool';
        const toolStep = stepNumber++;
        steps.push({
          step_number: toolStep,
          step_type: 'tool_call',
          name,
          started_at: at,
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
            started_at: at,
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
          started_at: at,
          output: a.success != null ? { success: a.success } : null,
          duration_ms: numOrNull(a.duration_ms),
          error: toolError(a),
          metadata: { source: 'claude_code' },
        });
        continue;
      }

      if (evt === 'claude_code.tool_decision') {
        // UNVERIFIED, and deliberately left alone: the `decided_by` mapping
        // below tests for `allow`/`deny`, which is the GUARD/HOOK vocabulary
        // (`guard add --action`, the hook adapter's permission decisions), not
        // one this file's telemetry is known to use. Its gemini twin above maps
        // the telemetry vocabulary the spec documents (`auto_accept` → policy,
        // otherwise user), and the OTel design doc says these Claude events
        // "map the same way" — so if the real records say something else, every
        // Claude log-captured decision is being recorded as `by policy`,
        // including ones a person approved at the prompt.
        //
        // Settling it needs a real `claude_code.tool_decision` record — the
        // same evidence bar `stream-translators.ts` states for vendor fields,
        // and the reason the Gemini CLI importer is still unwritten. Do not
        // flip the mapping on a reading of vendor docs: `chosen` is stored
        // verbatim either way, so only the ACTOR is at stake, and guessing an
        // actor is what this codebase refuses to do.
        const name = str(a.tool_name) ?? 'tool';
        const decision = str(a.decision);
        if (decision) {
          steps.push({
            step_number: stepNumber++,
            step_type: 'decision',
            name: `tool_decision:${name}`,
            started_at: at,
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
        // A model call that failed outright is a SESSION-level failure — unlike
        // a tool that returned an error, which the agent can and usually does
        // recover from. See the status derivation below.
        sessionFailed = true;
        steps.push({
          step_number: stepNumber++,
          step_type: 'llm_call',
          name: logModel(a) ?? 'api_error',
          started_at: at,
          // The model was only ever put in `name`, leaving the `model` column
          // null on every log-derived step — so a capture of these CLIs had no
          // model recorded anywhere, while the span path sets it.
          model: logModel(a),
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
          usage(num(a.input_token_count ?? a['gen_ai.usage.input_tokens'] ?? a.input_tokens)) +
          usage(num(a.output_token_count ?? a['gen_ai.usage.output_tokens'] ?? a.output_tokens));
        // The same record carries the spend when the emitter reports it. It was
        // read by nothing, so `stats` printed "Total cost: -" and
        // `list --sort cost` was inert for every OTel-captured trace, with the
        // number sitting unread in the payload. Absent or unusable → no change.
        const cost = num(a.cost_usd ?? a.cost ?? a['gen_ai.usage.cost']);
        if (cost > 0) totalCost += cost;
        continue;
      }
    }

    // The final record's steps are still unstamped — stampModel runs at the TOP
    // of each iteration, so nothing stamps what the last one pushed.
    stampModel();
    // Back-fill a step that ran before the session's first model record with
    // that first model. It is a measured value from this same session bounded by
    // ordering (the earliest model the session reported is the one in effect at
    // its start), not a guess — the same seeding both importers use. A session
    // that never reports a model anywhere leaves every step null, because an
    // absent model must stay absent rather than become an invented one.
    if (firstModel) for (const st of steps) if (st.model == null && st.step_type !== 'decision') st.model = firstModel;

    // A flush window carrying only model-call events (very common between tool
    // calls) has no steps and no prompt, but it DOES have tokens — and dropping
    // the whole group discarded them, so a session's token total depended on
    // where the exporter happened to cut its batches.
    if (steps.length === 0 && !input && !totalTokens) continue;

    traces.push({
      agent_name: isGemini ? 'gemini' : 'claude-code',
      trigger: 'user_message',
      // Derived, not hardcoded — but from a SESSION-level failure only.
      //
      // `steps.some(st => st.error != null)` promoted a failed TOOL CALL to a
      // failed run, which made the two OTel receivers the only capture paths
      // that do: the other eight store `completed` for a session containing a
      // failed tool, the telemetry-ingest spec says a failure becomes a STEP
      // error, and eval's design says a recovered step error must not hard-fail
      // a preset. The identical session scored the same and PASSED via `ingest`
      // while FAILING at exit 1 here. A failed model call (`.api_error`) is a
      // different thing — the turn did not happen — and still fails the run.
      status: sessionFailed ? 'failed' : 'completed',
      // Must match the placeholder actually used above. It still tested the OLD
      // sentinel, so the synthetic key was PERSISTED as the session id — and
      // since the receiver merges log batches on (session_id, source_format),
      // every batch's first session-less record carried the same
      // `!nosession:0` and merged into the previous batch's trace: unrelated
      // sessions fused, with a bogus id that `list`/`show` displayed and
      // `--session` matched.
      session_id: sid.startsWith(NO_SESSION_PREFIX) ? null : sid,
      input: input ?? {},
      started_at: startedAt,
      // The session spans its first event to its last. Without this the trace
      // had no ended_at and no total_duration_ms, so `list` showed "-" forever.
      ended_at: isoFromNanos(endedAtNanos) ?? null,
      total_tokens: totalTokens || null,
      total_cost_usd: totalCost || null,
      metadata: {
        source_format: isGemini ? 'gemini-cli-logs' : 'claude-code-logs',
        // The model the session was last reported on, the way the span path
        // carries its root's model — a log session has no root span whose model
        // is definitional, and no trace-level model column, so without this a
        // batch of nothing but model-call events (which produce no steps) 
        // recorded the model nowhere at all. The receiver also reads it as the
        // model in effect when the NEXT batch opens.
        ...(currentModel ? { model: currentModel } : {}),
        ...(followUpPrompts.length > 0 ? { follow_up_prompts: followUpPrompts } : {}),
      },
      steps: closeLogSteps(steps),
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
  // An exporter that stringifies attribute values sends `"false"`, and the same
  // record still carries the error text — so keying on `!== false` alone read a
  // failed tool call as clean, reopening the exact class this function closed.
  // Case-insensitively, because an exporter built on the OTel Python SDK
  // stringifies with `str(False)` → "False", which an exact 'false' missed.
  const asText = typeof a.success === 'string' ? a.success.trim().toLowerCase() : undefined;
  const failed = isFalseish(a.success) || isFalseish(asText);
  if (!failed) return undefined;
  return str(a.error) ?? str(a.error_message) ?? str(a.error_type) ?? 'tool failed';
}

/**
 * The model a log record reports. Both CLIs put it on the plain `model`
 * attribute (`claude_code.api_request`, `gemini_cli.api_response`); the
 * `gen_ai.request.model` alias is kept because the `.api_error` branch has
 * always read it. One helper so the sites that read a model cannot drift apart.
 */
function logModel(a: Record<string, unknown>): string | undefined {
  return str(a['gen_ai.request.model']) ?? str(a.model);
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
/**
 * A usage counter, floored at zero — the clamp `semconv.usage()` applies on the
 * span path, which this path was missing. An `intValue` is a signed int64, so a
 * negative count is wire-legal; stored verbatim it dragged `stats` sums negative
 * and broke the export → `ingest` round trip, since `ingest` requires a
 * non-negative total. Same clamp the importers and stream translators apply.
 */
function usage(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Close every log-derived step. A LOG RECORD IS A REPORT OF SOMETHING THAT
 * ALREADY HAPPENED — `tool_result`, `api_request`, `tool_decision` — so a step
 * built from one is finished the moment it is written, and nothing will ever
 * arrive to close it: there is no second record for the same event.
 *
 * Left open, every step of every log-captured session sat in flight for the
 * life of the trace (`show` drawing a finished `completed` session as if its
 * tools were still running), and a `tool_result` even carried a measured
 * `duration_ms: 40` beside a null `ended_at` — a step with a duration and no
 * end.
 *
 * The end is `started_at + duration_ms` when the record measured one, and the
 * record's own instant otherwise. Nothing is invented in either case: a
 * duration the record did not carry stays null, so a consumer reads "finished,
 * duration unknown" rather than a fabricated zero. Same rule the hook adapter
 * applies to its `guard_check` audit row.
 */
function closeLogSteps(steps: IngestStepInput[]): IngestStepInput[] {
  for (const step of steps) {
    if (step.ended_at || !step.started_at) continue;
    const start = Date.parse(step.started_at);
    if (Number.isNaN(start)) continue;
    const span = typeof step.duration_ms === 'number' && Number.isFinite(step.duration_ms) ? step.duration_ms : 0;
    step.ended_at = new Date(start + span).toISOString();
  }
  return steps;
}

/**
 * A duration, or null. Also floored at zero: a negative `duration_ms` is
 * rejected by `ingest` for the same reason, so storing one breaks the round trip
 * of a trace this tool itself wrote. A genuine 0 (an instant or cached tool call)
 * still survives — only an absent, non-numeric or negative value becomes null.
 */
function numOrNull(v: unknown): number | null {
  // Preserve a genuine 0 (an instant/cached tool call really does take 0 ms) —
  // `num(v) || null` collapsed it to null, the same class as the hook 0 ms
  // duration fix. Only an absent or non-numeric value becomes null.
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}
