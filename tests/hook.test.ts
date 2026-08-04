import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace, listTraces } from '../src/services/trace-service.js';
import { applyHookPayload, detectDialect } from '../src/services/hook-adapter.js';

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
});
