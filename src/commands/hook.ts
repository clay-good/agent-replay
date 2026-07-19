import { resolve } from 'node:path';
import { ensureDatabase } from '../db/index.js';
import { applyHookPayload } from '../services/hook-adapter.js';
import { errorMessage } from '../utils/json.js';

export interface HookOptions {
  noInput?: boolean;
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

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
    const db = ensureDatabase(dbPath);
    const result = applyHookPayload(db, payload, { noInput: opts.noInput, eventArg });
    // Progress goes to stderr only (stdout is reserved for hook decisions).
    console.error(`agent-replay hook: ${result.action} [${result.dialect}] — ${result.note}`);
  } catch (err) {
    console.error(`agent-replay hook: ${errorMessage(err)}`);
  }

  // Capture must never block or signal the host agent.
  process.exitCode = 0;
}
