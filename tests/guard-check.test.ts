import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { addPolicy, evaluateStep, verdictForMatches, resolveGuardExit, testPolicies, removePolicy, validateMatchPattern, listPolicies, noEnabledPolicyReason, setPolicyEnabled } from '../src/services/guard-service.js';
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

describe('name_contains fails closed like every other match key', () => {
  it('treats an unusable name_contains as a match for a blocking policy', () => {
    // Regression: name_contains was the one key that didn't fail closed. An
    // object value stringifies to "[object Object]", which can never occur in a
    // step name, so a deny policy written that way validated, listed as an
    // active deny, and silently never fired. `guard add` rejects a non-string,
    // but addPolicy (seed data, any SDK caller) and a direct insert bypass it.
    addPolicy(db, { name: 'bad-deny', action: 'deny', match_pattern: { name_contains: { oops: 1 } as never } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_user' })));
    expect(v.action).toBe('deny');
    expect(v.reason).toMatch(/unusable/);
  });

  it('leaves a non-blocking policy inert', () => {
    addPolicy(db, { name: 'bad-warn', action: 'warn', match_pattern: { name_contains: { oops: 1 } as never } });
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'x' }))).action).toBe('allow');
  });

  it('still matches a normal string needle', () => {
    addPolicy(db, { name: 'ok-deny', action: 'deny', match_pattern: { name_contains: 'delete' } });
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_user' }))).action).toBe('deny');
    expect(verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_user' }))).action).toBe('allow');
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

describe('guard enable/disable', () => {
  it('silences a policy without deleting it, and restores it', async () => {
    // `enabled` was write-once: addPolicy hard-codes 1 and no command could
    // change it, so the only way to silence a policy was to delete it — losing
    // its id, description and priority — and retype it to bring it back.
    const { setPolicyEnabled, addPolicy: add } = await import('../src/services/guard-service.js');
    const step = { step_type: 'tool_call', name: 'bash' } as unknown as TraceStep;
    const db2 = new Database(':memory:');
    try {
      db2.pragma('foreign_keys = ON');
      runMigrations(db2);
      const pol = add(db2, { name: 'no-bash', action: 'deny', match_pattern: { name_contains: 'bash' } });
      expect(evaluateStep(db2, step)).toHaveLength(1);

      // By name…
      expect(setPolicyEnabled(db2, 'no-bash', false)).toBe('no-bash');
      expect(evaluateStep(db2, step)).toHaveLength(0);
      // …and by id, which must resolve to the same row.
      expect(setPolicyEnabled(db2, pol.id, true)).toBe('no-bash');
      expect(evaluateStep(db2, step)).toHaveLength(1);
      // The policy itself is untouched: same id, still listed.
      expect(listPolicies(db2)[0].id).toBe(pol.id);

      expect(() => setPolicyEnabled(db2, 'no-such-policy', false)).toThrow(/not found/);
    } finally {
      db2.close();
    }
  });
});

describe('a policy matches the name an operator meant', () => {
  // A guard compares a policy's needle against a producer-supplied name, and
  // comparing raw code points let a name evade a policy while still reading as
  // the same word: `name_contains: "delete"` did not match the fullwidth
  // `\uff44\uff45\uff4c\uff45\uff54\uff45_user`, nor `delete_user` with a zero-width space in
  // it. Case folding alone was not enough. Both sides are folded now (NFKC plus
  // removal of zero-width and soft-hyphen characters), which can only make a
  // policy match MORE — the safe direction for a guard, since over-matching
  // blocks a call the operator can see and amend while under-matching runs the
  // one they meant to stop.
  beforeEach(() => {
    addPolicy(db, { name: 'nodelete', action: 'deny', match_pattern: { name_contains: 'delete' } });
  });

  it.each([
    ['fullwidth homoglyphs', '\uff44\uff45\uff4c\uff45\uff54\uff45_user'],
    ['zero-width space', 'de\u200blete_user'],
    ['zero-width non-joiner', 'de\u200clete_user'],
    ['soft hyphen', 'de\u00adlete_user'],
    ['BOM', 'de\ufefflete_user'],
    ['upper case', 'DELETE_USER'],
  ])('denies a name using %s', (_label, name) => {
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name })));
    expect(v.action).toBe('deny');
  });

  it.each([['an unrelated tool', 'dropdatabase'], ['a benign tool', 'read_file']])(
    'still allows %s',
    (_label, name) => {
      const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name })));
      expect(v.action).toBe('allow');
    },
  );

  // A regex policy is tested against the raw name AND the folded one, so a
  // homoglyph cannot slip past that matcher either.
  it('applies the same folding to a name_regex policy', () => {
    addPolicy(db, { name: 'rxdel', action: 'deny', match_pattern: { name_regex: '^delete' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: '\uff44\uff45\uff4c\uff45\uff54\uff45_x' })));
    expect(v.action).toBe('deny');
  });

  // An operator who writes the needle in a compatibility form must match a
  // plain name too — the folding is symmetric.
  it('folds the policy needle as well as the step name', () => {
    addPolicy(db, { name: 'wide', action: 'deny', match_pattern: { name_contains: '\uff52\uff4d' } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'rm_rf' })));
    expect(v.action).toBe('deny');
  });
});

