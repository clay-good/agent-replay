import chalk from 'chalk';
import type { TraceStep } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { stepIcon, stepLabel, colors, label, separator, safeText, safeLine } from './theme.js';
import { hasRenderableContent, truncate } from '../utils/json.js';
import { truncateToWidth } from './width.js';
import { formatDuration } from '../utils/time.js';

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
/**
 * A step name is producer-controlled and unbounded, while every other field on
 * the row is windowed. A 500 KB tool name therefore emitted a single line of
 * 500,031 columns, which no terminal can wrap usefully — the step's actual
 * input and output, which ARE bounded, scrolled away above it.
 */
const STEP_NAME_MAX = 80;

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
    const name = chalk.white.bold(`"${safeLine(truncate(step.name, STEP_NAME_MAX))}"`);
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
      lines.push(`  ${chalk.dim(pipe)}      ${label('Model:')} ${chalk.white(safeLine(step.model))}`);
    }

    // Input
    if (showInput && hasRenderableContent(step.input)) {
      const inputStr = truncateJson(step.input, contentWidth);
      lines.push(`  ${chalk.dim(pipe)}      ${label('Input:')} ${chalk.dim(inputStr)}`);
    }

    // Output
    if (showOutput && hasRenderableContent(step.output)) {
      const outputStr = truncateJson(step.output, contentWidth);
      lines.push(`  ${chalk.dim(pipe)}      ${label('Output:')} ${chalk.dim(outputStr)}`);
    }

    // Decision record (for decision steps)
    if (step.decision) {
      const conf = step.decision.confidence != null ? chalk.dim(` (confidence ${step.decision.confidence})`) : '';
      lines.push(`  ${chalk.dim(pipe)}      ${label('Chose:')} ${chalk.greenBright(safeLine(step.decision.chosen))}${conf}`);
      if (step.decision.rationale) {
        lines.push(`  ${chalk.dim(pipe)}      ${label('Because:')} ${chalk.dim(safeLine(step.decision.rationale))}`);
      }
    }

    // Error
    //
    // A multi-line error keeps its line breaks — a stack trace or a Windows
    // child's CRLF output is shaped information, and two tests pin that. But a
    // continuation line used to be emitted raw, so it started at column 0 with
    // no gutter and read as agent-replay's own output: `'line1\nagent-replay:
    // all checks passed'` printed a line indistinguishable from this tool
    // speaking. The trace is written by the agent under test, so that is a
    // forgery primitive, not a formatting quirk. Keep the breaks, but draw
    // every continuation inside the gutter, where it is visibly trace content.
    if (step.error) {
      const errLines = safeText(step.error).split('\n');
      lines.push(`  ${chalk.dim(pipe)}      ${chalk.redBright('Error:')} ${chalk.red(errLines[0])}`);
      for (const cont of errLines.slice(1)) {
        lines.push(`  ${chalk.dim(pipe)}             ${chalk.red(cont)}`);
      }
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
 * and annotating causal links. Falls back to the flat timeline only when a
 * trace has no causal structure at all — neither parent nesting nor
 * `caused_by` links. A flat trace that records causality without nesting (every
 * `parent_step` null but `caused_by_step` set — a normal shape, e.g. a decision
 * followed by the steps it caused) still renders here so `--tree` actually shows
 * its `⟵ caused by #N` annotations instead of a plain timeline that omits them.
 */
/**
 * How many levels of nesting the tree still indents for. Beyond this the indent
 * is held constant: it grows three characters per level, so an unbounded indent
 * makes the rendered output quadratic in depth, and past a few dozen levels it
 * is wider than any terminal and conveys nothing.
 */
const MAX_TREE_INDENT = 40;

export function renderTree(steps: TraceStep[], options: TimelineOptions = {}): string {
  if (steps.length === 0) {
    return chalk.dim('  No steps recorded.');
  }

  const hasCausalStructure = steps.some(
    (s) => s.parent_step_number != null || s.caused_by_step_number != null,
  );
  if (!hasCausalStructure) {
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
  const visited = new Set<number>();

  const emit = (step: TraceStep, indent: string, cappedDepth?: number): void => {
    const icon = stepIcon(step.step_type as StepType);
    const typeLabel = stepLabel(step.step_type as StepType);
    const name = chalk.white.bold(`"${safeLine(truncate(step.name, STEP_NAME_MAX))}"`);
    const causal =
      step.caused_by_step_number != null
        ? chalk.dim(` ⟵ caused by #${step.caused_by_step_number}`)
        : '';
    const dur = step.duration_ms != null ? chalk.dim(`  ${formatDuration(step.duration_ms)}`) : '';
    const branch = indent ? chalk.dim('└─ ') : '';
    // Past the indent cap the indent no longer distinguishes levels, so the
    // depth is stated rather than drawn.
    const depthNote = cappedDepth != null ? chalk.dim(`  [depth ${cappedDepth}]`) : '';
    lines.push(`  ${indent}${branch}${chalk.dim(`#${step.step_number}`)} ${icon} ${typeLabel}  ${name}${causal}${dur}${depthNote}`);
    if (step.decision) {
      lines.push(`  ${indent}   ${label('chose')} ${chalk.greenBright(safeLine(step.decision.chosen))}`);
    }
    // The tree is the view for understanding why an agent did what it did, and
    // it is only reached when a trace HAS causal structure — so on a failed
    // trace, the case it exists for, it was hiding the failure message that the
    // default timeline prints. The compact view still omits input/output and
    // per-step detail by design; an error is not detail.
    if (step.error) {
      lines.push(`  ${indent}   ${label('error')} ${chalk.redBright(safeLine(truncateJson(step.error, 100)))}`);
    }
  };

  // ITERATIVE, with an explicit stack — not recursion.
  //
  // The natural recursive walk went one JS frame deep per level of nesting, so a
  // trace whose steps form a long parent chain blew the stack: measured, it
  // succeeds at depth 4,000 and throws "Maximum call stack size exceeded"
  // between there and 8,000. That is reachable — a step's parent is the step
  // before it in any run that threads causality linearly, and `--tree` is
  // exactly the view someone opens to understand a long session. The command
  // failed with a one-line error and no tree at all.
  //
  // The stack holds children in reverse so they pop in their original order,
  // which keeps the output byte-identical to the recursive version. The visited
  // set still guards against parent cycles and self-parents (possible if a
  // producer bypassed validation): a step is rendered at most once.
  const walk = (parentKey: number | null, indent: string): void => {
    const stack: Array<{ step: TraceStep; indent: string; depth: number }> = [];
    // The indent stops growing past MAX_TREE_INDENT levels. It grows three
    // characters per level, so the total output is QUADRATIC in depth: a
    // 20,000-deep chain sums to roughly 600 MB of leading whitespace and threw
    // "Invalid string length" while building it. Past a few dozen levels the
    // indent conveys nothing a terminal can show anyway — it is already wider
    // than the window — so capping it makes the output linear in step count and
    // keeps a deep tree renderable at all.
    const deepen = (ind: string): string => (ind.length >= MAX_TREE_INDENT * 3 ? ind : ind + '   ');
    const push = (key: number | null, ind: string, depth: number): void => {
      const children = childrenOf.get(key) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ step: children[i], indent: ind, depth });
    };
    push(parentKey, indent, 1);
    while (stack.length > 0) {
      const { step, indent: ind, depth } = stack.pop()!;
      if (visited.has(step.step_number)) continue;
      visited.add(step.step_number);
      // Once the indent stops growing, say the depth instead. Otherwise every
      // level past the cap renders with the same 122 spaces and a step at depth
      // 60 is indistinguishable from one at depth 41 — the indent is the only
      // thing conveying nesting, so capping it without this trades a crash for a
      // quietly wrong picture.
      emit(step, ind, depth > MAX_TREE_INDENT ? depth : undefined);
      push(step.step_number, deepen(ind), depth + 1);
    }
  };

  walk(null, '');
  // Any step not reached from a real root (its parent chain forms a cycle) is
  // rendered as a top-level root so no step is ever dropped.
  for (const step of steps) {
    if (visited.has(step.step_number)) continue;
    visited.add(step.step_number);
    emit(step, '');
    walk(step.step_number, '   ');
  }

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * A step's payload, rendered safely.
 *
 * `safeText` is applied HERE, at the shared helper, rather than at each call
 * site — the rule this codebase arrived at after patching individual render
 * sites four times and still missing one. `JSON.stringify` escapes C0 controls
 * but NOT C1 (U+0080-U+009F), and xterm/VTE/iTerm2 decode U+009B as CSI — so a
 * tool result or model output containing one re-coloured or addressed the
 * operator's terminal from `show`, `show --tree` and `replay`. Step payloads
 * are producer-controlled and, unlike a trace id, are not constrained at the
 * write, so escaping at render is the only place this can be handled.
 */
function truncateJson(obj: unknown, maxLen: number): string {
  let str: string;
  try {
    str = JSON.stringify(obj) ?? 'null';
  } catch {
    str = String(obj);
  }
  str = safeText(str);
  return truncateToWidth(str, maxLen);
}


/** Strip ANSI escape codes (for re-applying styling) */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
