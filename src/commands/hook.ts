import { resolve } from 'node:path';
import { ensureDatabase } from '../db/index.js';
import { applyHookPayload, formatEnforcementResponse, resolveHookRouting } from '../services/hook-adapter.js';
import { errorMessage } from '../utils/json.js';

export interface HookOptions {
  noInput?: boolean;
  enforce?: boolean;
  dir?: string;
}

/**
 * `agent-replay hook [event]` — capture adapter for the stdin-JSON hook
 * convention. Reads one payload from stdin, applies it, and ALWAYS exits 0 with
 * no stdout: in Claude Code / Codex / Gemini, exit 2 blocks the pending action
 * and stdout JSON is read as a hook decision, so capture must emit neither. Any
 * failure is logged to stderr and swallowed so the host agent is never affected.
 */
export async function runHook(eventArg: string | undefined, opts: HookOptions = {}): Promise<void> {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch (err) {
    console.error(`agent-replay hook: failed to read stdin: ${errorMessage(err)}`);
    process.exitCode = 0;
    return;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    console.error('agent-replay hook: empty payload, nothing to record');
    process.exitCode = 0;
    return;
  }

  // Parse before the work block so a mid-evaluation failure below can still see
  // the payload to fail closed (see the catch). A parse failure itself yields an
  // empty payload; enforcement then falls back to `eventArg` for routing.
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    console.error(`agent-replay hook: invalid JSON payload: ${errorMessage(err)}`);
    // Not a real, actionable tool call — capture-only, allow. (A malformed
    // payload is the harness misbehaving, not a policy decision; blocking every
    // event on garbage input would be worse than the capture gap.)
    process.exitCode = 0;
    return;
  }

  try {
    const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
    const db = ensureDatabase(dbPath);
    const result = applyHookPayload(db, payload, { noInput: opts.noInput, enforce: opts.enforce, eventArg });
    // Progress goes to stderr only (stdout is reserved for hook decisions).
    console.error(`agent-replay hook: ${result.action} [${result.dialect}] — ${result.note}`);

    // Enforce mode: answer the harness in its documented dialect.
    if (opts.enforce && result.enforcement) {
      const hookEventName = (typeof payload.hook_event_name === 'string' ? payload.hook_event_name : eventArg) ?? 'PreToolUse';
      const resp = formatEnforcementResponse(result.dialect, result.enforcement, hookEventName);
      if (resp.stdout) process.stdout.write(`${JSON.stringify(resp.stdout)}\n`);
      if (resp.stderrReason) console.error(`agent-replay hook: BLOCK — ${resp.stderrReason}`);
      process.exitCode = resp.exitCode;
      return;
    }
  } catch (err) {
    console.error(`agent-replay hook: ${errorMessage(err)}`);
    // Fail CLOSED in enforce mode. A throw before the verdict (e.g. a transient
    // SQLITE_BUSY on a shared machine while opening the trace, appending the
    // tool_call step, or loading policies) means we could not decide whether to
    // block. For a `pre_tool` event — the only kind that gates an action —
    // allowing (exit 0) would let a call a deny policy might have stopped run.
    // Emit the dialect's block instead. Every other event is capture-only.
    if (opts.enforce) {
      const { action, dialect } = resolveHookRouting(payload, eventArg);
      if (action === 'pre_tool') {
        const hookEventName = (typeof payload.hook_event_name === 'string' ? payload.hook_event_name : eventArg) ?? 'PreToolUse';
        const resp = formatEnforcementResponse(
          dialect,
          { action: 'deny', policy: null, reason: `agent-replay could not evaluate guard policies (${errorMessage(err)}); blocking to fail closed` },
          hookEventName,
        );
        if (resp.stdout) process.stdout.write(`${JSON.stringify(resp.stdout)}\n`);
        if (resp.stderrReason) console.error(`agent-replay hook: BLOCK (fail-closed) — ${resp.stderrReason}`);
        process.exitCode = resp.exitCode;
        return;
      }
    }
  }

  // Capture (and allow) must never block or signal the host agent.
  process.exitCode = 0;
}
