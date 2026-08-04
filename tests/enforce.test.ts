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

// Wrap a db so the guard_check step INSERT fails (simulating a disk-full/lock
// error on the audit write) while every other operation works — step_type is a
// positional arg to the insert's run(), so we key off 'guard_check'.
function failGuardCheckWrites(real: Database.Database): Database.Database {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(s, p) {
              if (p === 'run') {
                return (...args: unknown[]) => {
                  if (args.includes('guard_check')) throw new Error('simulated audit-write failure');
                  return (s.run as (...a: unknown[]) => unknown)(...args);
                };
              }
              const val = (s as Record<string | symbol, unknown>)[p];
              return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(s) : val;
            },
          });
        };
      }
      const val = (target as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as unknown as Database.Database;
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

  it('still enforces an input-based deny under --no-input, while redacting the stored input', () => {
    // --no-input is a privacy flag; it must not turn a content-based kill-switch
    // into a no-op. The policy is evaluated against the real arguments (so the
    // dangerous call is blocked), but the STORED tool_call input is redacted.
    addPolicy(db, { name: 'no-rm', action: 'deny', match_pattern: { step_type: 'tool_call', input_contains: 'rm -rf' } });
    const session = 'sess-noinput';
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'go' }, { noInput: true });
    const res = applyHookPayload(
      db,
      { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      { enforce: true, noInput: true },
    );

    // Blocked, not allowed — the fail-open is gone.
    expect(res.enforcement?.action).toBe('deny');
    expect(res.enforcement?.policy).toBe('no-rm');

    // The stored input is still redacted for privacy.
    const trace = getTrace(db, listTraces(db, { session_id: session }).items[0].id)!;
    const tool = trace.steps.find((s) => s.step_type === 'tool_call')!;
    expect(tool.input).toEqual({});
  });

  it('fails closed: a guard_check audit-write failure still returns the deny verdict', () => {
    // A deny is already decided before the guard_check is recorded. If that
    // audit write throws (disk full, lock), the block must still be enforced —
    // letting the error propagate would have hook.ts swallow it and exit 0.
    denyPolicy();
    const session = 'sess-auditfail';
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'go' });
    const res = applyHookPayload(
      failGuardCheckWrites(db),
      { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'delete_all', tool_input: { path: '/' } },
      { enforce: true },
    );
    expect(res.enforcement?.action).toBe('deny');
    expect(res.enforcement?.policy).toBe('no-delete');
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
