import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace, listTraces, ingestTrace } from '../src/services/trace-service.js';
import { applyHookPayload, detectDialect, resolveHookRouting } from '../src/services/hook-adapter.js';
import { forkTrace } from '../src/services/fork-service.js';
import { addPolicy } from '../src/services/guard-service.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

function apply(payload: Record<string, unknown>, opts = {}) {
  return applyHookPayload(db, payload, opts);
}

// ── Dialect detection ─────────────────────────────────────────────────────

describe('detectDialect', () => {
  it('classifies Gemini by event name, Codex by turn_id, Claude Code by default', () => {
    expect(detectDialect({}, 'BeforeTool')).toBe('gemini');
    expect(detectDialect({ turn_id: 't1' }, 'PreToolUse')).toBe('codex');
    expect(detectDialect({}, 'PreToolUse')).toBe('claude-code');
    expect(detectDialect({}, 'Nonsense')).toBe('unknown');
  });

  it('disambiguates SessionStart/SessionEnd (shared by Gemini and Claude Code) by payload shape', () => {
    // Gemini payloads carry `timestamp` and no `permission_mode`; Claude Code's
    // carry `permission_mode`. The two share these event names verbatim.
    expect(detectDialect({ timestamp: '2026-08-04T00:00:00Z', cwd: '/p' }, 'SessionStart')).toBe('gemini');
    expect(detectDialect({ timestamp: '2026-08-04T00:00:00Z' }, 'SessionEnd')).toBe('gemini');
    expect(detectDialect({ permission_mode: 'default', prompt_id: 'p1' }, 'SessionStart')).toBe('claude-code');
    // Absent a positive Gemini signal, stay on the historical Claude Code default.
    expect(detectDialect({ cwd: '/p' }, 'SessionStart')).toBe('claude-code');
  });
});

// ── Claude Code session → one trace ───────────────────────────────────────

describe('Claude Code hook sequence', () => {
  it('produces one trace with a completed Bash tool_call', () => {
    const session = 'sess-uuid-claude-1';
    apply({ hook_event_name: 'SessionStart', session_id: session, cwd: '/proj' });
    apply({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'fix the tests' });
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    apply({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_output: { exit_code: 0 } });
    apply({ hook_event_name: 'Stop', session_id: session });

    const { items } = listTraces(db, { session_id: session });
    expect(items).toHaveLength(1);

    const trace = getTrace(db, items[0].id)!;
    expect(trace.session_id).toBe(session);
    expect(trace.status).toBe('completed');
    expect(trace.input).toEqual({ prompt: 'fix the tests' });

    const tools = trace.steps.filter((s) => s.step_type === 'tool_call');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Bash');
    expect(tools[0].ended_at).not.toBeNull();
    expect(tools[0].output).toEqual({ exit_code: 0 });
  });

  it('records a 0 ms duration for an instant tool call, not null', () => {
    // A tool that opens and closes in the same millisecond has a real 0 ms
    // duration; it must be stored as 0, not dropped to null (the recorder keeps
    // 0). Freeze time so both hook events stamp the same instant.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const session = 'sess-instant';
      apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: {} });
      apply({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_output: {} });
    } finally {
      vi.useRealTimers();
    }
    const trace = getTrace(db, listTraces(db, { session_id: 'sess-instant' }).items[0].id)!;
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.duration_ms).toBe(0);
  });

  it('records a tool failure as a step error', () => {
    const session = 'sess-fail';
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: {} });
    apply({ hook_event_name: 'PostToolUseFailure', session_id: session, tool_name: 'Bash', error: 'command not found' });
    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    expect(trace.steps[0].error).toBe('command not found');
  });
});

// ── Gemini dialect (auto-detected, tool_response field) ───────────────────

