import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import type { Trace, TraceDiffResult, StepDiff } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { statusBadge, colors, heading, separator, label } from './theme.js';

/**
 * Render a side-by-side trace diff with prominent divergence indicator.
 */
export function renderDiff(
  diff: TraceDiffResult,
  leftTrace: Trace,
  rightTrace: Trace,
  /**
   * The `--fields` allowlist, when one was applied. Without it the renderer
   * printed a flat "Traces are identical." over a comparison that had only
   * looked at part of the data — under a header showing COMPLETED beside
   * FAILED. A filter must never imply more similarity than was measured, the
   * same rule the unknown-field guard already enforces.
   */
  fields?: string[],
): string {
  const lines: string[] = [];

  // Header panel with both traces
  const headerContent = [
    `${colors.primary('LEFT')}   ${chalk.dim(diff.left_trace_id.slice(0, 12))}  ${chalk.white(leftTrace.agent_name)}  ${statusBadge(leftTrace.status as TraceStatus)}  ${chalk.dim(`${diff.left_step_count} steps`)}`,
    `${colors.secondary('RIGHT')}  ${chalk.dim(diff.right_trace_id.slice(0, 12))}  ${chalk.white(rightTrace.agent_name)}  ${statusBadge(rightTrace.status as TraceStatus)}  ${chalk.dim(`${diff.right_step_count} steps`)}`,
  ].join('\n');

  lines.push(
    boxen(headerContent, {
      title: 'Trace Diff',
      titleAlignment: 'center',
      padding: 1,
      borderColor: 'cyan',
      borderStyle: 'round',
    }),
  );

  // Divergence point
  if (diff.divergence_step != null) {
    lines.push('');
    lines.push(
      boxen(
        chalk.yellowBright.bold(`  DIVERGES AT STEP ${diff.divergence_step}  `),
        {
          padding: { left: 2, right: 2, top: 0, bottom: 0 },
          borderColor: 'yellow',
          borderStyle: 'double',
        },
      ),
    );
  } else if (diff.diffs.length === 0) {
    lines.push('');
    lines.push(
      fields && fields.length > 0
        ? chalk.greenBright.bold(`  No differences in the selected field(s): ${fields.join(', ')}.`)
        : chalk.greenBright.bold('  Traces are identical.'),
    );
    return lines.join('\n');
  }

  // Diff table
  lines.push('');
  // Same honesty as `--compact`: presence rows survive any --fields allowlist,
  // so a filtered run must not present its total as field-scoped.
  lines.push(
    heading(
      fields && fields.length > 0
        ? `  ${describeFilteredCount(diff.diffs, fields)} difference(s) found:`
        : `  ${diff.diffs.length} difference(s) found:`,
    ),
  );
  lines.push('');

  const table = new Table({
    head: [
      colors.primary('Step'),
      colors.primary('Field'),
      colors.primary('Left'),
      colors.secondary('Right'),
    ],
    style: { head: [], border: ['dim'] },
    colWidths: [8, 16, 38, 38],
    wordWrap: true,
  });

  for (const d of diff.diffs) {
    const leftVal = formatDiffValue(d.left_value, d.field, d.right_value);
    const rightVal = formatDiffValue(d.right_value, d.field, d.left_value);

    table.push([
      // A trace-level field belongs to the run, not to any step.
      chalk.white.bold(d.step_number === null ? 'trace' : String(d.step_number)),
      fieldBadge(d.field),
      leftVal,
      rightVal,
    ]);
  }

  lines.push(table.toString());

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fieldBadge(field: string): string {
  switch (field) {
    case 'missing_right':
      return chalk.red('- Left only');
    case 'missing_left':
      return chalk.green('+ Right only');
    default:
      return chalk.yellow(field);
  }
}

function formatDiffValue(val: unknown, field: string, other?: unknown): string {
  if (val === null || val === undefined) {
    return chalk.dim('(none)');
  }

  // For a step present on only one side, the empty side is already rendered as
  // "(none)" by the null guard above; this branch handles the side that has the
  // value, so show it (green) rather than blanking it too.
  if (field === 'missing_right' || field === 'missing_left') {
    return chalk.green(truncate(String(val), 34));
  }

  const text = typeof val === 'object' ? JSON.stringify(val) : String(val);
  const otherText = other == null ? '' : typeof other === 'object' ? JSON.stringify(other) : String(other);
  return chalk.white(windowed(text, otherText, 34));
}

/**
 * Truncate around the first character that differs from `other`, rather than
 * always from position 0.
 *
 * Agent payloads routinely share a long prefix (`{"file_path":"/Users/…"}`,
 * `{"messages":[{"role":"user"…}]}`), so a fixed head-truncation printed the
 * SAME 34 characters in both columns under a header reading "1 difference(s)
 * found" — the user could only find out what changed by rerunning with --json,
 * with nothing suggesting they should.
 */
function windowed(text: string, other: string, max: number): string {
  if (text.length <= max) return text;
  let i = 0;
  while (i < text.length && i < other.length && text[i] === other[i]) i++;
  // Keep some leading context, and never scroll past what fits.
  const lead = 8;
  // The leading "..." costs three of the budget, so the furthest useful start is
  // `length - (max - 3)`; clamping to `length - max` instead left the differing
  // tail cut off again, defeating the point of windowing.
  const start = safeCut(text, Math.min(Math.max(0, i - lead), Math.max(0, text.length - (max - 3))));
  if (start === 0) return truncate(text, max);
  const body = text.slice(start);
  return `...${truncate(body, max - 3)}`;
}

/**
 * Move a cut index off the low half of a surrogate pair. Slicing between the
 * halves of an astral character (an emoji in a prompt is enough) leaves a lone
 * surrogate, which renders as U+FFFD — in BOTH columns, so the mojibake looked
 * like the difference.
 */
function safeCut(s: string, index: number): number {
  const code = s.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, safeCut(s, max - 3)) + '...';
}

/**
 * "3 in model, 5 step presence" — a count the label can stand behind.
 *
 * Presence rows (a step existing on one side only) survive any `--fields`
 * allowlist, because they are not field differences. Folding them into a total
 * labelled "in <fields> only" claimed a scope the number did not have: on a fork
 * pair, `--fields model` reported "8 (in model only)" when none of the eight was
 * a model difference.
 */
export function describeFilteredCount(diffs: { field: string }[], fields: string[]): string {
  const presence = diffs.filter((d) => d.field === 'missing_left' || d.field === 'missing_right').length;
  const inFields = diffs.length - presence;
  if (presence === 0) return `${inFields} (in ${fields.join(', ')})`;
  if (inFields === 0) return `${presence} (step presence only; none in ${fields.join(', ')})`;
  return `${inFields} in ${fields.join(', ')}, ${presence} step presence`;
}
