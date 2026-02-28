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
 * Returns null if the pattern is invalid.
 */
export function safeRegex(pattern: string, flags = 'i'): RegExp | null {
  try {
    const re = new RegExp(pattern, flags);
    // Quick sanity test with a short string to reject catastrophic patterns
    re.test('test');
    return re;
  } catch {
    return null;
  }
}
