import { describe, it, expect } from 'vitest';
import { generateId, shortId } from '../src/utils/id.js';

describe('generateId', () => {
  it('produces a 12-char id with no prefix', () => {
    const id = generateId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
  it('prefixes the id with "prefix_" when given a prefix', () => {
    expect(generateId('trc')).toMatch(/^trc_[A-Za-z0-9_-]{12}$/);
  });
  it('generates distinct ids', () => {
    expect(generateId()).not.toBe(generateId());
  });
});

describe('shortId', () => {
  it('strips the first prefix segment and returns the next 8 characters', () => {
    expect(shortId('trc_abcdefghij')).toBe('abcdefgh');
  });
  it('only strips the first underscore-delimited prefix', () => {
    // The nanoid alphabet includes '_', so only the leading prefix is removed;
    // the remaining underscore stays and counts toward the 8 chars.
    expect(shortId('trc_ab_cdefghij')).toBe('ab_cdefg');
  });
  it('slices from the start when there is no prefix', () => {
    expect(shortId('abcdefghijkl')).toBe('abcdefgh');
  });
  it('returns the whole (short) id when under 8 characters', () => {
    expect(shortId('trc_xyz')).toBe('xyz');
  });
});
