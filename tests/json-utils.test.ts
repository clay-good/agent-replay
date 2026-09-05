import { describe, it, expect } from 'vitest';
import {
  safeJsonParse,
  safeParseJson,
  truncate,
  prettyJson,
  truncateJson,
  errorMessage,
  safeParseInt,
  safeParseFloat,
} from '../src/utils/json.js';

/**
 * Direct contract tests for the pure helpers in utils/json.ts. They are used
 * across the CLI (mostly from the command layer, which the integration suite
 * exercises out of process), so these lock their behavior in-process — most
 * importantly the lenient parseInt/parseFloat semantics that callers of the
 * numeric flags must account for (see the --limit/--port/--refresh fix).
 */

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  it('returns null by default on invalid JSON', () => {
    expect(safeJsonParse('{not json')).toBeNull();
  });
  it('returns the provided fallback on invalid JSON', () => {
    expect(safeJsonParse('nope', { ok: false })).toEqual({ ok: false });
  });
});

describe('safeParseJson', () => {
  it('returns null for null/empty input', () => {
    expect(safeParseJson(null)).toBeNull();
    expect(safeParseJson('')).toBeNull();
  });
  it('parses valid JSON', () => {
    expect(safeParseJson('[1,2]')).toEqual([1, 2]);
  });
  it('returns the raw string when it is not JSON (row-conversion fallback)', () => {
    expect(safeParseJson('just text')).toBe('just text');
  });
});

describe('truncate', () => {
  it('leaves a string at or under the limit unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hi', 5)).toBe('hi');
  });
  it('cuts an over-length string to exactly max characters including the ellipsis', () => {
    const out = truncate('abcdefghij', 8);
    expect(out).toBe('abcde...');
    expect(out).toHaveLength(8);
  });
});

describe('prettyJson', () => {
  it('indents a value', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it('falls back to String() on a circular reference instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toBe('[object Object]');
  });
});

describe('truncateJson', () => {
  it('passes a short string through unchanged', () => {
    expect(truncateJson('short', 200)).toBe('short');
  });
  it('stringifies an object', () => {
    expect(truncateJson({ a: 1 }, 200)).toBe('{"a":1}');
  });
  it('truncates an over-length value with an ellipsis', () => {
    const out = truncateJson('x'.repeat(50), 10);
    expect(out).toBe('xxxxxxx...');
    expect(out).toHaveLength(10);
  });
  it('falls back to String() on a circular reference', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncateJson(circular)).toBe('[object Object]');
  });
});

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });
  it('stringifies a non-Error value', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});

describe('safeParseInt', () => {
  it('returns the fallback for undefined', () => {
    expect(safeParseInt(undefined, 25)).toBe(25);
  });
  it('parses a plain integer', () => {
    expect(safeParseInt('42', 0)).toBe(42);
  });
  it('returns the fallback when nothing numeric is present', () => {
    expect(safeParseInt('abc', 7)).toBe(7);
  });
  it('is lenient like parseInt: it takes a leading integer and ignores the rest', () => {
    // This is precisely why the numeric-flag commands validate with Number()
    // and NOT with this helper: parseInt disagrees with Number on these.
    expect(safeParseInt('12abc', 0)).toBe(12);
    expect(safeParseInt('1e2', 0)).toBe(1); // parseInt stops at 'e' (Number → 100)
    expect(safeParseInt('0x20', 0)).toBe(0); // parseInt base 10 stops at 'x' (Number → 32)
  });
});

describe('safeParseFloat', () => {
  it('returns the fallback for undefined', () => {
    expect(safeParseFloat(undefined, 5)).toBe(5);
  });
  it('parses a float', () => {
    expect(safeParseFloat('2.5', 0)).toBe(2.5);
  });
  it('returns the fallback for a non-numeric string', () => {
    expect(safeParseFloat('nope', 1.5)).toBe(1.5);
  });
  it('accepts scientific notation (unlike safeParseInt)', () => {
    expect(safeParseFloat('1e2', 0)).toBe(100);
  });
});


describe('truncate never splits a surrogate pair', () => {
  // A plain `slice` can land between the halves of an astral character, leaving
  // a lone surrogate the terminal renders as U+FFFD. Whether that happened
  // depended on the exact cut offset — so the same emoji rendered fine at one
  // terminal width and as mojibake at the next. The windowing helper already
  // had a surrogate-safe cut; `truncate`, which many more call sites use, did
  // not.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('leaves no lone surrogate at any cut point', () => {
    // Sweep every offset in a window, so the pair is straddled at some of them.
    const s = 'a'.repeat(8) + '😀'.repeat(30);
    for (let max = 4; max <= 40; max++) {
      const out = truncate(s, max);
      expect(LONE_SURROGATE.test(out), `max=${max} produced ${JSON.stringify(out)}`).toBe(false);
    }
  });

  it('still truncates, and still marks that it did', () => {
    expect(truncate('😀'.repeat(30), 10)).toMatch(/\.\.\.$/);
    // At most one UTF-16 unit over `max`: when the cut would land inside a
    // pair, the whole pair is kept rather than half of it dropped. Keeping the
    // character is the right trade against a bound that is already approximate
    // (a `length` bound is not a display-width bound either way).
    expect(truncate('😀'.repeat(30), 10).length).toBeLessThanOrEqual(11);
  });

  it('leaves a string that fits completely alone', () => {
    expect(truncate('😀ok', 50)).toBe('😀ok');
  });
});

describe('truncateJson never splits a surrogate pair either', () => {
  // `truncate` was made surrogate-safe; its twin was left on a bare `slice`.
  // The gap mattered more, not less: `truncateJson` output is what
  // trace-summarizer puts into the evaluator prompt, where a lone surrogate is
  // not valid UTF-8 and reaches the provider as U+FFFD.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('leaves no lone surrogate at any cut point', () => {
    const s = 'a'.repeat(8) + '😀'.repeat(30);
    for (let max = 4; max <= 40; max++) {
      const out = truncateJson(s, max);
      expect(LONE_SURROGATE.test(out), `max=${max} produced ${JSON.stringify(out)}`).toBe(false);
    }
  });

  it('still truncates, and still marks that it did', () => {
    const out = truncateJson('😀'.repeat(30), 10);
    expect(out).toMatch(/\.\.\.$/);
    expect(out.length).toBeLessThanOrEqual(11);
  });
});