describe('Gemini hook sequence', () => {
  it('auto-detects the dialect and accepts tool_response', () => {
    const session = 'sess-gemini';
    apply({ hook_event_name: 'BeforeAgent', session_id: session, prompt: 'summarize' });
    const pre = apply({ hook_event_name: 'BeforeTool', session_id: session, tool_name: 'read_file', tool_input: { path: 'a' } });
    expect(pre.dialect).toBe('gemini');
    apply({ hook_event_name: 'AfterTool', session_id: session, tool_name: 'read_file', tool_response: { content: 'hi' } });
    apply({ hook_event_name: 'SessionEnd', session_id: session });

    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    expect(trace.status).toBe('completed');
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.output).toEqual({ content: 'hi' });
  });

  it('labels a session that opens with Gemini SessionStart as gemini, not claude-code', () => {
    // Regression: Gemini's first hook is SessionStart, a name it shares with
    // Claude Code. Misdetected as claude-code, it created the trace with that
    // label; every later (correctly-detected) Gemini event reused the running
    // trace, so the whole session was permanently mislabeled claude-code.
    const session = 'sess-gemini-start';
    const start = apply({ hook_event_name: 'SessionStart', session_id: session, cwd: '/p', timestamp: '2026-08-04T00:00:00Z' });
    expect(start.dialect).toBe('gemini');
    apply({ hook_event_name: 'BeforeAgent', session_id: session, prompt: 'summarize' });
    apply({ hook_event_name: 'BeforeTool', session_id: session, tool_name: 'read_file', tool_input: { path: 'a' } });
    apply({ hook_event_name: 'AfterTool', session_id: session, tool_response: { content: 'hi' } });
    apply({ hook_event_name: 'SessionEnd', session_id: session, timestamp: '2026-08-04T00:01:00Z' });

    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    expect(trace.agent_name).toBe('gemini');
    expect((trace.metadata as { dialect?: string }).dialect).toBe('gemini');
  });
});

// ── Subagent nesting ───────────────────────────────────────────────────────

describe('subagent nesting', () => {
  it('parents subagent tool steps under the anchor and stamps agent metadata', () => {
    const session = 'sess-sub';
    apply({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'go' });
    apply({ hook_event_name: 'SubagentStart', session_id: session, agent_id: 'a1', agent_type: 'Explore', depth: 1 });
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Grep', tool_input: {}, agent_id: 'a1' });
    apply({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Grep', tool_output: {}, agent_id: 'a1' });
    apply({ hook_event_name: 'SubagentStop', session_id: session, agent_id: 'a1' });
    apply({ hook_event_name: 'Stop', session_id: session });

    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    const anchor = trace.steps.find((s) => s.name === 'subagent:Explore')!;
    expect(anchor.metadata.agent_id).toBe('a1');
    expect(anchor.metadata.agent_type).toBe('Explore');
    expect(anchor.ended_at).not.toBeNull();

    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.parent_step_number).toBe(anchor.step_number);
  });
});

// ── Session correlation & privacy ──────────────────────────────────────────

describe('correlation and privacy', () => {
  it('separates two concurrent sessions into two traces', () => {
    apply({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'one' });
    apply({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'two' });
    expect(listTraces(db, {}).total).toBe(2);
  });

  it('--no-input drops prompt and tool input', () => {
    const session = 's-priv';
    apply({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'secret' }, { noInput: true });
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, { noInput: true });
    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    expect(trace.input).toEqual({});
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.input).toEqual({});
    expect(JSON.stringify(tool.metadata)).not.toContain('rm -rf');
  });

  it('finalize with no open trace is a harmless no-op', () => {
    const r = apply({ hook_event_name: 'Stop', session_id: 'ghost' });
    expect(r.traceId).toBeNull();
    expect(listTraces(db, {}).total).toBe(0);
  });

  it('resolves the session\'s open trace by parsed instant, not byte order', () => {
    // The lookup ranks candidates by started_at, which producers write in
    // whatever form they received. A session-tagged trace from `ingest`/`record`
    // in SQLite's space form (or a negative offset) sorted above a newer live
    // trace under a byte comparison, so hook events appended to the wrong run.
    const session = 's-mixed';
    ingestTrace(db, {
      agent_name: 'earlier',
      session_id: session,
      status: 'running',
      started_at: '2026-08-17T10:00:00Z',
      steps: [{ step_number: 1, step_type: 'thought', name: 'a' }],
    });
    ingestTrace(db, {
      agent_name: 'later',
      session_id: session,
      status: 'running',
      started_at: '2026-08-17 16:00:00', // later instant, lower byte order
      steps: [{ step_number: 1, step_type: 'thought', name: 'b' }],
    });
    const later = listTraces(db, { session_id: session }).items.find((t) => t.agent_name === 'later')!;

    const r = apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(r.traceId).toBe(later.id);
  });

  it('keeps capturing into the live trace after it has been forked', () => {
    // A fork copies the original's session_id and opens the copy as `running`
    // with a newer started_at, so it used to win "newest running trace for this
    // session": every later hook event landed in the what-if copy, leaving the
    // real run stranded mid-capture and never finalized.
    const session = 's-forked';
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'ls' } });
    apply({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_response: { ok: true } });
    const live = listTraces(db, { session_id: session }).items[0].id;

    const fork = forkTrace(db, live, 1);

    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Read', tool_input: { path: '/f' } });
    const stop = apply({ hook_event_name: 'Stop', session_id: session });

    // The live run received the later tool call and the finalization.
    expect(stop.traceId).toBe(live);
    const liveTrace = getTrace(db, live)!;
    expect(liveTrace.status).toBe('completed');
    expect(liveTrace.steps.map((s) => s.name)).toContain('Read');
    // The fork stayed a clean copy of the steps it was forked from.
    const forked = getTrace(db, fork.forked_trace_id)!;
    expect(forked.status).toBe('running');
    expect(forked.steps.map((s) => s.name)).not.toContain('Read');
  });
});

