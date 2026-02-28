import { nanoid } from 'nanoid';

/**
 * Generate a unique ID with an optional prefix.
 * Format: `prefix_nanoid12` or just `nanoid12` if no prefix.
 */
export function generateId(prefix?: string): string {
  const id = nanoid(12);
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Return the first 8 characters of an ID for compact display.
 * Strips the standard prefix (e.g. "trc_") before slicing.
 * Only strips the first `prefix_` segment.
 */
export function shortId(fullId: string): string {
  const idx = fullId.indexOf('_');
  const withoutPrefix = idx >= 0 ? fullId.slice(idx + 1) : fullId;
  return withoutPrefix.slice(0, 8);
}
