/**
 * SQL predicate for a `--since` lower bound on `started_at`, shared by every
 * command that windows by time (`list`, `stats`, `export`, `check`).
 *
 * `started_at` is TEXT, so a plain `started_at >= ?` compares BYTES, not
 * instants. Nothing constrains the format a producer writes — `ingest`,
 * `record` and both importers pass a timestamp through verbatim — so real
 * stores mix forms, and the byte order is not the time order:
 *
 *   - `2026-08-16T14:00:00+02:00` is 12:00Z, an hour BEFORE a 13:00Z cutoff,
 *     but sorts above it and was wrongly included.
 *   - `2026-08-16 13:30:00` (SQLite's own `datetime()` form) sorts below every
 *     `T`-separated timestamp, so it was excluded from EVERY window.
 *
 * A CI gate reading `check --since 1d` therefore skipped traces it should have
 * checked. `julianday()` parses offsets, `Z`, and the space form correctly.
 *
 * It does NOT parse an ISO-8601 *basic*-format offset (`+0200`) — the form
 * `date +%FT%T%z` emits and `ingest` stores verbatim — and returning NULL for
 * those rows dropped them straight back onto the byte comparison this predicate
 * exists to replace, off by the whole UTC offset in both directions: a
 * `+0200` row an hour BEFORE the cutoff was included, and a `-0200` row after
 * it was excluded. `parseSinceToIso` already normalizes that format on the
 * BOUND side; the ROW side is handled below by retrying the basic form as the
 * extended one, the same repair {@link julianDayExpr} makes.
 *
 * The structure matters as much as the arithmetic. The first disjunct stays a
 * bare `julianday(started_at)` so it still matches schema v4's expression index
 * exactly; the repair is confined to the branch that only runs when that
 * returned NULL. A timestamp neither form can parse still falls back to the
 * byte comparison, so this can never drop a row it used to return.
 *
 * Takes the bound THREE times — see `sinceParams`.
 */
export const SINCE_PREDICATE = `(julianday(started_at) >= julianday(?) OR (
  julianday(started_at) IS NULL AND CASE
    WHEN ${'julianday(BASIC_OFFSET_RETRY)'} IS NOT NULL
      THEN ${'julianday(BASIC_OFFSET_RETRY)'} >= julianday(?)
    ELSE started_at >= ?
  END))`.replace(
  /BASIC_OFFSET_RETRY/g,
  "substr(started_at, 1, length(started_at) - 2) || ':' || substr(started_at, -2)",
);

/** Bind values for {@link SINCE_PREDICATE}, which references the bound three times. */
export function sinceParams(since: string): [string, string, string] {
  return [since, since, since];
}

/**
 * SQL that parses a TEXT timestamp column to a Julian day, retrying an ISO-8601
 * *basic*-format offset as the extended form SQLite requires.
 *
 * `julianday()` handles `Z`, `+02:00` and SQLite's own space form, but returns
 * NULL for `+0200` — which is exactly what `date +%FT%T%z` emits in a shell
 * script and what `ingest` then stores verbatim. A NULL made the duration
 * fallback below yield NULL, so `AVG` silently skipped the trace: `stats`
 * reported an average over a SUBSET while counting every trace in `overall`, and
 * printed "Avg duration: -" for a store whose every row `list` showed a duration
 * for. Inserting the missing colon recovers those rows; a timestamp julianday
 * cannot parse at all still yields NULL, as before.
 *
 * Safe to use in an `ORDER BY` on `started_at`: schema v5 indexes exactly this
 * expression, for exactly that purpose. (It was not always — v4 indexed the
 * bare `julianday(started_at)`, so wrapping the column made every ordered query
 * full-scan, and the ordering was left wrong for basic-offset rows instead.)
 *
 * Still NOT for the indexed disjunct of `SINCE_PREDICATE`, which matches the v4
 * index and repairs the format in its fallback branch instead — see there.
 */
export function julianDayExpr(col: string): string {
  return `COALESCE(
    julianday(${col}),
    julianday(substr(${col}, 1, length(${col}) - 2) || ':' || substr(${col}, -2))
  )`;
}

/**
 * SQL for a trace's effective duration in ms — the TS twin of
 * {@link effectiveDurationMs}. Falls back to `ended_at - started_at` when the
 * producer reported no explicit total (the hook finalizer sets only `ended_at`).
 * NULL when neither is usable, so `AVG`/`SUM` skip the trace as before.
 */