// ── Structured tool-failure errors ────────────────────────────────────────

describe('PostToolUseFailure with a structured error', () => {
  // Regression: str() returns undefined for a non-string, so a harness that
  // reports {message, code, stderr} had the whole object collapsed to the
  // generic "tool failed" — unrecoverably, since a post-tool payload is stored
  // nowhere else (rawMeta is attached only to the pre-tool step).
  it('preserves the detail instead of collapsing it to "tool failed"', () => {
    const session = 'sess-structured-err';
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { c: 'x' } });
    apply({
      hook_event_name: 'PostToolUseFailure',
      session_id: session,
      tool_name: 'Bash',
      error: { message: 'boom', code: 1, stderr: 'stack trace here' },
    });
    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    const err = trace.steps[0].error!;
    expect(err).toContain('boom');
    expect(err).toContain('stack trace here');
  });

  it('still falls back to "tool failed" when there is no error detail', () => {
    const session = 'sess-no-err';
    apply({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { c: 'x' } });
    apply({ hook_event_name: 'PostToolUseFailure', session_id: session, tool_name: 'Bash' });
    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    expect(trace.steps[0].error).toBe('tool failed');
  });
});

// ── Prototype-inherited event names ───────────────────────────────────────

/**
 * EVENT_ACTIONS is an object literal, so it inherits from Object.prototype. An
 * unguarded lookup for an event named `constructor` / `toString` /
 * `hasOwnProperty` / `__proto__` returned the INHERITED function — truthy, so
 * the `action === 'unknown'` early return was skipped, the returned `action`
 * was a function rather than a HookAction, and each such event created a zombie
 * `running` trace that nothing ever finalizes.
 */
describe('event names inherited from Object.prototype', () => {
  it('ignores them instead of creating a zombie trace', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const r = apply({ hook_event_name: name, session_id: `s-${name}` });
      expect(r.action).toBe('unknown');
      expect(r.traceId).toBeNull();
      expect(r.note).toContain('ignored event');
    }
    expect(listTraces(db, {}).total).toBe(0);
  });

  it('still detects a real event name', () => {
    expect(detectDialect({}, 'PreToolUse')).toBe('claude-code');
    expect(detectDialect({}, 'constructor')).toBe('unknown');
  });
});

// ── runHook: no-payload handling (fail-closed under --enforce) ─────────────

/**
 * `runHook` reads one payload from stdin. When stdin is empty or unreadable we
 * never saw a payload and therefore could not evaluate policies — the same
 * position as a throw before the verdict, which the command deliberately fails
 * closed on. Both branches used to `return` with exit 0 above all the
 * fail-closed logic, without ever consulting `--enforce`: a harness crash or a
 * broken pipe silently ALLOWED the pending tool call on a gate that exists to
 * stop it.
 */
