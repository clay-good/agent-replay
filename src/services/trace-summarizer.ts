import type { TraceWithDetails, TraceStep, TraceDiffResult } from '../models/types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface TraceSummary {
  text: string;
  estimated_tokens: number;
}

// ── Main summarizer ─────────────────────────────────────────────────────

/**
 * Compress a trace into a token-efficient text summary for LLM consumption.
 * Estimated ~4 chars per token.
 */
export function summarizeTrace(
  trace: TraceWithDetails,
  maxTokenBudget: number = 3000,
): TraceSummary {
  const maxChars = maxTokenBudget * 4;
  const lines: string[] = [];

  // Header
  const version = trace.agent_version ? ` v${trace.agent_version}` : '';
  lines.push(`TRACE: ${trace.agent_name}${version} [${trace.status.toUpperCase()}]`);

  // Input summary
  const inputStr = truncObj(trace.input, 300);
  lines.push(`INPUT: ${inputStr}`);

  // Output summary
  if (trace.output) {
    const outputStr = truncObj(trace.output, 300);
    lines.push(`OUTPUT: ${outputStr}`);
  }

  // Step summary header
  const totalDur = trace.total_duration_ms != null ? `, ${fmtMs(trace.total_duration_ms)}` : '';
  const totalTok = trace.total_tokens != null ? `, ${trace.total_tokens} tokens` : '';
  lines.push(`\nSTEPS (${trace.steps.length} total${totalDur}${totalTok}):`);

  // Steps — progressively truncate based on budget
  const stepBudget = maxChars - lines.join('\n').length - 200; // reserve 200 for error/footer
  const stepLines = summarizeSteps(trace.steps, stepBudget);
  lines.push(...stepLines);

  // Error
  if (trace.error) {
    lines.push(`\nERROR: ${trunc(trace.error, 300)}`);
  }

  // Tags
  if (trace.tags.length > 0) {
    lines.push(`TAGS: ${trace.tags.join(', ')}`);
  }

  const text = lines.join('\n');
  return {
    text,
    estimated_tokens: Math.ceil(text.length / 4),
  };
}

/**
 * Summarize two traces and their diff for AI-powered diff analysis.
 */
export function summarizeDiffForLlm(
  diff: TraceDiffResult,
  left: TraceWithDetails,
  right: TraceWithDetails,
): TraceSummary {
  const lines: string[] = [];

  // Trace headers
  const leftVer = left.agent_version ? ` v${left.agent_version}` : '';
  const rightVer = right.agent_version ? ` v${right.agent_version}` : '';
  lines.push(`TRACE A: ${left.agent_name}${leftVer} [${left.status.toUpperCase()}] (${left.steps.length} steps${left.total_duration_ms ? `, ${fmtMs(left.total_duration_ms)}` : ''})`);
  lines.push(`TRACE B: ${right.agent_name}${rightVer} [${right.status.toUpperCase()}] (${right.steps.length} steps${right.total_duration_ms ? `, ${fmtMs(right.total_duration_ms)}` : ''})`);

  // Input comparison
  lines.push(`\nINPUT A: ${truncObj(left.input, 200)}`);
  lines.push(`INPUT B: ${truncObj(right.input, 200)}`);

  // Output comparison
  if (left.output) lines.push(`OUTPUT A: ${truncObj(left.output, 200)}`);
  if (right.output) lines.push(`OUTPUT B: ${truncObj(right.output, 200)}`);

  // Divergence
  if (diff.divergence_step != null) {
    lines.push(`\nDIVERGES AT STEP ${diff.divergence_step}`);
  }

  // Differences
  if (diff.diffs.length > 0) {
    lines.push(`\nDIFFERENCES (${diff.diffs.length}):`);
    for (const d of diff.diffs.slice(0, 15)) {
      const leftVal = trunc(String(d.left_value ?? '(missing)'), 80);
      const rightVal = trunc(String(d.right_value ?? '(missing)'), 80);
      lines.push(`- Step ${d.step_number}, ${d.field}: LEFT=${leftVal} | RIGHT=${rightVal}`);
    }
    if (diff.diffs.length > 15) {
      lines.push(`  ... and ${diff.diffs.length - 15} more`);
    }
  }

  // Errors
  if (left.error) lines.push(`\nERROR A: ${trunc(left.error, 200)}`);
  if (right.error) lines.push(`ERROR B: ${trunc(right.error, 200)}`);

  const text = lines.join('\n');
  return {
    text,
    estimated_tokens: Math.ceil(text.length / 4),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function summarizeSteps(steps: TraceStep[], charBudget: number): string[] {
  const lines: string[] = [];
  let totalChars = 0;
  const outputLimit = charBudget > 2000 ? 200 : 100;

  // If very tight budget, only show error/decision/output steps
  const showAll = charBudget > steps.length * 80;

  for (const step of steps) {
    const isImportant = step.error || step.step_type === 'error' || step.step_type === 'output' || step.step_type === 'decision';

    if (!showAll && !isImportant) continue;

    let line = `${step.step_number}. [${step.step_type}] ${step.name}`;

    // Duration + tokens
    const parts: string[] = [];
    if (step.duration_ms != null) parts.push(fmtMs(step.duration_ms));
    if (step.tokens_used != null) parts.push(`${step.tokens_used}tok`);
    if (step.model) parts.push(`model=${step.model}`);
    if (parts.length > 0) line += ` (${parts.join(', ')})`;

    if (step.error) line += ' ERROR';

    // Output summary
    if (step.output) {
      const outStr = truncObj(step.output, outputLimit);
      line += `\n   -> ${outStr}`;
    }

    // Input for tool_call steps (often contains critical info like file paths)
    if (step.step_type === 'tool_call' && step.input && Object.keys(step.input).length > 0) {
      const inStr = truncObj(step.input, outputLimit);
      line += `\n   input: ${inStr}`;
    }

    // Error detail
    if (step.error) {
      line += `\n   error: ${trunc(step.error, 150)}`;
    }

    if (totalChars + line.length > charBudget) {
      lines.push(`... (${steps.length - lines.length} more steps omitted for brevity)`);
      break;
    }

    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines;
}

function truncObj(obj: Record<string, unknown>, maxLen: number): string {
  try {
    const str = JSON.stringify(obj);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  } catch {
    return String(obj).slice(0, maxLen);
  }
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
