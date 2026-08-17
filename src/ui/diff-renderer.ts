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
  lines.push(heading(`  ${diff.diffs.length} difference(s) found:`));
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
  const start = Math.min(Math.max(0, i - lead), Math.max(0, text.length - (max - 3)));
  if (start === 0) return truncate(text, max);
  const body = text.slice(start);
  return `...${truncate(body, max - 3)}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
