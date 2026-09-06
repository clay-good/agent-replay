import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import type { Trace, TraceDiffResult, StepDiff } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { windowedAround } from '../utils/json.js';
import { statusBadge, colors, heading, separator, label, safeText } from './theme.js';
import { truncateToWidth } from './width.js';

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
   * same rule the unknown-field guard already enforces. The unfiltered branch
   * below now follows it too: a full comparison still leaves the state
   * snapshots out, so it names what it looked at rather than claiming
   * identity.
   */
  fields?: string[],
): string {
  const lines: string[] = [];

  // Header panel with both traces
  const headerContent = [
    `${colors.primary('LEFT')}   ${chalk.dim(safeText(diff.left_trace_id.slice(0, 12)))}  ${chalk.white(safeText(leftTrace.agent_name))}  ${statusBadge(leftTrace.status as TraceStatus)}  ${chalk.dim(`${diff.left_step_count} steps`)}`,
    `${colors.secondary('RIGHT')}  ${chalk.dim(safeText(diff.right_trace_id.slice(0, 12)))}  ${chalk.white(safeText(rightTrace.agent_name))}  ${statusBadge(rightTrace.status as TraceStatus)}  ${chalk.dim(`${diff.right_step_count} steps`)}`,
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
    if (fields && fields.length > 0) {
      lines.push(chalk.greenBright.bold(`  No differences in the selected field(s): ${fields.join(', ')}.`));
    } else {
      // "Identical" is a claim about the whole trace, and this comparison is
      // not that: it looks at step type, name, input, output, model, error and
      // decision, plus the trace's input, status and error — and at nothing
      // else the store holds. Two traces whose STATE SNAPSHOTS differ (one
      // system prompt against another, which is the difference a reader most
      // often opens `diff` to find) were reported as identical.
      //
      // The filtered branch above already says what it measured, with the rule
      // written beside it: "a filter must never imply more similarity than was
      // measured". The unfiltered branch is that rule's neighbour, and it was
      // making the larger version of the same claim.
      lines.push(chalk.greenBright.bold('  No differences in the compared fields.'));
      lines.push(
        chalk.dim('  Steps (type, name, input, output, model, error, decision) and the trace\'s input, status and error.'),
      );
      lines.push(chalk.dim('  State snapshots are not compared — see "agent-replay show <id> --snapshots".'));
    }
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
    return chalk.green(safeText(truncateToWidth(String(val), 34)));
  }

  // Escaped like every other render path: a step name or error reaches this
  // panel as a bare string (an object is JSON-stringified, which escapes its
  // own controls), and boxen computes its border width from what it is given.
  const plain = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  let text = plain(val);
  let otherText = other == null ? '' : plain(other);

  // If the two sides render to the SAME text, show their JSON form instead.
  //
  // `String(v)` collapses the very type distinction the comparison just used to
  // decide these traces differ: a step output of the string "42" and one of the
  // number 42 both print `42`, so the table showed two identical cells under a
  // header reading "1 difference(s) found" — and only `--json` revealed what
  // changed. That is exactly the failure `windowedAround` below was written to
  // end, arriving by a different route. The JSON form quotes a string and does
  // not quote a number, so the difference becomes visible; it is used ONLY when
  // the plain form is ambiguous, so ordinary values are not littered with
  // quotes. (`true` vs `"true"`, and a number-shaped string, are the reachable
  // cases; the storage layer keeps that distinction, so `diff` should show it.)
  if (other != null && text === otherText && !Object.is(val, other)) {
    text = JSON.stringify(val) ?? text;
    otherText = JSON.stringify(other) ?? otherText;
  }

  return chalk.white(safeText(windowedAround(text, otherText, 34)));
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
