import { describe, it, expect } from 'vitest';
import { parseDurationString, parseSinceToIso, formatDuration, effectiveDurationMs, formatRelativeTime, formatTimestamp,
  parseInstant } from '../src/utils/time.js';
import { traceTable } from '../src/ui/table.js';

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

  it('normalizes an ISO date to a UTC instant SQLite can parse', () => {
    // Was "passes an ISO date through unchanged". Pass-through was the defect:
    // Date.parse accepts strictly more formats than SQLite's julianday, and the
    // --since comparison has a byte-compare fallback for an unparseable ROW but
    // none for an unparseable BOUND. `julianday(?)` was then NULL, so no row
    // could satisfy the window and every query returned nothing at exit 0.
    expect(parseSinceToIso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
    // The reachable case: ISO 8601 basic-format offsets, which `date +%FT%T%z`
    // emits. julianday() returns NULL for this; normalized, it works.
    expect(parseSinceToIso('2026-08-16T13:30:00+0200')).toBe('2026-08-16T11:30:00.000Z');
    // An offset with a colon means the same instant either way.
    expect(parseSinceToIso('2026-08-16T13:30:00+02:00')).toBe('2026-08-16T11:30:00.000Z');
  });

  it('throws on garbage instead of returning it verbatim (would corrupt the query)', () => {
    expect(() => parseSinceToIso('notaduration')).toThrow(/Invalid duration/);
  });

  it('rejects a date-shaped bound that is not a real date', () => {
    // Regression: the ISO branch tested only the `\d{4}-\d{2}` prefix, so
    // `2026-99` was passed through as a literal SQL bound no timestamp could
    // satisfy. Every query returned "No traces found" at exit 0 —
    // indistinguishable from an empty store — and a `check --since` gate
    // silently examined nothing.
    expect(() => parseSinceToIso('2026-99')).toThrow(/Invalid date/);
    expect(() => parseSinceToIso('2026-08-99T00:00:00Z')).toThrow(/Invalid date/);
    // A real date normalizes to the instant SQLite reads it as.
    expect(parseSinceToIso('2026-08-16')).toBe('2026-08-16T00:00:00.000Z');
  });
});

describe('formatDuration', () => {
  it('formats ms, seconds, and minutes', () => {
    expect(formatDuration(500)).toMatch(/ms/);
    expect(formatDuration(1500)).toMatch(/s/);
    expect(formatDuration(90000)).toMatch(/m/);
  });
  it('formats hours, with and without trailing minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h'); // exactly one hour, no minutes
    expect(formatDuration(3_661_000)).toBe('1h 1m'); // 1h 1m 1s → minutes shown, secs dropped
    expect(formatDuration(2 * 3_600_000 + 30 * 60_000)).toBe('2h 30m');
  });
  it('returns a dash for a non-finite or negative duration', () => {
    expect(formatDuration(NaN)).toBe('-');
    expect(formatDuration(-5)).toBe('-');
  });
});

describe('formatTimestamp', () => {
  it('returns a dash for an unparseable timestamp', () => {
    expect(formatTimestamp('not a date')).toBe('-');
  });
  it('formats a valid ISO timestamp as YYYY-MM-DD HH:MM:SS', () => {
    // Uses local-time getters, so assert the shape rather than an exact value
    // to stay deterministic across the runner's timezone.
    expect(formatTimestamp('2026-01-15T10:30:00Z')).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
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

describe('list and dashboard format the same timestamp identically', () => {
  it('uses one relative-time formatter, with month and future handling', () => {
    // `list` had a private copy that stopped at days and had no future guard, so
    // it said "45d ago" where the dashboard said "1mo ago", and a skewed future
    // timestamp read as "just now" while sorting to the top.
    const rows = traceTable([
      {
        id: 'trc_old', agent_name: 'old', agent_version: null, trigger: 'manual',
        status: 'completed', input: {}, output: null, error: null, tags: [], metadata: {},
        started_at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
        ended_at: null, total_duration_ms: null, total_tokens: null, total_cost_usd: null,
        parent_trace_id: null, forked_from_step: null, session_id: null,
        created_at: new Date().toISOString(), step_count: 0,
      },
      {
        id: 'trc_fut', agent_name: 'fut', agent_version: null, trigger: 'manual',
        status: 'completed', input: {}, output: null, error: null, tags: [], metadata: {},
        started_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        ended_at: null, total_duration_ms: null, total_tokens: null, total_cost_usd: null,
        parent_trace_id: null, forked_from_step: null, session_id: null,
        created_at: new Date().toISOString(), step_count: 0,
      },
    ] as never);

    expect(rows).toContain(formatRelativeTime(new Date(Date.now() - 45 * 86_400_000).toISOString()));
    expect(rows).toContain('1mo ago');
    expect(rows).toContain('in the future');
    expect(rows).not.toContain('45d ago');
  });
});


describe('a zone-less timestamp is read the way SQLite reads it', () => {
  // `julianday()` treats a timestamp with no designator as UTC; JavaScript's
  // `Date` treats it as LOCAL. Both forms occur in real stores, so the two
  // engines disagreed by the machine's offset on exactly those rows: one trace
  // showed "2h" in `show`/`list` under a positive offset while `stats` said
  // 5.0s for the same row, and "-" under a negative one (the end appearing to
  // precede the start). The relative time printed "in the future" for a past run.
  const zoneless = { started_at: '2026-08-18 10:00:00', ended_at: '2026-08-18T10:00:05Z' };

  it('gives the same duration whatever TZ the process runs in', () => {
    const prev = process.env.TZ;
    try {
      const seen = new Set<number | null>();
      for (const tz of ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        seen.add(effectiveDurationMs(zoneless));
      }
      expect([...seen]).toEqual([5000]);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('parses both forms to the same instant', () => {
    expect(parseInstant('2026-08-18 10:00:00')).toBe(parseInstant('2026-08-18T10:00:00Z'));
    // An explicit offset is respected, not overwritten.
    expect(parseInstant('2026-08-18T12:00:00+02:00')).toBe(parseInstant('2026-08-18T10:00:00Z'));
  });

  // Pinned to a POSITIVE offset: under UTC or a negative one the old
  // local-time reading also lands in the past, so the assertion held with the
  // bug present. Only a zone ahead of UTC exposes it.
  it('does not report a past zone-less timestamp as being in the future', () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = 'Europe/Berlin';
      const past = new Date(Date.now() - 3_600_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      expect(formatRelativeTime(past)).not.toBe('in the future');
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});
