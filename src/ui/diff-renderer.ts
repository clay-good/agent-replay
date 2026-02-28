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
    lines.push(chalk.greenBright.bold('  Traces are identical.'));
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
    const leftVal = formatDiffValue(d.left_value, d.field);
    const rightVal = formatDiffValue(d.right_value, d.field);

    table.push([
      chalk.white.bold(String(d.step_number)),
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
      return chalk.red('+ Left only');
    case 'missing_left':
      return chalk.green('+ Right only');
    default:
      return chalk.yellow(field);
  }
}

function formatDiffValue(val: unknown, field: string): string {
  if (val === null || val === undefined) {
    return chalk.dim('(none)');
  }

  if (field === 'missing_right') {
    return chalk.green(truncate(String(val), 34));
  }
  if (field === 'missing_left') {
    return chalk.dim('(none)');
  }

  if (typeof val === 'object') {
    return chalk.white(truncate(JSON.stringify(val), 34));
  }

  return chalk.white(truncate(String(val), 34));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
