import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { addPolicy, evaluateStep, verdictForMatches, resolveGuardExit, testPolicies, removePolicy, validateMatchPattern, listPolicies } from '../src/services/guard-service.js';
import { startTrace, ingestTrace } from '../src/services/trace-service.js';
import type { TraceStep } from '../src/models/types.js';
import type { StepType } from '../src/models/enums.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

function makeStep(over: Partial<TraceStep> & { step_type: StepType; name: string }): TraceStep {
  return {
    id: '', trace_id: '', step_number: 1,
    input: {}, output: null, started_at: '', ended_at: null, duration_ms: null,
    tokens_used: null, model: null, error: null, metadata: {},
    parent_step_number: null, caused_by_step_number: null,
    ...over,
  };
}

// ── evaluateStep + verdictForMatches ──────────────────────────────────────

describe('single-step evaluation', () => {
  it('allows when no policy matches', () => {
    addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'search_flights' })));
    expect(v.action).toBe('allow');
    expect(v.policy).toBeNull();
  });

  it('denies a matching tool call', () => {
    addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_user' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('no-delete');
    expect(v.reason).toContain('delete');
  });

  it('attributes a block deterministically among equal-priority matches', () => {
    // Two same-priority deny policies both match. The verdict action is deny
    // either way, but the *attributed* policy must be stable (not SQLite's
    // incidental row order). Inserted in non-alphabetical order to prove the
    // name tiebreaker, not insertion order, decides.
    addPolicy(db, { name: 'zzz-block', action: 'deny', priority: 5, match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    addPolicy(db, { name: 'aaa-block', action: 'deny', priority: 5, match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_user' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('aaa-block'); // name-ascending tiebreak, stable across runs
  });

  it('matches name_contains case-insensitively, so casing cannot bypass a policy', () => {
    addPolicy(db, { name: 'no-delete', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    for (const name of ['DELETE_USER', 'Delete_User', 'deLeTe_records']) {
      const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name })));
      expect(v.action, name).toBe('deny');
    }
  });

  it('warns without blocking', () => {
    addPolicy(db, { name: 'token-warn', action: 'warn', match_pattern: { step_type: 'llm_call' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'llm_call', name: 'generate' })));
    expect(v.action).toBe('warn');
  });

  it('matches a destructive command in the tool input via input_contains (case-insensitive)', () => {
    addPolicy(db, { name: 'no-rm-rf', action: 'deny', match_pattern: { input_contains: 'rm -rf' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', input: { cmd: 'RM -RF /data' } })));
    expect(v.action).toBe('deny');
  });

  it('matches on step output via output_contains (case-insensitive)', () => {
    addPolicy(db, { name: 'no-urls', action: 'deny', match_pattern: { output_contains: 'http' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'fetch', output: { body: 'go to HTTP://evil.example' } })));
    expect(v.action).toBe('deny');
  });

  it('matches by name_regex and lets non-matching names through', () => {
    addPolicy(db, { name: 'destructive', action: 'deny', match_pattern: { name_regex: '^(delete|drop|truncate)_' } });
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'drop_table' }))).action).toBe('deny');
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_table' }))).action).toBe('allow');
  });

  it('requires every pattern field to match (AND semantics)', () => {
    addPolicy(db, { name: 'combo', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    // Right name but wrong step_type → the policy does not fire.
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'llm_call', name: 'delete_it' }))).action).toBe('allow');
  });

  it('treats an empty match pattern as inert (a misconfigured policy blocks nothing)', () => {
    addPolicy(db, { name: 'empty', action: 'deny', match_pattern: {} });
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' }))).action).toBe('allow');
  });

  it('picks the most restrictive action when several match, regardless of priority', () => {
    // A high-priority warn and a low-priority deny both match the same step.
    addPolicy(db, { name: 'warn-high', action: 'warn', priority: 100, match_pattern: { step_type: 'tool_call' } });
    addPolicy(db, { name: 'deny-low', action: 'deny', priority: 1, match_pattern: { name_contains: 'wire' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'wire_transfer' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('deny-low');
  });
});

// ── resolveGuardExit (exit-code contract, TTY vs non-TTY) ──────────────────

describe('resolveGuardExit', () => {
  it('maps allow and warn to exit 0', () => {
    expect(resolveGuardExit('allow', { isTty: false }).exitCode).toBe(0);
    expect(resolveGuardExit('warn', { isTty: false }).exitCode).toBe(0);
  });

  it('maps deny to exit 2', () => {
    expect(resolveGuardExit('deny', { isTty: false })).toEqual({ final: 'deny', exitCode: 2 });
  });

  it('require_review fails closed without a TTY', () => {
    expect(resolveGuardExit('require_review', { isTty: false })).toEqual({ final: 'deny', exitCode: 2 });
  });

  it('require_review honors the confirmation when a TTY is present', () => {
    expect(resolveGuardExit('require_review', { isTty: true, confirmed: true })).toEqual({ final: 'allow', exitCode: 0 });
    expect(resolveGuardExit('require_review', { isTty: true, confirmed: false })).toEqual({ final: 'deny', exitCode: 2 });
  });
});

// ── testPolicies error-message accuracy ────────────────────────────────────

describe('testPolicies messages', () => {
  it('distinguishes a missing trace from an empty one', () => {
    const empty = startTrace(db, { agent_name: 'e' }); // real trace, no steps
    expect(() => testPolicies(db, empty.id)).toThrow(/has no steps to test/);
    expect(() => testPolicies(db, 'trc_missing')).toThrow(/not found/);
  });
});

describe('removePolicy', () => {
  const count = () => (db.prepare('SELECT COUNT(*) as c FROM guardrail_policies').get() as { c: number }).c;

  it('removes a policy by name or by id and leaves the others intact', () => {
    addPolicy(db, { name: 'a', action: 'deny', match_pattern: { name_contains: 'x' } });
    const b = addPolicy(db, { name: 'b', action: 'deny', match_pattern: { name_contains: 'y' } });
    expect(count()).toBe(2);

    removePolicy(db, 'a'); // by name
    expect(count()).toBe(1);

    removePolicy(db, b.id); // by id
    expect(count()).toBe(0);
  });

  it('throws when the policy does not exist', () => {
    expect(() => removePolicy(db, 'nope')).toThrow(/not found/);
  });
});

describe('testPolicies pre-flight matching', () => {
  it('reports the deny/warn matches per step, leaving safe steps unflagged', () => {
    addPolicy(db, { name: 'no-del', action: 'deny', match_pattern: { step_type: 'tool_call', name_contains: 'delete' } });
    addPolicy(db, { name: 'llm-warn', action: 'warn', match_pattern: { step_type: 'llm_call' } });
    const t = ingestTrace(db, {
      agent_name: 'mix',
      status: 'completed',
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'search', input: { q: 'x' } },
        { step_number: 2, step_type: 'tool_call', name: 'delete_records', input: { table: 'logs' } },
        { step_number: 3, step_type: 'llm_call', name: 'generate' },
        { step_number: 4, step_type: 'output', name: 'done' },
      ],
    });

    const results = testPolicies(db, t.id);
    const byStep = (n: number) => results.find((r) => r.step.step_number === n)!;
    expect(byStep(1).matches).toHaveLength(0); // safe tool call
    expect(byStep(2).matches.map((m) => m.action)).toEqual(['deny']);
    expect(byStep(2).matches[0].policy.name).toBe('no-del');
    expect(byStep(3).matches.map((m) => m.action)).toEqual(['warn']);
    expect(byStep(4).matches).toHaveLength(0); // output step
  });
});