describe('a duplicate policy name loses the same way however it is detected', () => {
  // The name pre-check reads outside a transaction, so two concurrent
  // `guard add` processes can both pass it and one then hits the UNIQUE
  // constraint — measured, four racing processes leaked the raw
  // "UNIQUE constraint failed: guardrail_policies.name" in 1 of 6 trials, the
  // exact message the pre-check exists to replace. The insert now maps that
  // error to the same friendly one, so the loser of a race and a plain
  // sequential duplicate get the same answer.
  it('reports the friendly message, never the constraint text', () => {
    addPolicy(db, { name: 'dup', action: 'deny', match_pattern: { name_contains: 'x' } });
    // Sequential duplicate: caught by the pre-check.
    expect(() => addPolicy(db, { name: 'dup', action: 'deny', match_pattern: { name_contains: 'x' } }))
      .toThrow(/already exists/);

    // Simulate the race: bypass the pre-check by inserting the row underneath it,
    // so the INSERT is what discovers the clash.
    db.prepare('DELETE FROM guardrail_policies WHERE name = ?').run('racer');
    const original = db.prepare.bind(db);
    let armed = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = (sql: string) => {
      if (armed && /SELECT id FROM guardrail_policies WHERE name/.test(sql)) {
        armed = false;
        // The pre-check finds nothing...
        return { get: () => undefined } as unknown as ReturnType<typeof original>;
      }
      return original(sql);
    };
    try {
      addPolicy(db, { name: 'racer', action: 'deny', match_pattern: { name_contains: 'y' } });
      // ...and now a second add with the pre-check blinded must still be friendly.
      armed = true;
      expect(() => addPolicy(db, { name: 'racer', action: 'deny', match_pattern: { name_contains: 'y' } }))
        .toThrow(/already exists/);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).prepare = original;
    }
  });
});

describe('a needle that folds away is unusable, not a match-anything', () => {
  // Folding strips zero-width and soft-hyphen characters, so a pattern written
  // with only those folds to the empty string — and `''` is a substring of every
  // string. A deny policy therefore blocked EVERY step, including `read_file`,
  // with a reason line reading "name contains ''". A stray zero-width character
  // pasted into a policy is exactly how that happens. It now takes the same
  // "unusable pattern" path a non-string needle does: still fail-closed for a
  // blocking policy, but saying why.
  const ZW = '\u200b\u200c';

  it('fails closed with a reason for a deny policy', () => {
    addPolicy(db, { name: 'zw', action: 'deny', match_pattern: { name_contains: ZW } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_file' })));
    expect(v.action).toBe('deny');
    expect(v.reason).toMatch(/unusable/);
    // The point: it is not reported as though the name genuinely matched.
    expect(v.reason).not.toMatch(/name contains ''/);
  });

  it('does not fire at all for a warn policy', () => {
    addPolicy(db, { name: 'zwarn', action: 'warn', match_pattern: { name_contains: ZW } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_file' })));
    expect(v.action).toBe('allow');
  });

  it('still folds a needle that has real content alongside zero-width padding', () => {
    addPolicy(db, { name: 'padded', action: 'deny', match_pattern: { name_contains: `de${ZW}lete` } });
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'delete_user' })));
    expect(v.action).toBe('deny');
    expect(v.reason).not.toMatch(/unusable/);
  });
});


