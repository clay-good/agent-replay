import { describe, it, expect } from 'vitest';
import { parseDurationString, parseSinceToIso, formatDuration, effectiveDurationMs, formatRelativeTime } from '../src/utils/time.js';

describe('parseDurationString', () => {
  it('parses units to milliseconds', () => {
    expect(parseDurationString('1s')).toBe(1000);
    expect(parseDurationString('30m')).toBe(30 * 60_000);
    expect(parseDurationString('2h')).toBe(2 * 3_600_000);
    expect(parseDurationString('7d')).toBe(7 * 86_400_000);
    expect(parseDurationString('1.5h')).toBe(1.5 * 3_600_000);
  });

  it('throws on an unparseable duration', () => {
    expect(() => parseDurationString('notaduration')).toThrow(/Invalid duration/);
    expect(() => parseDurationString('10')).toThrow(); // missing unit
    expect(() => parseDurationString('h')).toThrow(); // missing value
  });
});

describe('parseSinceToIso', () => {
  it('resolves a relative duration to a past ISO timestamp', () => {
    const iso = parseSinceToIso('1h');
    const ms = Date.parse(iso);
    const expected = Date.now() - 3_600_000;
    expect(Math.abs(ms - expected)).toBeLessThan(5000); // ~1h ago
  });

  it('passes an ISO date through unchanged', () => {
    expect(parseSinceToIso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
  });

  it('throws on garbage instead of returning it verbatim (would corrupt the query)', () => {
    expect(() => parseSinceToIso('notaduration')).toThrow(/Invalid duration/);
  });
});

describe('formatDuration', () => {
  it('formats ms, seconds, and minutes', () => {
    expect(formatDuration(500)).toMatch(/ms/);
    expect(formatDuration(1500)).toMatch(/s/);
    expect(formatDuration(90000)).toMatch(/m/);
  });
});

describe('effectiveDurationMs', () => {
  it('prefers the recorded total when present', () => {
    expect(effectiveDurationMs({ total_duration_ms: 1234, started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:01:00Z' })).toBe(1234);
  });
  it('derives from start/end timestamps when the total is absent', () => {
    expect(effectiveDurationMs({ total_duration_ms: null, started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:12.500Z' })).toBe(12_500);
  });
  it('returns null when there is nothing to measure or the range is inverted', () => {
    expect(effectiveDurationMs({ total_duration_ms: null, started_at: '2026-01-01T00:00:00Z', ended_at: null })).toBeNull();
    expect(effectiveDurationMs({ total_duration_ms: null, started_at: '2026-01-01T00:01:00Z', ended_at: '2026-01-01T00:00:00Z' })).toBeNull();
    expect(effectiveDurationMs({})).toBeNull();
  });
});

describe('formatRelativeTime', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('bucketizes into just now / minutes / hours / days / months', () => {
    expect(formatRelativeTime(ago(10_000))).toBe('just now'); // under a minute
    expect(formatRelativeTime(ago(5 * 60_000))).toBe('5m ago');
    expect(formatRelativeTime(ago(3 * 3_600_000))).toBe('3h ago');
    expect(formatRelativeTime(ago(2 * 86_400_000))).toBe('2d ago');
    expect(formatRelativeTime(ago(45 * 86_400_000))).toBe('1mo ago');
  });

  it('handles an unparseable timestamp and a future one', () => {
    expect(formatRelativeTime('not a date')).toBe('-');
    expect(formatRelativeTime(new Date(Date.now() + 60_000).toISOString())).toBe('in the future');
  });
});
