import stringWidth from 'string-width';

/**
 * Truncate to a budget of terminal COLUMNS, not UTF-16 code units.
 *
 * Every budget in this directory is a width — a `colWidths` entry, or something
 * derived from `process.stdout.columns` — while the truncations measured with
 * `.length`. Those are different units: a CJK character is one code unit and
 * TWO columns, a combining mark is one and zero. So a cell built to a 40-unit
 * budget could render 80 columns wide, overflowing the column and breaking the
 * table border or the timeline gutter that makes the output readable.
 *
 * Iterating by code point also means a surrogate pair is never split, which the
 * `.length`-based copies could do — leaving a lone surrogate the terminal draws
 * as U+FFFD, and doing so only at certain widths.
 *
 * Stops as soon as the budget is spent, so a 500 KB payload costs about a
 * screenful of work rather than a pass over the whole string.
 */
export function truncateToWidth(str: string, maxCols: number): string {
  if (str.length <= maxCols && stringWidth(str) <= maxCols) return str;
  const budget = Math.max(0, maxCols - 3); // room for the ellipsis
  let out = '';
  let used = 0;
  for (const ch of str) {
    const w = stringWidth(ch);
    if (used + w > budget) return out + '...';
    out += ch;
    used += w;
  }
  return out;
}