describe('an empty *_contains needle is a universal match, not a filter', () => {
  // `''` is a substring of every string, so a deny policy written this way
  // blocks EVERY step in the session — a fail-closed that is really
  // fail-broken. It arrives through an ordinary authoring slip:
  // `--pattern "{\"name_contains\":\"$TOOL\"}"` with `$TOOL` unset in CI.
  //
  // The fold-away sibling (a needle of only zero-width characters) was already
  // rejected for exactly this reason; the LITERAL empty string was explicitly
  // excluded from that check, as though anyone writes it on purpose.
  it.each([['name_contains'], ['input_contains'], ['output_contains']])(
    'is refused at write time for %s',
    (key) => {
      const problem = validateMatchPattern({ [key]: '' });
      expect(problem).toMatch(/empty value/);
      expect(problem).toMatch(/every step/);
    },
  );

  it('still accepts a needle that is merely short, or whitespace', () => {
    // Only the EMPTY string is a universal match. A single space is a real
    // needle and must keep working.
    expect(validateMatchPattern({ name_contains: 'a' })).toBeNull();
    expect(validateMatchPattern({ name_contains: ' ' })).toBeNull();
  });

  it('fails a stored empty-needle policy closed, with a usable reason', () => {
    // A policy written before the refusal, or inserted outside the CLI, must
    // not silently match everything. Deny still blocks — that is the
    // fail-closed rule — but the reason must say the pattern is unusable
    // rather than report the nonsense "name contains ''". Inserted directly,
    // since `addPolicy` now refuses to create one.
    db.prepare(
      `INSERT INTO guardrail_policies (id, name, description, action, priority, enabled, match_pattern, action_params, tags, created_at, updated_at)
       VALUES ('p_legacy', 'legacy-empty', NULL, 'deny', 0, 1, '{"name_contains":""}', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_file' })));
    expect(v.action).toBe('deny'); // still blocks
    expect(v.reason).toMatch(/unusable/i);
    // It must not read as a genuine match. The reason names the key and its
    // empty value, which is the useful part — what it must not say is that the
    // step's name matched something, since nothing did.
    expect(v.reason).not.toMatch(/^name contains/);
  });

  it('does not fire a WARN policy with an unusable needle', () => {
    // Only blocking actions fail closed; a warn that cannot match must stay
    // quiet rather than warn on every step.
    db.prepare(
      `INSERT INTO guardrail_policies (id, name, description, action, priority, enabled, match_pattern, action_params, tags, created_at, updated_at)
       VALUES ('p_legacy_warn', 'legacy-warn', NULL, 'warn', 0, 1, '{"name_contains":""}', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const v = verdictForMatches(evaluateStep(db, makeStep({ step_type: 'tool_call', name: 'read_file' })));
    expect(v.action).toBe('allow');
  });
});

// ── the guard commands themselves ───────────────────────────────────────────

describe('the guard commands', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let prevExit: typeof process.exitCode;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = mkdtempSync(join(tmpdir(), 'ar-guard-'));
    // `guard` resolves <dir>/traces.db, and every entry point requires the
    // store to already exist (an absent one is itself a block).
    const store = new Database(join(dir, 'traces.db'));
    store.pragma('foreign_keys = ON');
    runMigrations(store);
    store.close();

    out = []; err = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
    errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
    prevExit = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevExit;
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });

  const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
  const stdout = () => noAnsi(out.join('\n'));
  const stderr = () => noAnsi(err.join('\n'));

  /** Feed one step object to `guard check` on stdin. */
  async function check(step: unknown, opts: Record<string, unknown> = {}): Promise<void> {
    const { runGuardCheck } = await import('../src/commands/guard.js');
    const body = typeof step === 'string' ? step : JSON.stringify(step);
    const stdinSpy = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(Readable.from([body]) as typeof process.stdin);
    try {
      await runGuardCheck({ dir, ...opts });
    } finally {
      stdinSpy.mockRestore();
    }
  }

  // ── guard add ────────────────────────────────────────────────────────────

  it('refuses a pattern that is not JSON, an unknown action, and a bad priority', async () => {
    const { runGuardAdd } = await import('../src/commands/guard.js');
    const base = { name: 'p', pattern: '{"step_type":"tool_call"}', action: 'deny', dir };

    runGuardAdd({ ...base, pattern: 'not json' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Invalid JSON/);

    process.exitCode = 0; err.length = 0;
    runGuardAdd({ ...base, action: 'block' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Invalid action/);

    process.exitCode = 0; err.length = 0;
    // `safeParseInt` is a parser, so "high" used to store 0 and rank the policy
    // last instead of failing — priority decides which policy is cited.
    runGuardAdd({ ...base, priority: 'high' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Invalid --priority/);

    // Nothing was stored by any of the three.
    const db2 = new Database(`${dir}/traces.db`);
    try { expect(listPolicies(db2)).toHaveLength(0); } finally { db2.close(); }
  });

  it('warns that a blocking policy keyed on output cannot fire live', async () => {
    const { runGuardAdd } = await import('../src/commands/guard.js');
    runGuardAdd({ name: 'audit', pattern: '{"output_contains":"ssn"}', action: 'deny', dir });
    expect(process.exitCode).toBe(0);
    expect(stdout()).toMatch(/cannot block live/);

    // ...and not for a warn, which was never going to block anything anyway.
    out.length = 0;
    runGuardAdd({ name: 'audit2', pattern: '{"output_contains":"ssn"}', action: 'warn', dir });
    expect(stdout()).not.toMatch(/cannot block live/);
  });

  // ── guard test ───────────────────────────────────────────────────────────

  it('counts require_review in the summary of what would block', async () => {
    // Regression: the summary counted `deny` and `warn` only. `require_review`
    // fails closed without an approval (resolveGuardExit), so a trace whose
    // matches were all require_review listed them step by step and then printed
    // a summary that said nothing — zero, for matches that stop the run.
    const { runGuardTest } = await import('../src/commands/guard.js');
    const db2 = new Database(`${dir}/traces.db`);
    try {
      db2.pragma('foreign_keys = ON');
      addPolicy(db2, { name: 'ask-first', action: 'require_review', match_pattern: { name_contains: 'deploy' } });
      ingestTrace(db2, {
        agent_name: 'a', input: {},
        steps: [{ step_number: 1, step_type: 'tool_call', name: 'deploy_prod' }],
      } as Parameters<typeof ingestTrace>[1]);
    } finally { db2.close(); }

    const db3 = new Database(`${dir}/traces.db`);
    const traceId = (db3.prepare('SELECT id FROM agent_traces').get() as { id: string }).id;
    db3.close();

    runGuardTest(traceId, { dir });
    expect(stdout()).toMatch(/1 REQUIRE_REVIEW action\(s\) would block without an approval/);
  });

  it('is a report, not a gate: a deny match still exits 0', async () => {
    // `guard test` answers with findings, not a verdict — `guard check` and
    // `hook --enforce` are the paths that gate. Worth pinning because the exit
    // codes section opens with "every command exits non-zero on failure", and a
    // deny match is not a failure of THIS command: someone gating CI on it
    // would otherwise be relying on an accident.
    const { runGuardTest } = await import('../src/commands/guard.js');
    const db2 = new Database(`${dir}/traces.db`);
    try {
      db2.pragma('foreign_keys = ON');
      addPolicy(db2, { name: 'no-deletes', action: 'deny', match_pattern: { name_contains: 'delete' } });
      ingestTrace(db2, {
        agent_name: 'a', input: {},
        steps: [{ step_number: 1, step_type: 'tool_call', name: 'delete_user' }],
      } as Parameters<typeof ingestTrace>[1]);
    } finally { db2.close(); }

    const db3 = new Database(`${dir}/traces.db`);
    const traceId = (db3.prepare("SELECT id FROM agent_traces ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    db3.close();

    process.exitCode = 0;
    runGuardTest(traceId, { dir });
    // The finding is reported...
    expect(stdout()).toMatch(/DENY/);
    // ...and the command still succeeded.
    expect(process.exitCode).toBe(0);
  });

  it('reports a missing trace as an error, not as a clean run', async () => {
    const { runGuardTest } = await import('../src/commands/guard.js');
    runGuardTest('trc_nope', { dir });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/Trace not found/);
  });

  // ── guard check ──────────────────────────────────────────────────────────

  it.each([
    ['not json at all', 'nope', /invalid JSON/i],
    ['a JSON array', [1, 2], /expected a single step object/i],
    ['a bare null', 'null', /expected a single step object/i],
    ['a step with no name', { step_type: 'tool_call' }, /non-empty "name"/i],
    ['a step with an unknown type', { step_type: 'toolcall', name: 'x' }, /valid "step_type"/i],
  ])('blocks on %s rather than failing open', async (_label, body, pattern) => {
    const db2 = new Database(`${dir}/traces.db`);
    try { addPolicy(db2, { name: 'p', action: 'deny', match_pattern: { name_contains: 'delete' } }); }
    finally { db2.close(); }

    await check(body);
    // Exit 2 is the block signal; exit 1 reads to a wrapper as a non-blocking
    // error, which runs the tool.
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdout()).action).toBe('deny');
    expect(stderr()).toMatch(pattern);
  });

  it('blocks when the store holds no enabled policy, unless told to run unguarded', async () => {
    await check({ step_type: 'tool_call', name: 'delete_user' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/no enabled guardrail policies/);

    process.exitCode = 0; out.length = 0; err.length = 0;
    await check({ step_type: 'tool_call', name: 'delete_user' }, { allowEmpty: true });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout()).action).toBe('allow');
  });

  it('allows, warns and denies by exit code', async () => {
    const db2 = new Database(`${dir}/traces.db`);
    try {
      addPolicy(db2, { name: 'no-delete', action: 'deny', match_pattern: { name_contains: 'delete' } });
      addPolicy(db2, { name: 'noisy', action: 'warn', match_pattern: { name_contains: 'curl' } });
    } finally { db2.close(); }

    await check({ step_type: 'tool_call', name: 'read_file' });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ action: 'allow', policy: null });

    process.exitCode = 0; out.length = 0; err.length = 0;
    await check({ step_type: 'tool_call', name: 'curl_site' });
    expect(process.exitCode).toBe(0); // warn never blocks
    expect(JSON.parse(stdout())).toMatchObject({ action: 'warn', policy: 'noisy' });
    expect(stderr()).toMatch(/WARN \[noisy\]/);

    process.exitCode = 0; out.length = 0; err.length = 0;
    await check({ step_type: 'tool_call', name: 'delete_user' });
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({ action: 'deny', policy: 'no-delete' });
    expect(stderr()).toMatch(/DENY \[no-delete\]/);
  });

  it('reads whether a human is present from stderr, not from the captured stdout', async () => {
    // Regression: interactivity was read from `process.stdout.isTTY`. stdout is
    // this command's MACHINE channel — it carries the JSON verdict the README
    // documents capturing — so any wrapper that captured it (`v=$(... | guard
    // check)`, a pipe into jq) reported an operator at a live terminal as "no
    // TTY", and every require_review failed closed without ever prompting. The
    // prompt goes to stderr and the answer is read from /dev/tty.
    const db2 = new Database(`${dir}/traces.db`);
    try { addPolicy(db2, { name: 'ask', action: 'require_review', match_pattern: { name_contains: 'deploy' } }); }
    finally { db2.close(); }

    // `isTTY` is a plain data property (absent entirely when not a TTY), not a
    // getter, so it is set and restored rather than spied on.
    const prevOut = process.stdout.isTTY;
    const prevErr = process.stderr.isTTY;
    process.stdout.isTTY = false;
    process.stderr.isTTY = true;
    try {
      // stderr is a TTY, so the command prompts. /dev/tty is not readable under
      // the test runner, so the prompt declines — but "declined" is the
      // interactive answer, not the "(no TTY)" one, which is what this pins.
      await check({ step_type: 'tool_call', name: 'deploy_prod' });
      expect(stderr()).toMatch(/\(declined\)/);
      expect(stderr()).not.toMatch(/no TTY/);
      expect(process.exitCode).toBe(2);
    } finally {
      process.stdout.isTTY = prevOut;
      process.stderr.isTTY = prevErr;
    }
  });

  it('fails a require_review closed when nothing is interactive', async () => {
    const db2 = new Database(`${dir}/traces.db`);
    try { addPolicy(db2, { name: 'ask', action: 'require_review', match_pattern: { name_contains: 'deploy' } }); }
    finally { db2.close(); }

    const prevErr = process.stderr.isTTY;
    process.stderr.isTTY = false;
    try {
      await check({ step_type: 'tool_call', name: 'deploy_prod' });
      expect(process.exitCode).toBe(2);
      expect(stderr()).toMatch(/no TTY — failed closed/);
    } finally { process.stderr.isTTY = prevErr; }
  });

  // ── guard enable / disable / remove, through the commands ─────────────────

  it('disables a policy by id and reports the STORED name', async () => {
    const { runGuardToggle } = await import('../src/commands/guard.js');
    const db2 = new Database(`${dir}/traces.db`);
    let id: string;
    try { id = addPolicy(db2, { name: 'no-delete', action: 'deny', match_pattern: { name_contains: 'delete' } }).id; }
    finally { db2.close(); }

    runGuardToggle(id, false, { dir });
    expect(process.exitCode).toBe(0);
    expect(stdout()).toMatch(/Policy "no-delete" disabled/);

    // A disabled policy is skipped by every evaluation path — so the check that
    // would have blocked now has no enabled policy left at all, and blocks for
    // that reason instead.
    await check({ step_type: 'tool_call', name: 'delete_user' });
    expect(stderr()).toMatch(/no enabled guardrail policies/);
  });

  it('reports an unknown id on remove and toggle as an error', async () => {
    const { runGuardToggle, runGuardRemove } = await import('../src/commands/guard.js');
    runGuardRemove('gp_nope', { dir });
    expect(process.exitCode).toBe(1);

    process.exitCode = 0; err.length = 0;
    runGuardToggle('gp_nope', true, { dir });
    expect(process.exitCode).toBe(1);
  });

  it('lists policies, and says how to add one when there are none', async () => {
    const { runGuardList, runGuardAdd } = await import('../src/commands/guard.js');
    runGuardList({ dir });
    expect(stdout()).toMatch(/No guardrail policies found/);

    out.length = 0;
    runGuardAdd({ name: 'no-delete', pattern: '{"name_contains":"delete"}', action: 'deny', dir });
    out.length = 0;
    runGuardList({ dir });
    expect(stdout()).toMatch(/no-delete/);
    expect(stdout()).toMatch(/1 guardrail policy/);
  });
});