export const DURATION_MS_EXPR = `COALESCE(
  total_duration_ms,
  CASE WHEN ended_at IS NOT NULL
            AND ${julianDayExpr('ended_at')} >= ${julianDayExpr('started_at')}
       THEN (${julianDayExpr('ended_at')} - ${julianDayExpr('started_at')}) * 86400000.0 END
)`;

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "120ms", "3.2s", "1m 5s", "2h 30m"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

/**
 * The trace's measured duration in ms, or one derived from its start/end
 * timestamps when the explicit total wasn't recorded (e.g. an ingested trace
 * that carries timestamps but no total_duration_ms). Display-only — it never
 * changes stored data. Returns null when nothing usable is available.
 */
/**
 * A stored timestamp as an instant, read the way SQLite reads it.
 *
 * `julianday()` treats a timestamp with no timezone designator as UTC;
 * JavaScript's `Date` treats it as LOCAL. Both forms occur in real stores (see
 * SINCE_PREDICATE above — nothing constrains what a producer writes), so the
 * two engines disagreed by the machine's UTC offset on exactly those rows:
 * one trace with `started_at = "2026-08-18 10:00:00"` and `ended_at =
 * "2026-08-18T10:00:05Z"` showed a duration of "2h" in `show` and `list` under
 * TZ=Europe/Berlin while `stats` reported 5.0s for the same row, and "-" under
 * a negative offset (where the end appears to precede the start). The relative
 * time went the same way, printing "in the future" for a past run.
 *
 * So: append `Z` when no designator is present, matching the SQL side. A
 * timestamp that already carries `Z` or an offset is untouched.
 */
export function parseInstant(value: string): number {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const normalized = hasZone ? value.trim() : `${value.trim().replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

export function effectiveDurationMs(t: {
  total_duration_ms?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
}): number | null {
  if (t.total_duration_ms != null) return t.total_duration_ms;
  if (t.started_at && t.ended_at) {
    const start = parseInstant(t.started_at);
    const end = parseInstant(t.ended_at);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) return end - start;
  }
  return null;
}

/**
 * Format an ISO 8601 timestamp as a relative time string.
 * Examples: "just now", "3m ago", "2h ago", "5d ago"
 */
export function formatRelativeTime(iso: string): string {
  const ts = parseInstant(iso);
  if (isNaN(ts)) return '-';
  const diff = Date.now() - ts;
  if (diff < 0) return 'in the future';
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: "30s", "5m", "2h", "7d", "1w"
 */
export function parseDurationString(str: string): number {
  const match = str.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) throw new Error(`Invalid duration string: "${str}"`);
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return value * multipliers[unit];
}

/**
 * Convert a relative duration string (e.g. "7d", "2h") or ISO string into
 * an ISO 8601 timestamp representing that far in the past from now.
 * Returns the original string if it looks like an ISO date already.
 */
export function parseSinceToIso(since: string): string {
  // An ISO date is used as-is — but only if it is actually a date. The prefix
  // test alone accepted `2026-99`, which then became a literal SQL bound no
  // timestamp could satisfy: every query returned "No traces found" at exit 0,
  // indistinguishable from an empty store, and a `check --since` gate quietly
  // examined nothing at all.
  if (/^\d{4}-\d{2}/.test(since)) {
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid date: "${since}". Use an ISO timestamp (2026-08-16, 2026-08-16T13:00:00Z) or a duration (30m, 2h, 7d).`);
    }
    // NORMALIZE, don't pass through. `Date.parse` accepts strictly more formats
    // than SQLite's `julianday`, and the comparison has a byte-compare fallback
    // for an unparseable ROW but none for an unparseable BOUND — `julianday(?)`
    // is then NULL, so no row can satisfy the window and every query returns
    // nothing at exit 0. ISO 8601 basic-format offsets are the reachable case:
    // `+0200`, which is exactly what `date +%FT%T%z` emits in a shell script.
    // Normalizing to a UTC instant also settles the zone-less forms, which JS
    // reads as local time and SQLite as UTC; local is what a user typing a bare
    // timestamp means, and the stored timestamps are UTC.
    return new Date(parsed).toISOString();
  }
  // Otherwise it must be a duration (1h, 7d, 30m, …). parseDurationString throws
  // on anything unparseable — surface that rather than passing garbage to the DB,
  // which would silently produce wrong results.
  const ms = parseDurationString(since);
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Format an ISO 8601 timestamp for display.
 * Returns "YYYY-MM-DD HH:MM:SS" in local time.
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
