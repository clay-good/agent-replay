import type Database from 'better-sqlite3';
import { startTrace, appendStep, updateStep, updateTrace } from './trace-service.js';
import { evaluateStep, verdictForMatches } from './guard-service.js';
import type { TraceStep } from '../models/types.js';
import type { GuardAction } from '../models/enums.js';

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

/** Detect the harness dialect from event name and payload shape. */
export function detectDialect(payload: Record<string, unknown>, eventName?: string): HookDialect {
  if (eventName && GEMINI_EVENTS.has(eventName)) return 'gemini';
  if (payload.turn_id != null) return 'codex';
  if (eventName && eventName in EVENT_ACTIONS) return 'claude-code';
  return 'unknown';
}

function nextStepNumber(db: Database.Database, traceId: string): number {
  const row = db
    .prepare('SELECT MAX(step_number) as m FROM agent_trace_steps WHERE trace_id = ?')
    .get(traceId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

/** Find (or create) the open trace for a session. */
function ensureTrace(
  db: Database.Database,
  sessionId: string,
  dialect: HookDialect,
  payload: Record<string, unknown>,
): string {
  const existing = db
    .prepare("SELECT id FROM agent_traces WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get(sessionId) as { id: string } | undefined;
  if (existing) return existing.id;

  const trace = startTrace(db, {
    agent_name: dialect === 'unknown' ? 'agent' : dialect,
    trigger: 'user_message',
    session_id: sessionId,
    metadata: {
      dialect,
      cwd: str(payload.cwd),
      transcript_path: str(payload.transcript_path),
      permission_mode: str(payload.permission_mode),
    },
  });
  return trace.id;
}

/** The most recent open (unclosed) tool_call step matching a tool name. */
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
       ORDER BY step_number DESC LIMIT 1`,
    )
    .get(...params) as { step_number: number; started_at: string } | undefined;
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
  const eventName = str(payload.hook_event_name) ?? opts.eventArg;
  const action = (eventName && EVENT_ACTIONS[eventName]) || 'unknown';
  const dialect = detectDialect(payload, eventName);
  const sessionId = str(payload.session_id) ?? 'unknown-session';
  const noInput = !!opts.noInput;

  if (action === 'unknown') {
    return { action, dialect, traceId: null, note: `ignored event "${eventName ?? '?'}"` };
  }

  // finalize is the only action that must not create a trace it would immediately close.
  if (action === 'finalize') {
    const row = db
      .prepare("SELECT id FROM agent_traces WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get(sessionId) as { id: string } | undefined;
    if (!row) return { action, dialect, traceId: null, note: 'no open trace to finalize' };
    updateTrace(db, row.id, { status: 'completed', ended_at: isoNow() });
    return { action, dialect, traceId: row.id, note: 'trace finalized' };
  }

  const traceId = ensureTrace(db, sessionId, dialect, payload);
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
      const toolName = str(payload.tool_name) ?? 'tool';
      const parentStep = agentId ? findAnchor(db, traceId, agentId) : undefined;
      const toolInput = noInput ? {} : ((payload.tool_input as Record<string, unknown>) ?? {});
      const toolStepNumber = nextStepNumber(db, traceId);
      appendStep(db, traceId, {
        step_number: toolStepNumber,
        step_type: 'tool_call',
        name: toolName,
        input: toolInput,
        started_at: isoNow(),
        parent_step: parentStep ?? null,
        metadata: { ...rawMeta(payload, noInput), agent_id: agentId, agent_type: str(payload.agent_type) },
      });

      if (!opts.enforce) {
        return { action, dialect, traceId, note: `opened tool_call "${toolName}"` };
      }

      // Enforce: evaluate the proposed tool call and, on a match, record a
      // guard_check step linked to the attempt and return the verdict.
      const proposed = proposedToolStep(toolStepNumber, toolName, toolInput);
      const verdict = verdictForMatches(evaluateStep(db, proposed));
      if (verdict.action === 'allow') {
        return { action, dialect, traceId, note: `allowed tool_call "${toolName}"` };
      }

      appendStep(db, traceId, {
        step_number: nextStepNumber(db, traceId),
        step_type: 'guard_check',
        name: `guard:${verdict.policy ?? 'policy'}`,
        output: { action: verdict.action, policy: verdict.policy, reason: verdict.reason },
        caused_by_step: toolStepNumber,
        metadata: { policy: verdict.policy, action: verdict.action, reason: verdict.reason },
      });

      return {
        action,
        dialect,
        traceId,
        note: `${verdict.action} tool_call "${toolName}" [${verdict.policy}]`,
        enforcement: { action: verdict.action, policy: verdict.policy, reason: verdict.reason },
      };
    }

    case 'post_tool':
    case 'post_tool_fail': {
      const toolName = str(payload.tool_name);
      const open = findOpenToolStep(db, traceId, toolName);
      if (!open) return { action, dialect, traceId, note: 'no matching open tool step' };
      const ended = isoNow();
      const duration = Math.max(0, Date.parse(ended) - Date.parse(open.started_at)) || undefined;
      const result = (payload.tool_output ?? payload.tool_response) as Record<string, unknown> | undefined;
      updateStep(db, traceId, open.step_number, {
        output: result ?? null,
        ended_at: ended,
        duration_ms: duration,
        error: action === 'post_tool_fail' ? (str(payload.error) ?? 'tool failed') : undefined,
      });
      return { action, dialect, traceId, note: `closed tool_call "${toolName ?? '?'}"` };
    }

    case 'subagent_start': {
      const agentType = str(payload.agent_type) ?? 'subagent';
      appendStep(db, traceId, {
        step_number: nextStepNumber(db, traceId),
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
      });
      return { action, dialect, traceId, note: `opened subagent anchor "${agentType}"` };
    }

    case 'subagent_stop': {
      if (!agentId) return { action, dialect, traceId, note: 'subagent_stop without agent_id' };
      const anchor = findAnchor(db, traceId, agentId);
      if (anchor == null) return { action, dialect, traceId, note: 'no matching subagent anchor' };
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
