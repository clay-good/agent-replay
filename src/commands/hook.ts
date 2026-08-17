import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureDatabase } from '../db/index.js';
import { applyHookPayload, formatEnforcementResponse, resolveHookRouting } from '../services/hook-adapter.js';
import type { HookDialect } from '../services/hook-adapter.js';
import { errorMessage } from '../utils/json.js';

export interface HookOptions {
  noInput?: boolean;
  enforce?: boolean;
  dialect?: string;
  dir?: string;
}

/**
 * `--dialect` values, and why the flag exists.
 *
 * The dialect is normally detected from the payload, and detection can only
 * ever answer with a harness it recognizes: `unknown` is returned solely when
 * the event name is unrecognized, and an unrecognized event returns before any
 * enforcement. So the documented "harness without structured output — exits 2
 * with the reason on stderr" behaviour was unreachable in practice. A Crush
 * user registering `hook PreToolUse --enforce` was detected as claude-code and
 * answered with Claude-shaped JSON on exit 0, which a harness that doesn't read
 * hook stdout ignores — the call ran. Nothing about a payload distinguishes
 * such a harness, so the user has to say, which is what this flag is for.
 */
const DIALECTS: Record<string, HookDialect> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  // The exit-code convention, for anything that doesn't parse hook stdout.
  other: 'unknown',
};

/**
 * `agent-replay hook [event]` — capture adapter for the stdin-JSON hook
 * convention. Reads one payload from stdin, applies it, and ALWAYS exits 0 with
 * no stdout: in Claude Code / Codex / Gemini, exit 2 blocks the pending action
 * and stdout JSON is read as a hook decision, so capture must emit neither. Any
 * failure is logged to stderr and swallowed so the host agent is never affected.
 */
export async function runHook(eventArg: string | undefined, opts: HookOptions = {}): Promise<void> {
  let forced: HookDialect | undefined;
  if (opts.dialect != null) {
    forced = DIALECTS[opts.dialect];
    if (!forced) {
      console.error(`agent-replay hook: unknown --dialect "${opts.dialect}". Options: ${Object.keys(DIALECTS).join(', ')}.`);
      // A usage error must not block the host agent in capture mode; under
      // --enforce it is fail-closed territory, so 2 stands.
      process.exitCode = opts.enforce ? 2 : 0;
      return;
    }
  }

  /**
   * We never saw a payload, so we could not evaluate policies — the same
   * position as a throw before the verdict below, which deliberately fails
   * closed. Emit the dialect's block for a `pre_tool` route (the only event that
   * gates an action) and allow otherwise. Returns true when it answered.
   *
   * Routing has to come from `eventArg` alone here: with no payload there is
   * nothing to detect a dialect from, so this only ever fires for a hook
   * registered as `agent-replay hook PreToolUse --enforce`, where the intent to
   * gate is explicit.
   */
  function failClosedWithoutPayload(reason: string): boolean {
    if (!opts.enforce) return false;
    const { action, dialect } = resolveHookRouting({}, eventArg);
    if (action !== 'pre_tool') return false;
    const resp = formatEnforcementResponse(
      forced ?? dialect,
      { action: 'deny', policy: null, reason: `agent-replay received no hook payload (${reason}); blocking to fail closed` },
      eventArg ?? 'PreToolUse',
    );
    if (resp.stdout) process.stdout.write(`${JSON.stringify(resp.stdout)}\n`);
    if (resp.stderrReason) console.error(`agent-replay hook: BLOCK (fail-closed) — ${resp.stderrReason}`);
    process.exitCode = resp.exitCode;
    return true;
  }

  let raw = '';
  try {
    // Concatenate the BYTES, then decode once. `raw += chunk` decodes each chunk
    // on its own, and a pipe hands us exactly 64 KiB at a time — so any
    // multi-byte character straddling a boundary (emoji, CJK, accented text, a
    // smart quote) became U+FFFD. The JSON stayed valid, since the damage is
    // inside a string, so nothing reported it: a content-based deny simply did
    // not match the corrupted text and the tool call was allowed, and the same
    // mangled text was stored as the audit record of the run.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    console.error(`agent-replay hook: failed to read stdin: ${errorMessage(err)}`);
    if (failClosedWithoutPayload(`stdin read failed: ${errorMessage(err)}`)) return;
    process.exitCode = 0;
    return;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    console.error('agent-replay hook: empty payload, nothing to record');
    if (failClosedWithoutPayload('empty stdin')) return;
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
    // event on garbage input would be worse than the capture gap.) Deliberately
    // NOT routed through failClosedWithoutPayload above: unlike empty stdin, the
    // harness did send something, and this allow is an explicit design choice.
    process.exitCode = 0;
    return;
  }

  try {
    const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
    // In enforce mode a missing store is a failure to evaluate, not an empty
    // policy set. The path is resolved from the process's cwd and
    // `ensureDatabase` CREATES what it doesn't find, so a hook that fired from
    // any directory other than the project root got a brand-new store with zero
    // policies and cheerfully allowed everything — the one condition on this
    // path that failed OPEN. Throw into the fail-closed handler below, which
    // blocks the call and says why. Capture mode still creates the store — and
    // so does every non-gating event under --enforce, so a user who registers
    // one `--enforce` command line across all hook events can still bootstrap a
    // store; only the tool call that would have gone unchecked is blocked.
    if (opts.enforce && resolveHookRouting(payload, eventArg).action === 'pre_tool' && !existsSync(dbPath)) {
      throw new Error(`no trace store at ${dbPath} — run "agent-replay init" there, or point the hook at one with --dir`);
    }
    const db = ensureDatabase(dbPath);
    const result = applyHookPayload(db, payload, { noInput: opts.noInput, enforce: opts.enforce, eventArg });
    // Progress goes to stderr only (stdout is reserved for hook decisions).
    console.error(`agent-replay hook: ${result.action} [${result.dialect}] — ${result.note}`);

    // Enforce mode: answer the harness in its documented dialect.
    if (opts.enforce && result.enforcement) {
      const hookEventName = (typeof payload.hook_event_name === 'string' ? payload.hook_event_name : eventArg) ?? 'PreToolUse';
      const resp = formatEnforcementResponse(forced ?? result.dialect, result.enforcement, hookEventName);
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
          forced ?? dialect,
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
