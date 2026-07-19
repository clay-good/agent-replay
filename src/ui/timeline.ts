import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { stepIcon, stepLabel, colors, label, separator } from './theme.js';

export interface TimelineOptions {
  showInput?: boolean;
  showOutput?: boolean;
  showSnapshots?: boolean;
  highlightStep?: number;
  maxWidth?: number;
}

/**
 * Render a vertical step timeline with Unicode box-drawing lines.
 *
 *   ┌─ 1  🤖 LLM Call  "generate_response"                800ms
 *   │      Input: {"messages":[...]}
 *   │      Output: {"text":"hello"}
 *   ├─ 2  🔧 Tool Call  "search_db"                        120ms
 *   │      ...
 *   └─ 3  ➡ Output  "final_answer"                         50ms
 */
export function renderTimeline(
  steps: TraceStep[],
  options: TimelineOptions = {},
): string {
  const {
    showInput = true,
    showOutput = true,
    highlightStep,
    maxWidth = process.stdout.columns || 100,
  } = options;

  if (steps.length === 0) {
    return chalk.dim('  No steps recorded.');
  }

  const lines: string[] = [];
  const contentWidth = Math.max(20, Math.min(maxWidth, 120) - 10); // leave room for prefix, floor at 20

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isFirst = i === 0;
    const isLast = i === steps.length - 1;
    const isHighlighted = highlightStep != null && step.step_number === highlightStep;
    const isError = step.step_type === 'error';

    // Connector characters
    const connector = isFirst ? '\u250C' : isLast ? '\u2514' : '\u251C'; // ┌ └ ├
    const pipe = isLast ? ' ' : '\u2502'; // │

    // Step number + icon + type label + name + duration
    const num = chalk.dim(String(step.step_number).padStart(2));
    const icon = stepIcon(step.step_type as StepType);
    const typeLabel = stepLabel(step.step_type as StepType);
    const name = chalk.white.bold(`"${step.name}"`);
    const dur = step.duration_ms != null
      ? chalk.dim(formatDuration(step.duration_ms))
      : '';

    // Build the header line
    let headerLine = `  ${chalk.dim(connector)}\u2500 ${num}  ${icon} ${typeLabel}  ${name}`;
    if (dur) headerLine += `  ${dur}`;

    // Highlight or error styling
    if (isError) {
      headerLine = chalk.redBright(stripAnsi(headerLine));
    } else if (isHighlighted) {
      headerLine = chalk.bgYellow.black(stripAnsi(headerLine));
    }

    lines.push(headerLine);

    // Model info for llm_call steps
    if (step.model) {
      lines.push(`  ${chalk.dim(pipe)}      ${label('Model:')} ${chalk.white(step.model)}`);
    }

    // Input
    if (showInput && step.input && Object.keys(step.input).length > 0) {
      const inputStr = truncateJson(step.input, contentWidth);
      lines.push(`  ${chalk.dim(pipe)}      ${label('Input:')} ${chalk.dim(inputStr)}`);
    }

    // Output
    if (showOutput && step.output) {
      const outputStr = truncateJson(step.output, contentWidth);
      lines.push(`  ${chalk.dim(pipe)}      ${label('Output:')} ${chalk.dim(outputStr)}`);
    }

    // Error
    if (step.error) {
      lines.push(`  ${chalk.dim(pipe)}      ${chalk.redBright('Error:')} ${chalk.red(step.error)}`);
    }

    // Token usage
    if (step.tokens_used != null) {
      lines.push(
        `  ${chalk.dim(pipe)}      ${label('Tokens:')} ${chalk.white(step.tokens_used.toLocaleString())}`,
      );
    }

    // Blank line between steps (except after last)
    if (!isLast) {
      lines.push(`  ${chalk.dim(pipe)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render steps as a hierarchy, nesting children under their `parent_step`
 * and annotating causal links. Falls back to the flat timeline when no step
 * declares a parent.
 */
export function renderTree(steps: TraceStep[], options: TimelineOptions = {}): string {
  if (steps.length === 0) {
    return chalk.dim('  No steps recorded.');
  }

  const hasHierarchy = steps.some((s) => s.parent_step_number != null);
  if (!hasHierarchy) {
    return renderTimeline(steps, options);
  }

  // Build parent → children index by step number.
  const byNumber = new Map<number, TraceStep>();
  for (const s of steps) byNumber.set(s.step_number, s);

  const childrenOf = new Map<number | null, TraceStep[]>();
  for (const s of steps) {
    // Treat a parent that doesn't resolve as a root, so no step is dropped.
    const key = s.parent_step_number != null && byNumber.has(s.parent_step_number)
      ? s.parent_step_number
      : null;
    const list = childrenOf.get(key) ?? [];
    list.push(s);
    childrenOf.set(key, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.step_number - b.step_number);

  const lines: string[] = [];
  const walk = (parentKey: number | null, indent: string): void => {
    const children = childrenOf.get(parentKey) ?? [];
    for (const step of children) {
      const icon = stepIcon(step.step_type as StepType);
      const typeLabel = stepLabel(step.step_type as StepType);
      const name = chalk.white.bold(`"${step.name}"`);
      const causal =
        step.caused_by_step_number != null
          ? chalk.dim(` ⟵ caused by #${step.caused_by_step_number}`)
          : '';
      const dur = step.duration_ms != null ? chalk.dim(`  ${formatDuration(step.duration_ms)}`) : '';
      const branch = indent ? chalk.dim('└─ ') : '';
      lines.push(`  ${indent}${branch}${chalk.dim(`#${step.step_number}`)} ${icon} ${typeLabel}  ${name}${causal}${dur}`);

      if (step.decision) {
        lines.push(`  ${indent}   ${label('chose')} ${chalk.greenBright(step.decision.chosen)}`);
      }
      walk(step.step_number, indent + '   ');
    }
  };

  walk(null, '');
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function truncateJson(obj: unknown, maxLen: number): string {
  let str: string;
  try {
    str = JSON.stringify(obj) ?? 'null';
  } catch {
    str = String(obj);
  }
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/** Strip ANSI escape codes (for re-applying styling) */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
