import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { addPolicy } from '../src/services/guard-service.js';
import { getTrace, listTraces } from '../src/services/trace-service.js';
import { applyHookPayload, formatEnforcementResponse } from '../src/services/hook-adapter.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

function denyPolicy() {
  addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
}

// ── Enforcement recording (task 2.2) ──────────────────────────────────────

describe('enforcement recording', () => {
  it('records a blocked tool call as a tool_call attempt plus a guard_check deny', () => {
    denyPolicy();
    const session = 'sess-enf';
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'go' });
    const res = applyHookPayload(
      db,
      { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'delete_all', tool_input: { path: '/' } },
      { enforce: true },
    );

    expect(res.enforcement?.action).toBe('deny');
    expect(res.enforcement?.policy).toBe('no-delete');

    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    const guard = trace.steps.find((s) => s.step_type === 'guard_check')!;
    expect(tool.name).toBe('delete_all');
    expect(guard).toBeTruthy();
    expect(guard.caused_by_step_number).toBe(tool.step_number);
    expect(guard.output).toMatchObject({ action: 'deny', policy: 'no-delete' });
  });

  it('does not record a guard_check when nothing matches (allow)', () => {
    denyPolicy();
    const session = 'sess-ok';
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'go' });
    const res = applyHookPayload(
      db,
      { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'read_file', tool_input: {} },
      { enforce: true },
    );
    expect(res.enforcement).toBeUndefined();
    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    expect(trace.steps.some((s) => s.step_type === 'guard_check')).toBe(false);
  });

  it('capture mode (no --enforce) never returns an enforcement verdict', () => {
    denyPolicy();
    const res = applyHookPayload(db, { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'delete_x', tool_input: {} });
    expect(res.enforcement).toBeUndefined();
  });
});

// ── Dialect response formatting (task 3.1, 3.2) ────────────────────────────

describe('formatEnforcementResponse', () => {
  const deny = { action: 'deny' as const, policy: 'p', reason: 'blocked: delete' };
  const review = { action: 'require_review' as const, policy: 'p', reason: 'needs review' };
  const warn = { action: 'warn' as const, policy: 'p', reason: 'heads up' };

  it('Claude Code / Codex deny → permissionDecision deny, exit 0', () => {
    for (const dialect of ['claude-code', 'codex'] as const) {
      const r = formatEnforcementResponse(dialect, deny, 'PreToolUse');
      expect(r.exitCode).toBe(0);
      expect((r.stdout as any).hookSpecificOutput.permissionDecision).toBe('deny');
      expect((r.stdout as any).hookSpecificOutput.permissionDecisionReason).toContain('delete');
    }
  });

  it('require_review maps to "ask" on Claude Code / Codex', () => {
    const r = formatEnforcementResponse('claude-code', review, 'PreToolUse');
    expect((r.stdout as any).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('Gemini deny → {decision: deny}, and review → deny-with-reason, exit 0', () => {
    const d = formatEnforcementResponse('gemini', deny, 'BeforeTool');
    expect(d.exitCode).toBe(0);
    expect((d.stdout as any).decision).toBe('deny');
    const rv = formatEnforcementResponse('gemini', review, 'BeforeTool');
    expect((rv.stdout as any).reason).toMatch(/review required/);
  });

  it('unknown dialect (Crush) falls back to exit 2 with stderr reason', () => {
    const r = formatEnforcementResponse('unknown', deny, 'PreToolUse');
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBeNull();
    expect(r.stderrReason).toContain('delete');
  });

  it('warn never blocks (exit 0) and surfaces a systemMessage on Claude Code', () => {
    const r = formatEnforcementResponse('claude-code', warn, 'PreToolUse');
    expect(r.exitCode).toBe(0);
    expect((r.stdout as any).systemMessage).toContain('heads up');
  });
});
