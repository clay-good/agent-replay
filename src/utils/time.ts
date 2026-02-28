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
 * Format an ISO 8601 timestamp as a relative time string.
 * Examples: "just now", "3m ago", "2h ago", "5d ago"
 */
export function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
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
  // If it looks like an ISO date, return as-is
  if (/^\d{4}-\d{2}/.test(since)) return since;
  try {
    const ms = parseDurationString(since);
    return new Date(Date.now() - ms).toISOString();
  } catch {
    return since; // Let the database handle it
  }
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