describe('runHook with no payload', () => {
  let stdout: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const realStdin = process.stdin;

  function setStdinBuffers(chunks: Buffer[]) {
    Object.defineProperty(process, 'stdin', {
      value: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } },
      configurable: true,
    });
  }

  function setStdin(chunks: string[]) {
    Object.defineProperty(process, 'stdin', {
      value: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } },
      configurable: true,
    });
  }

  beforeEach(() => {
    stdout = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdout.push(String(c));
      return true;
    }) as unknown as ReturnType<typeof vi.spyOn>;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    writeSpy.mockRestore();
    errSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    process.exitCode = undefined;
  });

  it('blocks a gating event under --enforce when stdin is empty', async () => {
    const { runHook } = await import('../src/commands/hook.js');
    setStdin(['']);
    await runHook('PreToolUse', { enforce: true, dir: '/nonexistent-should-not-be-touched' });

    const decision = JSON.parse(stdout.join('')) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('fail closed');
  });

  it('stays silent in capture mode when stdin is empty', async () => {
    const { runHook } = await import('../src/commands/hook.js');
    setStdin(['']);
    await runHook('PreToolUse', { dir: '/nonexistent-should-not-be-touched' });

    // Capture must never write to stdout — stdout is read as a hook decision.
    expect(stdout.join('')).toBe('');
    expect(process.exitCode).toBe(0);
  });

  // Capture mode's contract is a SAFETY invariant, not a nicety: in these
  // harnesses exit 2 blocks the agent and stdout is read as a hook decision, so
  // a capture hook that ever exits non-zero or prints a byte can stop or steer
  // somebody's run. Only the empty-stdin shape was pinned; this is the rest of
  // what a real harness can hand it — every one verified by hand against the
  // built CLI before being written down here.
  it.each([
    ['a well-formed PreToolUse', '{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'],
    ['a well-formed PostToolUse', '{"session_id":"s1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":{"out":"x"}}'],
    ['a body that is not JSON', 'not json at all'],
    ['a bare null', 'null'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['an event name it does not know', '{"session_id":"s1","hook_event_name":"Nonsense"}'],
    ['a payload with no session_id', '{"hook_event_name":"PreToolUse","tool_name":"Bash"}'],
    ['a session_id that is not a string', '{"session_id":{"a":1},"hook_event_name":"PreToolUse","tool_name":"B"}'],
    ['whitespace only', '   \n  '],
  ])('capture stays silent and exits 0 on %s', async (_label, payload) => {
    const { runHook } = await import('../src/commands/hook.js');
    setStdin([payload]);
    await runHook('PreToolUse', { dir: '/nonexistent-should-not-be-touched' });
    expect(stdout.join('')).toBe('');
    // `undefined` is Node's exit-0; an explicit 0 is equally fine.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('capture stays silent and exits 0 on a payload far larger than one pipe chunk', async () => {
    const { runHook } = await import('../src/commands/hook.js');
    setStdin([JSON.stringify({
      session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'B',
      tool_input: { x: 'a'.repeat(200_000) },
    })]);
    await runHook('PreToolUse', { dir: '/nonexistent-should-not-be-touched' });
    expect(stdout.join('')).toBe('');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('decodes a payload split mid-character across stdin chunks', async () => {
    // A pipe delivers 64 KiB chunks, and `raw += chunk` decoded each chunk on
    // its own — so a multi-byte character straddling a boundary became U+FFFD.
    // The JSON stayed valid (the damage sits inside a string), so nothing
    // reported it: a content-based deny stopped matching the corrupted text and
    // the tool call was allowed, with the same mangled text stored as the audit
    // record. Split a payload right through a 3-byte character to reproduce it.
    const dir = mkdtempSync(join(tmpdir(), 'ar-hook-utf8-'));
    try {
      const hdb = ensureDatabase(resolve(dir, 'traces.db'));
      addPolicy(hdb, { name: 'no-cjk', action: 'deny', match_pattern: { input_contains: '秘密鍵' } });
      resetConnection(); // runHook opens its own connection to the same file

      const payload = Buffer.from(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: 's-utf8',
          tool_name: 'Bash',
          tool_input: { command: 'echo 秘密鍵' },
        }),
        'utf8',
      );
      const cut = payload.indexOf(Buffer.from('秘', 'utf8')) + 1; // mid-character
      setStdinBuffers([payload.subarray(0, cut), payload.subarray(cut)]);

      const { runHook } = await import('../src/commands/hook.js');
      await runHook('PreToolUse', { enforce: true, dir });

      const decision = JSON.parse(stdout.join('')) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
      // The policy matched the real text, not a fail-closed error block.
      expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('秘密鍵');
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks under --enforce when the store the hook points at does not exist', async () => {
    // The store path resolves from the process's cwd and ensureDatabase CREATES
    // what it doesn't find, so a hook firing from any directory but the project
    // root got a brand-new store with zero policies and allowed everything —
    // the one condition on this path that failed OPEN.
    const missing = join(tmpdir(), 'ar-hook-no-store-does-not-exist');
    rmSync(missing, { recursive: true, force: true });
    setStdin([JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: {} })]);

    const { runHook } = await import('../src/commands/hook.js');
    await runHook('PreToolUse', { enforce: true, dir: missing });

    const decision = JSON.parse(stdout.join('')) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(/no trace store/);
    // And it did not leave a decoy store behind for the next invocation to trust.
    expect(existsSync(missing)).toBe(false);
  });

  it('allows a non-gating event under --enforce when stdin is empty', async () => {
    const { runHook } = await import('../src/commands/hook.js');
    setStdin(['']);
    await runHook('Stop', { enforce: true, dir: '/nonexistent-should-not-be-touched' });

    // Only pre_tool gates an action; blocking anything else would be noise.
    expect(stdout.join('')).toBe('');
    expect(process.exitCode).toBe(0);
  });
});

