/**
 * Safely parse a JSON string, returning a default value on failure.
 */
export function safeJsonParse<T = unknown>(text: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse a JSON string, returning the raw string on failure (useful for row conversion).
 */
export function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Truncate a string to a maximum length, appending '...' if truncated.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/**
 * Pretty-print a value as indented JSON.
 * Safe against circular references.
 */
export function prettyJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

/**
 * Truncate a JSON string or value to a maximum length with an ellipsis indicator.
 * If given an object, it is stringified first. Safe against circular references.
 */
export function truncateJson(value: unknown, maxLength = 200): string {
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  } catch {
    str = String(value);
  }
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Safely extract a message from an unknown error value.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Parse an integer with a fallback for NaN.
 */
export function safeParseInt(str: string | undefined, fallback: number): number {
  if (str == null) return fallback;
  const val = parseInt(str, 10);
  return isNaN(val) ? fallback : val;
}

/**
 * Parse a float with a fallback for NaN.
 */
export function safeParseFloat(str: string | undefined, fallback: number): number {
  if (str == null) return fallback;
  const val = parseFloat(str);
  return isNaN(val) ? fallback : val;
}

/**
 * Compile a regex from user input with protection against ReDoS.
 * Returns null if the pattern is invalid or contains dangerous constructs.
 *
 * Rejects patterns with nested quantifiers (e.g. `(a+)+`, `(a*)*`, `(a{2,})+`)
 * which are the most common cause of catastrophic backtracking.
 */
export function safeRegex(pattern: string, flags = 'i'): RegExp | null {
  // Reject nested quantifiers: a quantifier immediately after a group that
  // itself contains a quantifier. Matches patterns like (x+)+, (x*)+, (x{n})*
  if (/([+*?]|\{\d+,?\d*\})\s*\)\s*([+*?]|\{\d+,?\d*\})/.test(pattern)) {
    return null;
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