describe('the fail-closed refusal names the remedy that fits the store', () => {
  // "no enabled guardrail policies" has two quite different causes and the old
  // wording only served one: "add one with `guard add`". That is right for an
  // empty store and misleading for a store whose policies are all DISABLED --
  // someone who turned one off to unblock themselves and forgot would follow
  // it, end up with a duplicate, and leave the policy they meant to use off.
  it('points at `guard enable`, and names the policies, when all are disabled', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    addPolicy(db, { name: 'no-deletes', match_pattern: { step_type: 'tool_call' }, action: 'deny' });
    for (const p of listPolicies(db)) setPolicyEnabled(db, p.id, false);

    const reason = noEnabledPolicyReason('/tmp/x/traces.db', listPolicies(db), 'check');
    expect(reason).toContain('present but disabled');
    expect(reason).toContain('no-deletes'); // name it, so the user knows what to enable
    expect(reason).toContain('guard enable');
    expect(reason).toContain('--allow-empty');
    db.close();
  });

  it('keeps the original advice when the store holds no policies at all', () => {
    // `guard enable` would be nonsense here, and `--dir` (the wrong-store
    // guess) is only worth raising when there is nothing to enable.
    const reason = noEnabledPolicyReason('/tmp/x/traces.db', [], 'check');
    expect(reason).toContain('guard add');
    expect(reason).toContain('--dir');
    expect(reason).not.toContain('present but disabled');
    expect(reason).not.toContain('guard enable');
  });

  it('addresses the hook by name, since the same dead end is reached both ways', () => {
    expect(noEnabledPolicyReason('/tmp/x/traces.db', [], 'hook')).toContain('point the hook at');
    expect(noEnabledPolicyReason('/tmp/x/traces.db', [], 'check')).toContain('point the check at');
  });

  it('summarizes rather than listing every disabled policy', () => {
    // A store with dozens of disabled policies must not print all of them into
    // a hook decision reason, which the harness shows to the model.
    const many = Array.from({ length: 9 }, (_, i) => ({ enabled: false, name: `p${i}` }));
    const reason = noEnabledPolicyReason('/tmp/x/traces.db', many, 'check');
    expect(reason).toContain('9 policies are present but disabled');
    expect(reason).toContain('+6 more');
    expect(reason).not.toContain('p8');
  });
});