// ── malformed patterns must never fail open (safety) ───────────────────────

describe('malformed patterns fail closed, not open', () => {
  it('validateMatchPattern rejects an invalid/unsafe regex and non-string values', () => {
    expect(validateMatchPattern({ name_regex: '[unclosed' })).toMatch(/valid or safe/);
    expect(validateMatchPattern({ name_regex: '(a+)+' })).toMatch(/valid or safe/); // ReDoS
    expect(validateMatchPattern({ name_regex: 42 })).toMatch(/must be a string/);
    expect(validateMatchPattern({ input_contains: 123 })).toMatch(/must be a string/);
    expect(validateMatchPattern({ step_type: true })).toMatch(/must be a string/);
    // An out-of-enum step_type (a typo like "toolcall" for "tool_call") can never
    // match a real step — reject it so a deny isn't saved as a silent no-op.
    expect(validateMatchPattern({ step_type: 'toolcall' })).toMatch(/must be one of/);
    expect(validateMatchPattern({ step_type: 'tool-call', name_contains: 'rm' })).toMatch(/must be one of/);
    // Usable patterns pass.
    expect(validateMatchPattern({ step_type: 'tool_call', name_regex: 'delete' })).toBeNull();
    expect(validateMatchPattern({ name_contains: 'rm' })).toBeNull();
  });

  it('validateMatchPattern rejects a pattern with no recognized match key', () => {
    // A typo'd key (the real one is `name_contains`) leaves the pattern with no
    // recognized keys, so it matches nothing — a deny that never fires. Reject
    // it at add time rather than saving a silent no-op kill-switch.
    expect(validateMatchPattern({ tool_name: 'delete' })).toMatch(/at least one match key/);
    expect(validateMatchPattern({})).toMatch(/at least one match key/);
  });

  it('a deny policy with a non-string step_type blocks (fails closed), not silently never matches', () => {
    // A non-string step_type can never equal a real step_type; a deny must not
    // silently never fire. Inserted directly (a legacy / pre-validation row).
    addPolicy(db, { name: 'legacy-badtype', action: 'deny', match_pattern: { step_type: true } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('legacy-badtype');
  });

  it('a warn policy with a non-string step_type does not spuriously fire', () => {
    addPolicy(db, { name: 'warn-badtype', action: 'warn', match_pattern: { step_type: true } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' })));
    expect(v.action).toBe('allow');
  });

  it('a deny policy with an out-of-enum (but string) step_type blocks, not silently never matches', () => {
    // "toolcall" (typo) is a string but not a real step_type, so it can never
    // equal a real step's enum-constrained type. A deny keyed on it must fail
    // closed, not become a silent no-op. Inserted directly (legacy row).
    addPolicy(db, { name: 'legacy-typo', action: 'deny', match_pattern: { step_type: 'toolcall' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('legacy-typo');
  });

  it('a deny policy with an unusable regex blocks (fails closed) instead of being skipped', () => {
    // Inserted directly, bypassing `guard add`'s validation — e.g. a legacy row.
    addPolicy(db, { name: 'legacy-bad', action: 'deny', match_pattern: { step_type: 'tool_call', name_regex: '(x+)+' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_everything' })));
    expect(v.action).toBe('deny');
    expect(v.policy).toBe('legacy-bad');
  });

  it('a warn policy with an unusable regex does not spuriously fire', () => {
    addPolicy(db, { name: 'warn-bad', action: 'warn', match_pattern: { step_type: 'tool_call', name_regex: '(x+)+' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' })));
    expect(v.action).toBe('allow');
  });

  it('a numeric input_contains still coerces and matches the text', () => {
    addPolicy(db, { name: 'weird', action: 'deny', match_pattern: { input_contains: 123 } });
    const hit = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 't', input: { note: 'has 123 inside' } })));
    expect(hit.action).toBe('deny');
    const miss = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 't', input: { note: 'nothing here' } })));
    expect(miss.action).toBe('allow');
  });

  // An object needle stringifies to "[object Object]", which can never occur in
  // the haystack — an unusable pattern, so a deny keyed on it silently never
  // fired. It now fails closed like step_type and name_regex already did.
  it('an object input_contains fails closed for a blocking policy', () => {
    addPolicy(db, { name: 'obj-ic', action: 'deny', match_pattern: { input_contains: { eq: 'rm -rf' } } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', input: { cmd: 'anything' } })));
    expect(v.action).toBe('deny');
  });
});

// ── removePolicy targeting ─────────────────────────────────────────────────

describe('removePolicy', () => {
  // Regression: `WHERE id = ? OR name = ?` bound the same value twice, so a
  // policy literally named after another policy's id deleted BOTH rows — and
  // reported success.
  it('removes only the policy matching the id, not one merely named after it', () => {
    const a = addPolicy(db, { name: 'first', action: 'deny', match_pattern: { name_contains: 'x' } });
    const b = addPolicy(db, { name: a.id, action: 'warn', match_pattern: { name_contains: 'y' } });

    removePolicy(db, a.id);

    const remaining = listPolicies(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(b.id);
  });

  it('still removes by name when no id matches', () => {
    addPolicy(db, { name: 'by-name', action: 'deny', match_pattern: { name_contains: 'x' } });
    removePolicy(db, 'by-name');
    expect(listPolicies(db)).toHaveLength(0);
  });

  it('throws when nothing matches', () => {
    expect(() => removePolicy(db, 'nope')).toThrow(/not found/);
  });
});

// ── *_contains matches the raw text, not the JSON-escaped form ─────────────

/**
 * The haystack was `JSON.stringify(step.input)`, which escapes quotes,
 * backslashes, newlines and tabs, while the needle is the pattern as typed. A
 * deny on `rm -rf "/etc"` or a Windows path could therefore never match its own
 * step — silently, while validating cleanly and listing as an active deny.
 * These are exactly the shapes a destructive-command policy is written with.
 */
describe('*_contains against escaped characters', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['a Windows path', 'C:\\Windows\\System32', { cmd: 'del C:\\Windows\\System32\\x' }],
    ['a quoted argument', 'rm -rf "/etc"', { cmd: 'rm -rf "/etc"' }],
    ['an embedded newline', 'curl evil\nsh', { cmd: 'curl evil\nsh' }],
    ['an embedded tab', 'a\tb', { c: 'a\tb' }],
  ];

  for (const [label, pattern, input] of cases) {
    it(`denies on ${label}`, () => {
      addPolicy(db, { name: 'esc', action: 'deny', match_pattern: { input_contains: pattern } });
      const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', input })));
      expect(v.action).toBe('deny');
    });
  }

  it('still matches a pattern aimed at the JSON form itself', () => {
    // The JSON text stays part of the haystack, so a key-name pattern works.
    addPolicy(db, { name: 'keyname', action: 'deny', match_pattern: { input_contains: '"cmd"' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', input: { cmd: 'x' } })));
    expect(v.action).toBe('deny');
  });

  it('still allows a genuinely non-matching step', () => {
    addPolicy(db, { name: 'nomatch', action: 'deny', match_pattern: { input_contains: 'nope' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', input: { cmd: 'safe' } })));
    expect(v.action).toBe('allow');
  });

  it('matches escaped characters in the output too', () => {
    addPolicy(db, { name: 'out-esc', action: 'deny', match_pattern: { output_contains: 'said "hi"' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'shell', output: { t: 'she said "hi"' } })));
    expect(v.action).toBe('deny');
  });
});

// ── A pattern with no usable match key ────────────────────────────────────

/**
 * `guard add` rejects a keyless pattern, but `addPolicy` (used by the seed data
 * and any non-CLI caller), the column's `DEFAULT '{}'`, and a direct insert all
 * bypass that validation. Such a deny could never match anything, so it was a
 * kill-switch that silently never fired while `guard list` showed it active.
 */
describe('a policy with no usable match criteria', () => {
  it('leaves a genuinely empty pattern inert, even for a deny', () => {
    // An empty pattern expresses no intent to filter, and blocking every step
    // in the session would be far worse than the misconfiguration it signals.
    addPolicy(db, { name: 'empty-deny', action: 'deny', match_pattern: {} });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' })));
    expect(v.action).toBe('allow');
  });

  it('fails closed for a deny whose only key is a typo', () => {
    addPolicy(db, { name: 'typo-deny', action: 'deny', match_pattern: { nmae_contains: 'delete' } as never });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_all' })));
    expect(v.action).toBe('deny');
  });

  it('does not fire for a non-blocking policy', () => {
    addPolicy(db, { name: 'empty-warn', action: 'warn', match_pattern: {} });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'anything' })));
    expect(v.action).toBe('allow');
  });
});

// ── guard check: an unusable store must block, not allow ────────────────────

describe('runGuardCheck fails closed when policies cannot be evaluated', () => {
  it('exits 2 (block) instead of 1 when the store cannot be opened', async () => {
    // Regression: opening the store and evaluating policies were unguarded, so
    // an infrastructure error — an unopenable or read-only store, or
    // SQLITE_BUSY from a concurrent hook process — reached the CLI's top-level
    // handler, which exits 1. Exit 1 is not the block signal (2 is), so every
    // harness treated it as a non-blocking error and ran the tool: a blocking
    // pre-exec gate silently stopped denying the moment the DB was locked.
    const { runGuardCheck } = await import('../src/commands/guard.js');

    const prevExit = process.exitCode;
    const out: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // stdin: a well-formed step, so nothing else can account for the exit code.
    const stdinSpy = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(Readable.from(['{"step_type":"tool_call","name":"delete_user"}']) as typeof process.stdin);
    try {
      process.exitCode = 0;
      await runGuardCheck({ dir: '/dev/null/not-a-directory' });
      expect(process.exitCode).toBe(2);
      expect(JSON.parse(out.join('\n')).action).toBe('deny');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      stdinSpy.mockRestore();
      process.exitCode = prevExit;
    }
  });
});
