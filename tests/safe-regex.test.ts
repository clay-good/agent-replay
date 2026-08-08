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
