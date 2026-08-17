import { describe, it, expect } from 'vitest';
import { safeRegex } from '../src/utils/json.js';

/**
 * safeRegex backs guard `name_regex` matching. Its two safety properties —
 * catching invalid patterns and rejecting nested quantifiers that can cause
 * catastrophic backtracking (ReDoS) — must not regress, or a policy's regex
 * could crash or hang enforcement.
 */
describe('safeRegex', () => {
  it('compiles a normal pattern, case-insensitive by default', () => {
    const re = safeRegex('^delete_');
    expect(re).not.toBeNull();
    expect(re!.test('DELETE_user')).toBe(true); // the default 'i' flag
    expect(re!.test('read_user')).toBe(false);
  });

  it('allows single quantifiers and ordinary grouping/alternation', () => {
    expect(safeRegex('(delete|drop|truncate)_[a-z]+')).not.toBeNull();
  });

  it('returns null for an invalid pattern instead of throwing', () => {
    expect(safeRegex('(')).toBeNull();
    expect(safeRegex('[a-')).toBeNull();
  });

  it('rejects nested-quantifier patterns (catastrophic-backtracking guard)', () => {
    expect(safeRegex('(a+)+')).toBeNull();
    expect(safeRegex('(a*)*')).toBeNull();
    expect(safeRegex('(a{1,3})+')).toBeNull();
    expect(safeRegex('(a+){2,}')).toBeNull();
  });

  it('accepts a bounded outer quantifier (fixed/ranged repetition is not ReDoS)', () => {
    // A *bounded* outer quantifier caps total work, so these are safe and must
    // compile — even though the inner group is itself quantified. `(\d{3}){2}`
    // is the natural way to write "exactly six digits as two groups".
    for (const p of ['(\\d{3}){2}', '(\\w{4}){3}', '(a{2}){3}', '(ab+){2}']) {
      const re = safeRegex(p);
      expect(re, `expected ${p} to be accepted`).not.toBeNull();
    }
    expect(safeRegex('(\\d{3}){2}')!.test('123456')).toBe(true);
    expect(safeRegex('(\\d{3}){2}')!.test('12345')).toBe(false);
  });

  it('accepts an optional quantified group (a trailing `?` is not ReDoS)', () => {
    // `?` makes the group 0–1 repetitions, which cannot backtrack
    // catastrophically — these are ordinary, safe patterns and must compile.
    for (const p of ['read(_\\w+)?', '(\\d+)?', '(a+)?', '(ab*)?']) {
      const re = safeRegex(p);
      expect(re, `expected ${p} to be accepted`).not.toBeNull();
    }
    expect(safeRegex('read(_\\w+)?')!.test('read_user')).toBe(true);
    expect(safeRegex('read(_\\w+)?')!.test('read')).toBe(true);
  });
});

/**
 * A `name_regex` runs on the guardrail path, so a pattern that backtracks
 * exponentially doesn't merely run slowly — it stalls the check. In a harness
 * that treats a timed-out hook as non-blocking, that DoS degrades into a
 * fail-open, exactly what the kill-switch exists to prevent.
 *
 * The old check only caught a quantifier appearing immediately before the
 * closing paren, so every form with the inner quantifier further left — or with
 * an ambiguous alternation instead of a quantifier — slipped through and hung
 * the matcher for seconds on a ~35-character input.
 */
describe('safeRegex catastrophic-backtracking rejection', () => {
  const dangerous = [
    '(a+)+',
    '(a*)*',
    '(a{2,})+',
    '(x+){2,}',
    '^(a|aa)+$',      // ambiguous alternation, no inner quantifier at all
    '(\\s*\\w)*$',    // inner quantifier not adjacent to the paren
    '^(.*,)*$',
  ];
  for (const pattern of dangerous) {
    it(`rejects ${pattern}`, () => {
      expect(safeRegex(pattern)).toBeNull();
    });
  }

  const safe = [
    '(\\d{3}){2}',    // bounded outer quantifier caps the work
    '(a+){2}',
    '(a+)?',          // 0-1 repetitions
    '(abc)+',         // unambiguous body
    '(?:abc)+',
    '^(get|list)_x$', // alternation with no unbounded outer quantifier
    '^delete_.*',
    'rm\\s+-rf',
    '[a|+*]+',        // those characters are literals inside a class
    '\\(a\\+\\)\\+',  // and escaped outside one
  ];
  for (const pattern of safe) {
    it(`still accepts ${pattern}`, () => {
      expect(safeRegex(pattern)).not.toBeNull();
    });
  }

  it('keeps a rejected pattern from stalling the matcher', () => {
    // Before: ~11s for a 37-char input. Now the pattern never compiles.
    expect(safeRegex('^(a|aa)+$')).toBeNull();
  });
});

describe('safeRegex — Unicode property escapes', () => {
  it('compiles a pattern that only works in Unicode mode', () => {
    // Without the `u` flag `\p{Lu}` degrades to a literal `p`, so a guardrail
    // written with a Unicode property escape validated cleanly, listed as an
    // active deny, and then matched nothing at all.
    const re = safeRegex('^\\p{Script=Han}+$');
    expect(re).not.toBeNull();
    expect(re!.test('秘密鍵')).toBe(true);
    expect(re!.test('secret')).toBe(false);
  });

  it('still accepts a pattern that is only legal without `u`', () => {
    // `\-` outside a class is an invalid escape in Unicode mode; falling back
    // keeps every pattern that used to compile.
    const re = safeRegex('a\\-b');
    expect(re).not.toBeNull();
    expect(re!.test('a-b')).toBe(true);
  });
});
