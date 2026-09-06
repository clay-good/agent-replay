import type Database from 'better-sqlite3';
import { startTrace, appendStep, updateStep, updateTrace } from './trace-service.js';
import { evaluateStep, verdictForMatches } from './guard-service.js';
import type { TraceStep } from '../models/types.js';
import type { GuardAction } from '../models/enums.js';
import { escapeForMessage } from '../utils/json.js';
import { julianDayExpr } from '../utils/time.js';

/**
 * Stateless adapter for the stdin-JSON hook convention shared by Claude Code,
 * OpenAI Codex CLI, and Gemini CLI. Each invocation is a fresh process: it
 * finds the open trace for the payload's `session_id` (creating one if absent),
 * applies one lifecycle event, and returns. All cross-event state (step
 * numbers, open tool steps, subagent anchors) is derived from the database, so
 * no memory is kept between invocations.
 *
 * Capture is side-effect-only: the caller always exits 0 and writes nothing to
 * stdout, because in every dialect exit 2 blocks the pending action and stdout
 * JSON is read as a hook decision.
 */

export type HookAction =
  | 'session_start'
  | 'prompt'
  | 'pre_tool'
  | 'post_tool'
  | 'post_tool_fail'
  | 'subagent_start'
  | 'subagent_stop'
  | 'finalize'
  | 'unknown';

const EVENT_ACTIONS: Record<string, HookAction> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'prompt',
  BeforeAgent: 'prompt',
  PreToolUse: 'pre_tool',
  BeforeTool: 'pre_tool',
  PostToolUse: 'post_tool',
  AfterTool: 'post_tool',
  PostToolUseFailure: 'post_tool_fail',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'finalize',
  AfterAgent: 'finalize',
  SessionEnd: 'finalize',
};

const GEMINI_EVENTS = new Set(['BeforeTool', 'AfterTool', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'AfterModel']);

export type HookDialect = 'claude-code' | 'codex' | 'gemini' | 'unknown';

export interface ApplyHookOptions {
  /** Drop prompt text and tool inputs at ingestion (shared machines). */
  noInput?: boolean;
  /** Fallback event name when the payload omits `hook_event_name`. */
  eventArg?: string;
  /** Evaluate pre-tool events against policies and return an enforcement verdict. */
  enforce?: boolean;
}

/** A guard verdict on a pre-tool event, when `enforce` is set and a policy matched. */
export interface EnforcementDecision {
  action: GuardAction;
  policy: string | null;
  reason: string | null;
}

export interface ApplyHookResult {
  action: HookAction;
  dialect: HookDialect;
  traceId: string | null;
  note: string;
  /** Present only in enforce mode when a pre-tool step matched a policy. */
  enforcement?: EnforcementDecision;
}

