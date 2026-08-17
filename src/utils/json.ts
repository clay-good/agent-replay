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
 * Does an unbounded quantifier (`+`, `*`, `{n,}`) start at `i`?
 *
 * A *bounded* outer quantifier (`{n}`, `{n,m}`) caps total work, and `?` means
 * 0–1 repetitions, so neither can drive catastrophic backtracking.
 */
function unboundedQuantifierAt(pattern: string, i: number): boolean {
  const c = pattern[i];
  if (c === '+' || c === '*') return true;
  if (c !== '{') return false;
  const close = pattern.indexOf('}', i);
  return close !== -1 && /^\{\d+,\}$/.test(pattern.slice(i, close + 1));
}

/**
 * Is this group body ambiguous — able to match one input in more than one way?
 * That is what makes an unbounded outer quantifier explode: the engine has
 * exponentially many ways to split the input across repetitions.
 *
 * Any quantifier inside (`a+`, `.*`, `\s*`) or any alternation (`a|aa`) creates
 * that ambiguity. Escapes and character classes are skipped, since `\+` and
 * `[+|]` are literals.
 */
function groupBodyIsAmbiguous(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '|' || c === '+' || c === '*' || c === '{') return true;
  }
  return false;
}

/**
 * Compile a regex from user input with protection against ReDoS.
 * Returns null if the pattern is invalid or could backtrack catastrophically.
 *
 * A `name_regex` is evaluated on the guardrail path, so a pattern that
 * backtracks exponentially doesn't just run slowly — it stalls the check. In a
 * harness that treats a timed-out hook as non-blocking, that DoS degrades into
 * a fail-open, which is exactly what the kill-switch exists to prevent.
 *
 * The rule: reject an unbounded quantifier applied to a group whose body is
 * ambiguous (contains a quantifier or an alternation). That covers `(a+)+`,
 * `(a|aa)+`, `(\s*\w)*` and `(.*,)*` alike — the previous check only caught a
 * quantifier appearing immediately before the closing paren, so every form
 * where the inner quantifier sat further left slipped through and hung the
 * matcher for seconds on a ~35-character input.
 *
 * This is deliberately conservative: it can reject a pattern that would have
 * been safe (`(foo|bar)+`, with disjoint branches). Rewriting a rejected
 * pattern costs the user a minute; a stalled guardrail costs them the block.
 */
export function safeRegex(pattern: string, flags = 'i'): RegExp | null {
  const groupStarts: number[] = [];
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }

    if (c === '(') {
      // Skip the group-type prefix so `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and
      // `(?<name>` aren't read as quantifiers or alternations.
      let bodyStart = i + 1;
      if (pattern[bodyStart] === '?') {
        const rest = pattern.slice(bodyStart);
        const prefix = /^\?(:|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(rest);
        bodyStart += prefix ? prefix[0].length : 1;
      }
      groupStarts.push(bodyStart);
      continue;
    }

    if (c === ')') {
      const bodyStart = groupStarts.pop();
      if (bodyStart === undefined) continue; // unbalanced; RegExp will reject it
      if (unboundedQuantifierAt(pattern, i + 1) && groupBodyIsAmbiguous(pattern.slice(bodyStart, i))) {
        return null;
      }
    }
  }

  // Prefer Unicode mode, falling back to the plain form. Without `u`, `\p{Lu}`
  // and friends degrade silently to a literal `p` — so a `name_regex` policy
  // written with a Unicode property escape validated cleanly, listed as active,
  // and then matched nothing at all: a kill-switch that can never fire. `u` also
  // rejects a few patterns that are legal without it (a stray `\-`, a lone
  // surrogate), which is why this falls back rather than switching outright.
  try {
    return new RegExp(pattern, flags.includes('u') ? flags : `${flags}u`);
  } catch {
    // fall through to the non-Unicode form
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Whether a stored `input`/`output` value has anything worth rendering.
 *
 * The guards here used to be a bare truthiness test on `output` and a
 * `Object.keys(...).length > 0` test on `input`. Both fields hold arbitrary
 * JSON — the storage layer keeps whatever the producer sent — so a step whose
 * output was `false` or `0` (a failed check, a "not found", a boolean guard
 * result) rendered with no Output line at all, indistinguishable from a step
 * that produced nothing, while `show --json` showed the value. A scalar input
 * (`42`) has no keys and vanished the same way. The two tests also disagreed
 * with each other about `{}`.
 *
 * An empty object or array is still treated as nothing to show: it carries no
 * information, and the mappers deliberately store "no content" as null rather
 * than `{}` for exactly that reason.
 */
export function hasRenderableContent(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true; // a scalar — including 0, false and '' — is real content
}