describe('a closing hook event that arrives after the turn ended', () => {
  it('records the result on the finalized trace instead of opening a phantom one', () => {
    // Every hook fires as its own process. When the turn-ending Stop commits
    // first — deterministically when the harness dispatches it before the tool
    // result arrives, and in ~47% of simultaneous spawns (measured, 14/30) —
    // PostToolUse used to find no OPEN trace and CREATE one: the tool's output,
    // ended_at and duration were discarded, the real step stayed open forever,
    // and the store gained an empty `running` trace that `list`, `watch` and the
    // dashboard all render as a live run.
    apply({ hook_event_name: 'SessionStart', session_id: 's1', permission_mode: 'default' });
    apply({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    apply({ hook_event_name: 'Stop', session_id: 's1' });
    const res = apply({
      hook_event_name: 'PostToolUse', session_id: 's1',
      tool_name: 'Bash', tool_output: { stdout: 'a.txt' },
    });

    // Exactly one trace — no phantom.
    const traces = listTraces(db, {}).items;
    expect(traces).toHaveLength(1);
    expect(traces[0].status).toBe('completed');

    // ...and the result is kept, not dropped: the step is closed, with output.
    const trace = getTrace(db, traces[0].id)!;
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.output).toEqual({ stdout: 'a.txt' });
    expect(tool.ended_at).not.toBeNull();
    expect(res.traceId).toBe(traces[0].id);
  });

  it('is a clean no-op when the session has no trace at all', () => {
    // A closing event must never create a trace, including when nothing opened
    // one — a stray PostToolUse should record nothing, not a 0-step run.
    const res = apply({
      hook_event_name: 'PostToolUse', session_id: 'never-seen',
      tool_name: 'Bash', tool_output: { stdout: 'x' },
    });
    expect(res.traceId).toBeNull();
    expect(listTraces(db, {}).total).toBe(0);
  });
});

describe('enforcement fails closed on a call it cannot evaluate', () => {
  it('routes by the registered event when the payload names one we cannot route', () => {
    // The payload's event name always won, so a harness whose pre-tool event we
    // do not model (`tool.before`) made `action` unknown: the missing-store gate,
    // the empty-policy gate and policy evaluation were ALL skipped and the call
    // was allowed — on a command line stating gating intent twice (`PreToolUse`
    // and `--enforce`). The registered argument is the operator's declaration.
    expect(resolveHookRouting({ hook_event_name: 'tool.before' }, 'PreToolUse').action).toBe('pre_tool');
    // A recognized payload name still wins over the argument.
    expect(resolveHookRouting({ hook_event_name: 'Stop' }, 'PreToolUse').action).toBe('finalize');
    // Both unrecognized stays unknown.
    expect(resolveHookRouting({ hook_event_name: 'nope' }, 'alsonope').action).toBe('unknown');
  });

  it('denies a tool call with no usable tool_name under --enforce', () => {
    // An unusable name makes every name-keyed policy unable to match, so a
    // `name_contains` deny cannot fire. guard-service fails CLOSED on an
    // unusable POLICY field; this is the same question about a STEP field.
    addPolicy(db, { name: 'byname', match_pattern: { name_contains: 'bash' }, action: 'deny' });
    const res = apply(
      { hook_event_name: 'PreToolUse', session_id: 'n1', tool_input: { command: 'x' } },
      { enforce: true },
    );
    expect(res.enforcement?.action).toBe('deny');

    // Capture mode never blocks, and still records the step.
    const capture = apply(
      { hook_event_name: 'PreToolUse', session_id: 'n2', tool_input: { command: 'x' } },
      { enforce: false },
    );
    expect(capture.enforcement).toBeUndefined();
  });
});

describe('the guard_check audit step is closed when it is written', () => {
  // It records a decision that is already made, and nothing emits a PostToolUse
  // for a guard check — so left open it stays open forever: `show` renders an
  // in-flight step under a COMPLETED trace, once per enforcement decision. The
  // denied tool_call beside it is closed for exactly this reason.
  it('leaves no open step behind after a deny', () => {
    addPolicy(db, { name: 'no-bash', match_pattern: { step_type: 'tool_call', name_contains: 'Bash' }, action: 'deny' });
    apply({ hook_event_name: 'UserPromptSubmit', session_id: 'gc1', prompt: 'go' });
    const res = apply(
      { hook_event_name: 'PreToolUse', session_id: 'gc1', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      { enforce: true },
    );
    expect(res.enforcement?.action).toBe('deny');
    apply({ hook_event_name: 'Stop', session_id: 'gc1' });

    const trace = getTrace(db, res.traceId!)!;
    expect(trace.status).toBe('completed');
    const guard = trace.steps.find((st) => st.step_type === 'guard_check')!;
    expect(guard).toBeTruthy();
    expect(guard.ended_at).toBeTruthy();
    // The decision's cost belongs to the tool_call it explains; no invented span.
    expect(guard.duration_ms).toBe(0);
    // ...and the trace holds no open step at all.
    expect(trace.steps.filter((st) => !st.ended_at)).toEqual([]);
  });
});

describe('a closing event finds the run that is waiting for it', () => {
  it('prefers the trace holding a matching open step over merely the newest', () => {
    // session_id is not exclusive to the hook path — `otel serve` merges on it
    // and both importers set it — so "the session's newest trace" can be one
    // another writer created, and the result was attached there (or dropped)
    // while the step it belonged to stayed open forever.
    apply({ hook_event_name: 'SessionStart', session_id: 'shared', permission_mode: 'default' });
    apply({ hook_event_name: 'PreToolUse', session_id: 'shared', tool_name: 'Bash', tool_input: { command: 'go' } });

    // Another writer adds a NEWER trace for the same session.
    ingestTrace(db, {
      agent_name: 'other-writer', status: 'completed', session_id: 'shared',
      input: {}, started_at: new Date(Date.now() + 60_000).toISOString(),
      steps: [{ step_number: 1, step_type: 'output', name: 'x' }],
    });

    apply({
      hook_event_name: 'PostToolUse', session_id: 'shared',
      tool_name: 'Bash', tool_output: { stdout: 'LIVE' },
    });

    const hookTrace = listTraces(db, {}).items.find((t) => t.agent_name === 'claude-code')!;
    const tool = getTrace(db, hookTrace.id)!.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.output).toEqual({ stdout: 'LIVE' });
    expect(tool.ended_at).not.toBeNull();
  });
});

describe('parallel tool calls pair in call order', () => {
  // Harnesses dispatch tools in parallel batches and the results come back in
  // call order, but the open-step lookup was `ORDER BY step_number DESC` — so
  // with two `Bash` calls in flight the first result closed the SECOND step.
  // Both outputs were swapped, and the expensive half is that a FAILURE landed
  // on the call that had actually succeeded while the one that failed was
  // stored clean: a fabricated failure and a fail-open at once, on the primary
  // capture path. The same reasoning had already been applied to the gemini
  // stream translator, citing this function as the precedent — it had the bug.
  function openTwo(): string {
    apply({ session_id: 'par', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'first' } });
    apply({ session_id: 'par', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'second' } });
    return listTraces(db, { session_id: 'par' }).items[0].id;
  }

  it('closes the oldest open call first, so outputs are not swapped', () => {
    const id = openTwo();
    apply({ session_id: 'par', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { out: 'result-of-first' } });
    apply({ session_id: 'par', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { out: 'result-of-second' } });

    const steps = getTrace(db, id)!.steps.filter((s) => s.step_type === 'tool_call');
    expect((steps[0].input as { command?: string }).command).toBe('first');
    expect(JSON.stringify(steps[0].output)).toContain('result-of-first');
    expect((steps[1].input as { command?: string }).command).toBe('second');
    expect(JSON.stringify(steps[1].output)).toContain('result-of-second');
  });

  it('puts a failure on the call that actually failed', () => {
    const id = openTwo();
    // The first call's result arrives first and it failed.
    apply({ session_id: 'par', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_response: { error: 'first exploded' } });

    const steps = getTrace(db, id)!.steps.filter((s) => s.step_type === 'tool_call');
    expect((steps[0].input as { command?: string }).command).toBe('first');
    expect(steps[0].error).not.toBeNull();
    // The call still in flight is untouched — no fabricated failure.
    expect(steps[1].error).toBeNull();
  });
});