function isoNow(): string {
  return new Date().toISOString();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * A harness may report a tool failure as a structured error
 * (`{message, code, stderr}`) rather than a string. `str()` returns undefined
 * for that, so the whole object collapsed to the generic "tool failed" — and
 * irrecoverably, because a post-tool payload is not retained anywhere else
 * (`rawMeta` is only attached to the pre-tool step). Flatten it to JSON text,
 * the same coercion `trace-service` applies when binding a structured error.
 */
function errorText(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (v == null) return undefined;
  return JSON.stringify(v);
}

/**
 * An event's action, by OWN key only. `EVENT_ACTIONS` is an object literal, so
 * it inherits from `Object.prototype`: a payload naming `constructor`,
 * `toString`, `hasOwnProperty` or `__proto__` used to resolve to an inherited
 * function. That value is truthy, so the `action === 'unknown'` guard was
 * skipped, the returned `action` wasn't a `HookAction` at all, and every such
 * event created a zombie `running` trace that nothing ever finalizes.
 */
function eventAction(eventName: string | undefined): HookAction | 'unknown' {
  return eventName && Object.hasOwn(EVENT_ACTIONS, eventName) ? EVENT_ACTIONS[eventName] : 'unknown';
}

/** Detect the harness dialect from event name and payload shape. */
export function detectDialect(payload: Record<string, unknown>, eventName?: string): HookDialect {
  if (eventName && GEMINI_EVENTS.has(eventName)) return 'gemini';
  if (payload.turn_id != null) return 'codex';
  if (eventAction(eventName) !== 'unknown') {
    // SessionStart/SessionEnd are the only hook event names Gemini CLI shares
    // verbatim with Claude Code, so the GEMINI_EVENTS allowlist can't separate
    // them. Disambiguate by base-field shape (per the documented payloads): a
    // Gemini payload carries `timestamp` and no `permission_mode`, while every
    // Claude Code payload carries `permission_mode`. Without this, a Gemini
    // session that opens with SessionStart creates the trace labeled
    // claude-code, and every later (correctly-detected) event reuses that
    // running trace — so the whole session is permanently mislabeled.
    if (
      (eventName === 'SessionStart' || eventName === 'SessionEnd') &&
      payload.permission_mode == null &&
      payload.timestamp != null
    ) {
      return 'gemini';
    }
    return 'claude-code';
  }
  return 'unknown';
}

/**
 * Resolve a payload's hook action and dialect WITHOUT touching the database —
 * the same mapping `applyHookPayload` performs at its top. `hook` uses this to
 * fail CLOSED: if `applyHookPayload` throws part-way through a `pre_tool`
 * enforcement evaluation (e.g. a transient SQLITE_BUSY on a shared machine), the
 * caller still needs the action + dialect to emit a block, rather than exiting 0
 * (allow) and letting a call a deny policy might have stopped through.
 */
export function resolveHookRouting(
  payload: Record<string, unknown>,
  eventArg?: string,
): { action: HookAction; dialect: HookDialect } {
  const eventName = resolveEventName(payload, eventArg);
  const action = eventAction(eventName);
  const dialect = detectDialect(payload, eventName);
  return { action, dialect };
}

/**
 * Which event name to route by.
 *
 * The payload's own name wins — a harness knows what it dispatched — but only
 * if we RECOGNIZE it. A name we cannot route (`tool.before` from a harness whose
 * vocabulary we do not model) used to override the event the operator
 * registered on the command line, so `hook PreToolUse --enforce` fell through to
 * `unknown`: every gate skipped, exit 0, an unguarded allow — on a command line
 * that states gating intent twice. The registered argument is the operator's
 * declaration and is the right fallback.
 */
function resolveEventName(payload: Record<string, unknown>, eventArg?: string): string | undefined {
  const fromPayload = str(payload.hook_event_name);
  if (fromPayload && eventAction(fromPayload) !== 'unknown') return fromPayload;
  if (eventArg && eventAction(eventArg) !== 'unknown') return eventArg;
  return fromPayload ?? eventArg;
}

/**
 * The event name an enforcement RESPONSE should carry.
 *
 * The router deliberately ignores a `hook_event_name` it cannot route and falls
 * back to the name the operator registered on the command line — but the
 * response formatter read the payload's name directly, so a decision could be
 * LABELLED with the name that had just been ignored. Claude Code keys
 * `hookSpecificOutput` on a matching `hookEventName`, so a deny labelled
 * `tool.before` is not applied — and the process exits 0, so the call runs. A
 * gate that answers in a language the harness does not read is not a gate.
 *
 * Same resolution order as `resolveEventName`, ending at `PreToolUse` because
 * that is the only event enforcement gates.
 */
export function enforcementEventName(
  payload: Record<string, unknown>,
  eventArg?: string,
): string {
  const fromPayload = str(payload.hook_event_name);
  if (fromPayload && eventAction(fromPayload) !== 'unknown') return fromPayload;
  if (eventArg && eventAction(eventArg) !== 'unknown') return eventArg;
  return eventArg ?? 'PreToolUse';
}

function nextStepNumber(db: Database.Database, traceId: string): number {
  const row = db
    .prepare('SELECT MAX(step_number) as m FROM agent_trace_steps WHERE trace_id = ?')
    .get(traceId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

/**
 * Append a step, choosing MAX(step_number)+1 and retrying on a uniqueness
 * conflict. Each hook fires as its own process, so two concurrent tool calls on
 * one session can read the same MAX; the loser retries with a fresh number
 * instead of losing its step. Returns the step number actually used.
 */
function appendStepRetrying(
  db: Database.Database,
  traceId: string,
  build: (stepNumber: number) => Parameters<typeof appendStep>[2],
): number {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const n = nextStepNumber(db, traceId);
    try {
      appendStep(db, traceId, build(n));
      return n;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (attempt < MAX_ATTEMPTS - 1 && /UNIQUE|constraint/i.test(msg)) continue;
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('appendStepRetrying: exhausted attempts');
}

/**
 * The live trace for a session: the newest one still `running` that is not a
 * fork. `fork` copies the original's session_id and opens the copy as `running`
 * with a fresh (newer) started_at, so without the `parent_trace_id IS NULL`
 * filter a fork always won this ordering — every hook event after a fork was
 * written to the what-if copy, stranding the real run half-captured and never
 * finalized, and polluting the fork with post-fork steps it never ran.
 */
const OPEN_SESSION_TRACE_SQL =
  "SELECT id FROM agent_traces WHERE session_id = ? AND status = 'running' AND parent_trace_id IS NULL" +
  // By parsed instant, not byte order — see getMostRecentRunningTrace. One
  // session normally has one open trace, but a resumed session can hold traces
  // written in different timestamp forms.
  ` ORDER BY ${julianDayExpr('started_at')} DESC, started_at DESC LIMIT 1`;

/**
 * The trace a CLOSING event belongs to: the session's newest non-fork trace,
 * whatever its status.
 *
 * A closing event (`post_tool`, `post_tool_fail`, `subagent_stop`) has nothing
 * to open — it finishes work an earlier event started — but it used to go
 * through `ensureTrace` like everything else. Every hook fires as its own
 * process, so when the turn-ending `Stop` committed first (deterministically,
 * when the harness dispatches it before the tool result arrives; and in 15% of
 * simultaneous spawns, rising past 50% while an `otel serve` holds the write
 * lock), the closing event found no OPEN trace and CREATED one: the tool's
 * output, `ended_at` and duration were discarded, the real step stayed open
 * forever, and the store gained an empty `running` trace that `list`, `watch`
 * and the dashboard all render as a live run.
 *
 * Dropping the `status = 'running'` filter fixes both halves at once: the
 * closing event finds the trace it belongs to even though it has been
 * finalized, so the result is recorded rather than lost, and no phantom trace
 * is created. `updateStep` does not require a running trace — only `appendStep`
 * does, and a closing event never appends.
 */
const SESSION_TRACE_SQL =
  'SELECT id FROM agent_traces WHERE session_id = ? AND parent_trace_id IS NULL' +
  ` ORDER BY ${julianDayExpr('started_at')} DESC, started_at DESC LIMIT 1`;

/**
 * The trace holding an OPEN step this closing event could actually close,
 * preferred over merely the newest one.
 *
 * `session_id` is not exclusive to the hook path: `otel serve` merges on it, and
 * both importers set it. So "the session's newest trace" can be one another
 * writer created — or an earlier run of a reused session id — and the result
 * would be attached there, or dropped, while the step it belongs to stays open
 * forever. Matching on an open step of the same name resolves to the run that is
 * actually waiting for this result.
 */
const SESSION_TRACE_WITH_OPEN_STEP_SQL =
  `SELECT t.id FROM agent_traces t
     JOIN agent_trace_steps s ON s.trace_id = t.id
    WHERE t.session_id = ? AND t.parent_trace_id IS NULL
      AND s.step_type = 'tool_call' AND s.ended_at IS NULL
      AND (? IS NULL OR s.name = ?)
    ORDER BY ${julianDayExpr('t.started_at')} DESC, t.started_at DESC LIMIT 1`;

/** Actions that finish earlier work and must never create a trace. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['post_tool', 'post_tool_fail', 'subagent_stop']);

/** Find (or create) the open trace for a session. */
function ensureTrace(
  db: Database.Database,
  sessionId: string,
  dialect: HookDialect,
  payload: Record<string, unknown>,
): string {
  const find = () => db.prepare(OPEN_SESSION_TRACE_SQL).get(sessionId) as { id: string } | undefined;
  const existing = find();
  if (existing) return existing.id;

  // Creating the trace has to be serialized across processes. Every hook fires
  // as its own process, so when a session's first events arrive in parallel
  // (a harness dispatching two tools at once, SessionStart racing the first
  // prompt) both processes read "no open trace" and both created one: the
  // session's steps split across several traces, `watch`/`show`/`why` saw only
  // a fragment, and since `finalize` closes exactly one of them the losers
  // stayed `running` forever — the same zombie-trace symptom `eventAction`
  // documents from a different cause. An IMMEDIATE transaction takes the write
  // lock up front, so the loser's re-check runs after the winner committed and
  // reuses its trace. The unlocked read above keeps the common case (session
  // already open) off the write lock entirely.
  return db.transaction(() => {
    const raced = find();
    if (raced) return raced.id;
    return startTrace(db, {
      agent_name: dialect === 'unknown' ? 'agent' : dialect,
      trigger: 'user_message',
      session_id: sessionId,
      metadata: {
        // The capture path, in the key every other path uses. `dialect` says
        // WHICH HARNESS this came from and stays; `source_format` says HOW it
        // was captured, which is the question a store holding hook, `record`,
        // import and OTel traces could not answer — and the one that matters
        // when a session ends up with two traces.
        source_format: 'hook',
        dialect,
        cwd: str(payload.cwd),
        transcript_path: str(payload.transcript_path),
        permission_mode: str(payload.permission_mode),
      },
    }).id;
  }).immediate();
}

/**
 * The OLDEST open (unclosed) tool_call step matching a tool name.
 *
 * Oldest, not newest. Harnesses dispatch tools in parallel batches and the
 * results come back in call order, so `ORDER BY step_number DESC` handed each
 * result to the wrong open call: with two `Bash` calls in flight, the first
 * result closed the SECOND step. Both outputs were swapped, and — the expensive
 * half — a failure landed on the call that had actually succeeded while the one
 * that failed was stored clean. That is a fabricated failure and a fail-open in
 * one, on the primary capture path for Claude Code.
 *
 * The same reasoning fixed the gemini stream translator's fallback pairing;
 * this function was the precedent that argument cited, and it had the bug.
 * FIFO is also what makes the two paths agree, which is the property worth
 * having: both now close the oldest matching open call.
 */
function findOpenToolStep(
  db: Database.Database,
  traceId: string,
  toolName: string | undefined,
): { step_number: number; started_at: string } | undefined {
  const clause = toolName ? 'AND name = ?' : '';
  const params: unknown[] = toolName ? [traceId, toolName] : [traceId];
  return db
    .prepare(
      `SELECT step_number, started_at FROM agent_trace_steps
       WHERE trace_id = ? AND step_type = 'tool_call' AND ended_at IS NULL ${clause}
       ORDER BY step_number ASC LIMIT 1`,
    )
    .get(...params) as { step_number: number; started_at: string } | undefined;
}

/**
 * The one open subagent anchor, when there is exactly one.
 *
 * Returns undefined for zero (nothing to close) and for two or more (closing
 * either would pair one subagent's end with another's start).
 */
function soleOpenAnchor(db: Database.Database, traceId: string): number | undefined {
  const rows = db
    .prepare(
      `SELECT step_number FROM agent_trace_steps
       WHERE trace_id = ? AND ended_at IS NULL
         AND json_extract(metadata, '$.hook_anchor') = 1
       ORDER BY step_number ASC LIMIT 2`,
    )
    .all(traceId) as Array<{ step_number: number }>;
  return rows.length === 1 ? rows[0].step_number : undefined;
}

/** `true`, `1`, `"true"`, `"TRUE"` — the shapes a JSON harness writes for a flag. */
function isTrueish(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v !== 'string') return false;
  const t = v.trim().toLowerCase();
  return t === 'true' || t === '1';
}

/** The mirror, for a flag that reports SUCCESS: false, 0, "false", "FALSE". */
function isFalseish(v: unknown): boolean {
  if (v === false || v === 0) return true;
  if (typeof v !== 'string') return false;
  const t = v.trim().toLowerCase();
  return t === 'false' || t === '0';
}

/**
 * Failure text carried by a tool RESULT payload, or undefined when it succeeded.
 *
 * The three signals here are the ones the harnesses actually send and the
 * sibling paths already read: `is_error` (Claude Code's `tool_result` flag, read
 * by the transcript importer), `success: false` (what the OTel log mapper reads
 * off `claude_code.tool_result`), and an `error` field. A non-zero `exit_code`
 * on the result's own top level counts too — a shell tool that reports one has
 * failed by its own account.
 *
 * The text is the most specific thing the payload carries, so the stored error
 * says something a reader can act on rather than "tool failed" every time.
 */
function toolResultFailure(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const text = (): string | undefined =>
    errorText(result.error) ?? str(result.stderr) ?? str(result.message) ?? str(result.content) ?? str(result.stdout);
  // `isTrueish`/`isFalseish`, not a bare equality: these values arrive as JSON
  // from a harness, and `"True"`, `"TRUE"` and `1` all mean what they say. The
  // stream translator has read `is_error` this way since it was written, and a
  // stricter test here would miss a failure — the expensive direction for a
  // failure flag, and the reason this whole function exists.
  if (isTrueish(result.is_error)) return text() ?? 'tool failed';
  if (isFalseish(result.success)) return text() ?? 'tool reported failure';
  const code = typeof result.exit_code === 'number' ? result.exit_code : Number(result.exit_code);
  if (Number.isFinite(code) && code !== 0) return text() ?? `exited with code ${code}`;
  if (result.error != null) return errorText(result.error) ?? 'tool failed';
  return undefined;
}

/** The open subagent anchor step for an agent_id, if any. */
function findAnchor(db: Database.Database, traceId: string, agentId: string): number | undefined {
  const row = db
    .prepare(
      `SELECT step_number FROM agent_trace_steps
       WHERE trace_id = ? AND ended_at IS NULL
         AND json_extract(metadata, '$.hook_anchor') = 1
         AND json_extract(metadata, '$.agent_id') = ?
       ORDER BY step_number DESC LIMIT 1`,
    )
    .get(traceId, agentId) as { step_number: number } | undefined;
  return row?.step_number;
}

function rawMeta(payload: Record<string, unknown>, noInput: boolean): Record<string, unknown> {
  if (!noInput) return { hook_payload: payload };
  const { tool_input, prompt, ...rest } = payload;
  void tool_input;
  void prompt;
  return { hook_payload: rest };
}

/** Apply one hook payload. Never throws for mapping reasons; DB errors bubble. */
export function applyHookPayload(
  db: Database.Database,
  payload: Record<string, unknown>,
  opts: ApplyHookOptions = {},
): ApplyHookResult {
  const eventName = resolveEventName(payload, opts.eventArg);
  const action = eventAction(eventName);
  const dialect = detectDialect(payload, eventName);
  const sessionId = str(payload.session_id) ?? 'unknown-session';
  const noInput = !!opts.noInput;

  if (action === 'unknown') {
    return { action, dialect, traceId: null, note: `ignored event "${escapeForMessage(String(eventName ?? '?'))}"` };
  }

  // finalize is the only action that must not create a trace it would immediately close.
  if (action === 'finalize') {
    const row = db.prepare(OPEN_SESSION_TRACE_SQL).get(sessionId) as { id: string } | undefined;
    if (!row) return { action, dialect, traceId: null, note: 'no open trace to finalize' };
    updateTrace(db, row.id, { status: 'completed', ended_at: isoNow() });
    // Say what is still open. A tool call the harness never closed — an
    // interrupted turn, a crashed tool, a subagent whose stop named no id — is
    // left as it is (its end was never observed, and stamping one would invent
    // a duration), so the trace is `completed` while holding steps that are
    // not. `show` renders them as in flight, and without this line the reader
    // has no idea why.
    const open = (db
      .prepare('SELECT COUNT(*) AS n FROM agent_trace_steps WHERE trace_id = ? AND ended_at IS NULL')
      .get(row.id) as { n: number }).n;
    return {
      action,
      dialect,
      traceId: row.id,
      note: open > 0 ? `trace finalized (${open} step(s) never closed)` : 'trace finalized',
    };
  }

  let traceId: string;
  if (CLOSING_ACTIONS.has(action)) {
    const closingTool = str(payload.tool_name) ?? null;
    const row =
      (db
        .prepare(SESSION_TRACE_WITH_OPEN_STEP_SQL)
        .get(sessionId, closingTool, closingTool) as { id: string } | undefined) ??
      (db.prepare(SESSION_TRACE_SQL).get(sessionId) as { id: string } | undefined);
    if (!row) return { action, dialect, traceId: null, note: 'no trace for this session to close against' };
    traceId = row.id;
  } else {
    traceId = ensureTrace(db, sessionId, dialect, payload);
  }
  const agentId = str(payload.agent_id);

  switch (action) {
    case 'session_start':
      return { action, dialect, traceId, note: 'session opened' };

    case 'prompt': {
      const prompt = noInput ? undefined : str(payload.prompt);
      // The trace's input is not part of UpdateTraceInput; set it directly.
      if (prompt) {
        db.prepare('UPDATE agent_traces SET input = ? WHERE id = ?').run(JSON.stringify({ prompt }), traceId);
      }
      return { action, dialect, traceId, note: 'prompt recorded' };
    }

    case 'pre_tool': {
      // An unusable tool_name makes every name-keyed policy inert, so a
      // `name_contains` deny cannot fire and the call is allowed. `guard-service`
      // fails CLOSED on every unusable POLICY field; this is the same question
      // about a STEP field, and it gets the same answer under enforcement.
      // Capture keeps the old placeholder — recording something is better than
      // recording nothing, and capture never gates.
      const toolName = str(payload.tool_name);
      if (opts.enforce && !toolName) {
        return {
          action, dialect, traceId,
          note: 'pre_tool without a usable tool_name — cannot evaluate name-based policies',
          enforcement: {
            action: 'deny',
            policy: null,
            reason: 'agent-replay could not evaluate guard policies (the tool call carries no usable tool_name); blocking to fail closed',
          },
        };
      }
      const stepName = toolName ?? 'tool';
      const parentStep = agentId ? findAnchor(db, traceId, agentId) : undefined;
      const realInput = (payload.tool_input as Record<string, unknown>) ?? {};
      // --no-input redacts the input we STORE, but policy evaluation below must
      // still see the real arguments — otherwise a content-based deny/
      // require_review (e.g. input_contains "rm -rf") silently never fires, a
      // fail-open on exactly the shared machines where --no-input is used. The
      // real input is only ever held in memory here (proposedToolStep builds a
      // transient step; evaluateStep never persists it).
      const storedInput = noInput ? {} : realInput;
      const toolStepNumber = appendStepRetrying(db, traceId, (n) => ({
        step_number: n,
        step_type: 'tool_call',
        name: stepName,
        input: storedInput,
        started_at: isoNow(),
        parent_step: parentStep ?? null,
        metadata: { ...rawMeta(payload, noInput), agent_id: agentId, agent_type: str(payload.agent_type) },
      }));

      if (!opts.enforce) {
        return { action, dialect, traceId, note: `opened tool_call "${escapeForMessage(stepName)}"` };
      }

      // Enforce: evaluate the proposed tool call (against the real input) and,
      // on a match, record a guard_check step linked to the attempt and return
      // the verdict.
      const proposed = proposedToolStep(toolStepNumber, stepName, realInput);
      const verdict = verdictForMatches(evaluateStep(db, proposed));
      if (verdict.action === 'allow') {
        return { action, dialect, traceId, note: `allowed tool_call "${escapeForMessage(String(toolName))}"` };
      }

      // A denied call never executes, so no PostToolUse will ever close its
      // step. Left open it stays in the queue of unclosed steps for that tool
      // name, and findOpenToolStep then hands it the next PostToolUse for that
      // name — which belongs to a different, allowed call that ran concurrently
      // (harnesses dispatch tools in parallel batches). The audit trail then
      // shows the blocked command completing successfully with another call's
      // output, while the call that really ran stays open forever. It is the
      // OLDEST open step now rather than the newest, which makes a denied call
      // absorb a result sooner rather than later — the reason to close it here
      // with the block recorded is unchanged either way.
      //
      // Only `deny` is closed: `require_review` maps to `ask`, which the user
      // can approve, so that call may still run and legitimately close later.
      //
      // Best-effort like the guard_check write below — a failure here must not
      // abort the block and turn an infra error into a safety fail-open.
      if (verdict.action === 'deny') {
        try {
          updateStep(db, traceId, toolStepNumber, {
            ended_at: isoNow(),
            duration_ms: 0,
            error: `blocked by policy ${verdict.policy ?? '?'}${verdict.reason ? `: ${verdict.reason}` : ''}`,
          });
        } catch (err) {
          process.stderr.write(
            `agent-replay hook: could not close the denied tool_call step (still enforcing deny): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      // Record the guard_check for the audit trail — best-effort. A write
      // failure here must NOT abort the block: the verdict is already decided,
      // and letting the error propagate would let hook.ts swallow it and exit 0
      // (allow), turning an infra failure into a safety fail-open. Fail closed —
      // log and still return the deny/require_review verdict.
      try {
        appendStepRetrying(db, traceId, (n) => ({
          step_number: n,
          step_type: 'guard_check',
          name: `guard:${verdict.policy ?? 'policy'}`,
          output: { action: verdict.action, policy: verdict.policy, reason: verdict.reason },
          caused_by_step: toolStepNumber,
          // CLOSED as it is written. This step records a decision that is
          // already made — there is no later event that could close it, since
          // nothing emits a PostToolUse for a guard check. Left open it sat in
          // the trace forever: `show` rendered an in-flight step under a
          // COMPLETED trace, and every enforcement decision left one behind. The
          // denied tool_call right above is closed for the same reason, in the
          // same way; this is that rule at its neighbour.
          //
          // `duration_ms: 0`, not a measured span: the decision's cost is the
          // hook's own runtime, which belongs to the tool_call step this one
          // explains, and inventing a duration here would put time in the trace
          // that no clock measured.
          ended_at: isoNow(),
          duration_ms: 0,
          metadata: { policy: verdict.policy, action: verdict.action, reason: verdict.reason },
        }));
      } catch (err) {
        process.stderr.write(
          `agent-replay hook: guard_check audit write failed (still enforcing ${verdict.action}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      return {
        action,
        dialect,
        traceId,
        note: `${verdict.action} tool_call "${escapeForMessage(String(toolName))}" [${escapeForMessage(String(verdict.policy))}]`,
        enforcement: { action: verdict.action, policy: verdict.policy, reason: verdict.reason },
      };
    }

    case 'post_tool':
    case 'post_tool_fail': {
      const toolName = str(payload.tool_name);
      // Claim the step and close it in ONE IMMEDIATE transaction. Every hook is
      // its own process, so a harness that dispatches a batch of tools in
      // parallel fires the matching PostToolUse hooks near-simultaneously; with
      // the find and the update as separate autocommit statements they all read
      // the SAME open step and all wrote it. Last writer won: the other
      // results were discarded and their steps stayed open forever — silently,
      // because updateStep matches on (trace_id, step_number) and always reports
      // one row changed. Serializing the claim gives each process a different
      // open step, which is also what stops a stale open step from later
      // absorbing another call's output (see the guard-path note above).
      const closed = db.transaction(() => {
        const open = findOpenToolStep(db, traceId, toolName);
        if (!open) return undefined;
        const ended = isoNow();
        // Preserve a genuine 0 ms duration (an instant/cached tool call closing in
        // the same millisecond) — `|| undefined` would drop it to null, unlike the
        // recorder which passes 0 through. Still coalesce an unparseable started_at
        // (NaN) to undefined so a bogus duration is never stored.
        const delta = Date.parse(ended) - Date.parse(open.started_at);
        const duration = Number.isFinite(delta) ? Math.max(0, delta) : undefined;
        const result = (payload.tool_output ?? payload.tool_response) as Record<string, unknown> | undefined;
        // A failure in the RESULT, not only in the event name.
        //
        // Only a `post_tool_fail` event marked a step failed — and Claude Code
        // has no such event: it sends PostToolUse with the result, and the
        // failure lives INSIDE it (`is_error: true`, the same flag the
        // transcript importer reads off a `tool_result`). So a live hook capture
        // stored a failed tool call as a clean one, and the same session
        // imported from its transcript stored it as failed: the deterministic
        // evaluators scored 1.0 against 0.7 on `no_error_steps` for one session
        // (measured), and `check --golden --fields step_errors` — the field that
        // exists to catch a step that STARTS failing — was blind on the primary
        // live path.
        //
        // Read in the same direction as both importers: for a failure FLAG,
        // missing a signal is the expensive mistake (a false-green gate on
        // exactly the runs this tool exists to audit), while over-reading one
        // only makes a failure more visible. Only unambiguous, vendor-generic
        // signals are read.
        const failure = action === 'post_tool_fail'
          ? (errorText(payload.error) ?? 'tool failed')
          : toolResultFailure(result);
        updateStep(db, traceId, open.step_number, {
          output: result ?? null,
          ended_at: ended,
          duration_ms: duration,
          error: failure,
        });
        return open.step_number;
      }).immediate();
      if (closed == null) return { action, dialect, traceId, note: 'no matching open tool step' };
      return { action, dialect, traceId, note: `closed tool_call "${escapeForMessage(String(toolName ?? '?'))}"` };
    }

    case 'subagent_start': {
      const agentType = str(payload.agent_type) ?? 'subagent';
      appendStepRetrying(db, traceId, (n) => ({
        step_number: n,
        step_type: 'thought',
        name: `subagent:${agentType}`,
        started_at: isoNow(),
        metadata: {
          hook_anchor: 1,
          agent_id: agentId,
          agent_type: agentType,
          depth: payload.depth,
          parent_session_id: str(payload.parent_session_id),
        },
      }));
      return { action, dialect, traceId, note: `opened subagent anchor "${escapeForMessage(String(agentType))}"` };
    }

    case 'subagent_stop': {
      // A stop that names its agent closes exactly that anchor. One that names
      // nothing closes the anchor ONLY when there is exactly one open — then it
      // is not a guess, it is the only thing the event can mean. With several
      // open, closing one would pair a subagent's end with another's start, so
      // they are left alone and the reason is said out loud.
      //
      // Without this, an anchor stayed open for the life of the trace whenever
      // the harness's stop payload omitted the id, and `show` rendered a
      // subagent still running under a finished session.
      const anchor = agentId ? findAnchor(db, traceId, agentId) : soleOpenAnchor(db, traceId);
      if (anchor == null) {
        return {
          action,
          dialect,
          traceId,
          note: agentId ? 'no matching subagent anchor' : 'subagent_stop without agent_id — anchor left open',
        };
      }
      updateStep(db, traceId, anchor, { ended_at: isoNow() });
      return { action, dialect, traceId, note: 'closed subagent anchor' };
    }
  }

  return { action, dialect, traceId, note: 'no-op' };
}

/** Build an in-memory tool_call step for policy evaluation (not persisted). */
function proposedToolStep(stepNumber: number, name: string, input: Record<string, unknown>): TraceStep {
  return {
    id: '', trace_id: '', step_number: stepNumber, step_type: 'tool_call', name,
    input, output: null, started_at: '', ended_at: null, duration_ms: null,
    tokens_used: null, model: null, error: null, metadata: {},
    parent_step_number: null, caused_by_step_number: null,
  };
}

// ── Enforcement response formatting ─────────────────────────────────────────

export interface EnforcementResponse {
  /** Structured JSON to print to stdout (the harness's decision), if any. */
  stdout: Record<string, unknown> | null;
  /** Reason to print to stderr (for the exit-2 fallback), if any. */
  stderrReason: string | null;
  /** 0 for structured dialects (blocking is in the JSON); 2 for the fallback. */
  exitCode: 0 | 2;
}

/**
 * Format an enforcement verdict into the response the calling harness
 * understands. Claude Code and Codex CLI use `hookSpecificOutput.permissionDecision`
 * (`deny`/`ask`), Gemini CLI uses `{decision: "deny"}`, and dialects without
 * structured output (e.g. Crush) fall back to exit 2 with the reason on stderr.
 * `warn` never blocks — it surfaces a message and allows the call.
 */
export function formatEnforcementResponse(
  dialect: HookDialect,
  decision: EnforcementDecision,
  hookEventName: string,
): EnforcementResponse {
  const reason = decision.reason ?? `blocked by policy ${decision.policy ?? ''}`.trim();

  if (decision.action === 'warn') {
    // Never blocks; surface a message where the dialect supports one.
    if (dialect === 'claude-code' || dialect === 'codex') {
      return { stdout: { systemMessage: `agent-replay: ${reason}` }, stderrReason: null, exitCode: 0 };
    }
    return { stdout: null, stderrReason: null, exitCode: 0 };
  }

  // deny or require_review — a blocking-class verdict.
  switch (dialect) {
    case 'claude-code':
    case 'codex': {
      const permissionDecision = decision.action === 'require_review' ? 'ask' : 'deny';
      return {
        stdout: {
          hookSpecificOutput: {
            hookEventName,
            permissionDecision,
            permissionDecisionReason: reason,
          },
        },
        stderrReason: null,
        exitCode: 0,
      };
    }
    case 'gemini':
      // Gemini hooks are allow/deny only; require_review maps to deny-with-reason.
      return {
        stdout: {
          decision: 'deny',
          reason: decision.action === 'require_review' ? `review required: ${reason}` : reason,
        },
        stderrReason: null,
        exitCode: 0,
      };
    default:
      // Crush / unknown: no structured output — block via exit 2.
      return { stdout: null, stderrReason: reason, exitCode: 2 };
  }
}
