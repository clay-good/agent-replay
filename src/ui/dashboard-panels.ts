/**
 * Panel bodies for the dashboard, as pure string functions.
 *
 * These replace the `blessed-contrib` bar and line widgets. That package was the
 * only source of both advisories a consumer install used to carry — its `map`
 * widget pulls `map-canvas` → a vulnerable `xml2js`, and its `markdown` widget
 * pulls `marked-terminal` → a vulnerable `lodash`, neither of which this
 * dashboard ever used. A published package cannot pin its own transitive
 * dependencies (`overrides` apply only to the root project), so the only real
 * fix was to stop depending on it.
 *
 * Keeping the bodies pure also makes the dashboard testable for the first time:
 * the view is now placement, and everything with logic in it is checked below.
 */

/** Block glyphs, lightest to fullest, for the sparkline. */
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Horizontal bars, one per status, scaled to the widest count.
 *
 * Horizontal rather than the vertical bars `contrib.bar` drew: status names are
 * words, and a horizontal bar can label each row without truncating them to the
 * column width.
 */
export function renderStatusBars(
  counts: { titles: string[]; data: number[] },
  width = 40,
): string {
  const titles = counts.titles ?? [];
  const data = counts.data ?? [];
  if (titles.length === 0) return '{gray-fg}(no traces yet){/gray-fg}';

  const labelWidth = Math.max(...titles.map((t) => t.length));
  // Leave room for the label, a space, and the count.
  const barRoom = Math.max(1, width - labelWidth - String(Math.max(...data, 0)).length - 3);
  const max = Math.max(...data, 1);

  return titles
    .map((title, i) => {
      const value = data[i] ?? 0;
      // A non-zero count always shows at least one cell, so a status that is
      // present never renders as an empty row indistinguishable from absent.
      const filled = value > 0 ? Math.max(1, Math.round((value / max) * barRoom)) : 0;
      return `${title.padEnd(labelWidth)} {cyan-fg}${'█'.repeat(filled)}{/cyan-fg} ${value}`;
    })
    .join('\n');
}

/**
 * A sparkline over the given points, with the range labelled.
 *
 * Values are percentages (0-100). An empty series says so rather than drawing a
 * flat line at zero, which reads as "every eval scored 0".
 */
export function renderScoreSparkline(
  points: { label: string; value: number }[],
  width = 40,
): string {
  if (points.length === 0) return '{gray-fg}(no evaluations yet){/gray-fg}';

  // Keep the most recent points that fit; the series is oldest-first, so this
  // drops the oldest and time still reads left to right.
  const shown = points.slice(-Math.max(1, width));
  const values = shown.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const line = values
    .map((v) => {
      // A flat series sits in the middle rather than at the floor: with span 0
      // every point is both the min and the max, and drawing them all at ▁ would
      // suggest a collapse to zero.
      const idx = span === 0 ? Math.floor(SPARK.length / 2) : Math.round(((v - min) / span) * (SPARK.length - 1));
      return SPARK[idx];
    })
    .join('');

  const first = shown[0].label;
  const last = shown[shown.length - 1].label;
  return [
    `{cyan-fg}${line}{/cyan-fg}`,
    '',
    `{gray-fg}${first} → ${last}{/gray-fg}`,
    `{cyan-fg}min{/cyan-fg} ${min}%   {cyan-fg}max{/cyan-fg} ${max}%   {cyan-fg}last{/cyan-fg} ${values[values.length - 1]}%`,
  ].join('\n');
}
