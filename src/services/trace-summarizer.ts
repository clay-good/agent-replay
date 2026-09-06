import type { TraceWithDetails, TraceStep, TraceDiffResult } from '../models/types.js';
import { formatDuration, effectiveDurationMs } from '../utils/time.js';
import { truncate, truncateJson, hasRenderableContent, windowedAround } from '../utils/json.js';
import { effectiveTokens } from '../utils/totals.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface TraceSummary {
  text: string;
  estimated_tokens: number;
  /**
   * How many of the trace's steps the summary actually carries, and how many it
   * has. The text tells the JUDGE when steps were dropped ("... N more steps
   * omitted"); these say the same thing to the caller, so a verdict computed
   * over part of a run can be reported as such. `stats` already makes this
   * distinction for its own totals ("over N of M").
   */
  steps_shown: number;
  steps_total: number;
  /**
   * The same disclosure for a DIFF summary, whose reduction is the list of
   * divergences rather than the steps: it carries the first 15 and tells the
   * model "and N more". Absent from a trace summary, which has no diffs.
   */
  diffs_shown?: number;
  diffs_total?: number;
}

/**
 * How many divergences the diff summary lists for the model. Named, because the
 * count is reported to the caller as well now — a verdict formed over 15 of
 * 4,178 differences (a real pair, measured) must be able to say so.
 */
const DIFF_LIST_LIMIT = 15;

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

  // Output summary. `hasRenderableContent`, not truthiness: the summary is what
  // an AI evaluator reasons from, and a run whose answer was `false` or `0` — a
  // failed check, a "not found", a boolean verdict — was presented as a run that
  // produced NOTHING. The judge then scored a trace it had not been shown.
  if (hasRenderableContent(trace.output)) {
    const outputStr = truncObj(trace.output, 300);
    lines.push(`OUTPUT: ${outputStr}`);
  }

  // Step summary header. Both totals fall back to what the steps carry, exactly
  // as `list`, `show` and `stats` do: the trace-level columns are set only when
  // a producer reports them, so for every hook-, `record`-, OTel- or
  // importer-captured trace the judge was handed a run with no duration and no
  // token count — while the efficiency preset's own prompt asks it to weigh
  // "cost, latency and token usage". It scored what it had not been shown.
  const durationMs = effectiveDurationMs(trace);
  const tokens = effectiveTokens(trace);
  const totalDur = durationMs != null ? `, ${formatDuration(durationMs)}` : '';
  const totalTok = tokens != null ? `, ${tokens} tokens` : '';
  lines.push(`\nSTEPS (${trace.steps.length} total${totalDur}${totalTok}):`);

  // Steps — progressively truncate based on budget
  const stepBudget = maxChars - lines.join('\n').length - 200; // reserve 200 for error/footer
  const stepLines = summarizeSteps(trace.steps, stepBudget);
  lines.push(...stepLines);

  // Error
  if (trace.error) {
    lines.push(`\nERROR: ${truncate(trace.error, 300)}`);
  }

  // Tags
  if (trace.tags.length > 0) {
    lines.push(`TAGS: ${trace.tags.join(', ')}`);
  }

  const text = lines.join('\n');
  const omitted = Number(/\((\d+) more steps omitted/.exec(text)?.[1] ?? 0);
  return {
    text,
    estimated_tokens: Math.ceil(text.length / 4),
    steps_total: trace.steps.length,
    steps_shown: trace.steps.length - omitted,
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
  const leftDur = effectiveDurationMs(left);
  const rightDur = effectiveDurationMs(right);
  lines.push(`TRACE A: ${left.agent_name}${leftVer} [${left.status.toUpperCase()}] (${left.steps.length} steps${leftDur != null ? `, ${formatDuration(leftDur)}` : ''})`);
  lines.push(`TRACE B: ${right.agent_name}${rightVer} [${right.status.toUpperCase()}] (${right.steps.length} steps${rightDur != null ? `, ${formatDuration(rightDur)}` : ''})`);

  // Input comparison
  lines.push(`\nINPUT A: ${truncObj(left.input, 200)}`);
  lines.push(`INPUT B: ${truncObj(right.input, 200)}`);

  // Output comparison
  if (hasRenderableContent(left.output)) lines.push(`OUTPUT A: ${truncObj(left.output, 200)}`);
  if (hasRenderableContent(right.output)) lines.push(`OUTPUT B: ${truncObj(right.output, 200)}`);

  // Divergence — or the truth, when one trace is a prefix of the other.
  //
  // The model is asked "WHY did the traces diverge", so handing it
  // "DIVERGES AT STEP 3" for a fork that has not run yet invites a confabulated
  // cause for an event that did not happen. Say what actually holds instead.
  if (diff.common_prefix) {
    const { shorter, last_common_step, missing_steps } = diff.common_prefix;
    lines.push(
      `\nNO DIVERGENCE: the ${shorter} trace is identical through step ${last_common_step} and then STOPS; the ${shorter === 'right' ? 'left' : 'right'} continues for ${missing_steps} more step(s).`,
    );
  } else if (diff.divergence_step != null) {
    lines.push(`\nDIVERGES AT STEP ${diff.divergence_step}`);
  }

  // Differences
  if (diff.diffs.length > 0) {
    lines.push(`\nDIFFERENCES (${diff.diffs.length}):`);
    for (const d of diff.diffs.slice(0, DIFF_LIST_LIMIT)) {
      // JSON-stringify the values rather than String(): `input`/`output` field
      // diffs carry the parsed objects, and String({...}) is "[object Object]",
      // which would give the AI diff analysis no signal about the most
      // information-rich kind of difference. Render `(missing)` ONLY for the diff
      // types that mean an absent step — `missing_left` (no such step on the
      // left) and `missing_right`. A field diff (`output`, `model`, …) can carry
      // a legitimate `null` value on a step that exists on both sides, so
      // labeling that `(missing)` would falsely tell the analysis the step is
      // gone; those render `null` (via truncateJson) instead.
      // Windowed around the first difference, like the terminal renderer. Cutting
      // from position 0 made two values sharing a long prefix — a system prompt, a
      // message array, the normal shape of an agent payload — truncate to
      // BYTE-IDENTICAL text, so the model was asked why the traces diverged over
      // evidence showing they did not.
      const leftVal = d.field === 'missing_left' ? '(missing)' : windowedJson(d.left_value, d.right_value, 80);
      const rightVal = d.field === 'missing_right' ? '(missing)' : windowedJson(d.right_value, d.left_value, 80);
      const where = d.step_number === null ? 'Trace' : `Step ${d.step_number}`;
      lines.push(`- ${where}, ${d.field}: LEFT=${leftVal} | RIGHT=${rightVal}`);
    }
    if (diff.diffs.length > DIFF_LIST_LIMIT) {
      lines.push(`  ... and ${diff.diffs.length - DIFF_LIST_LIMIT} more`);
    }
  }

  // Errors
  if (left.error) lines.push(`\nERROR A: ${truncate(left.error, 200)}`);
  if (right.error) lines.push(`ERROR B: ${truncate(right.error, 200)}`);

  const text = lines.join('\n');
  return {
    text,
    estimated_tokens: Math.ceil(text.length / 4),
    // The diff summary carries divergences, not steps: it caps the LIST of
    // differences, so step coverage is not the number that describes it.
    // Reported as complete rather than inventing a ratio this summary does not
    // measure; the ratio that DOES describe it is the diff one below.
    steps_shown: left.steps.length + right.steps.length,
    steps_total: left.steps.length + right.steps.length,
    diffs_shown: Math.min(diff.diffs.length, DIFF_LIST_LIMIT),
    diffs_total: diff.diffs.length,
  };
}

/** `truncateJson`'s windowing form: serialize, then cut around the first difference. */
function windowedJson(value: unknown, other: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const otherText = typeof other === 'string' ? other : JSON.stringify(other) ?? '';
  return windowedAround(text, otherText, max);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function summarizeSteps(steps: TraceStep[], charBudget: number): string[] {
  const outputLimit = charBudget > 2000 ? 200 : 100;

  // Decide WHAT to keep before rendering, and render only what is kept.
  //
  // Two failure modes shaped this. Walking the steps in order and stopping when
  // the budget ran out lost the LAST steps — and the failing step is almost
  // always last, so an AI evaluator judged a failure it had never been shown
  // (the trace-level `error` is null on the normal hook-capture shape, where the
  // detail lives on the step). Prioritizing "important" steps did not fix it on
  // its own either: whole trace shapes are 100% important — a Gemini import
  // attaches a decision record to every tool call, and a retry storm is all
  // errors — so the greedy in-order fill dropped the last important step just
  // the same. The step that ENDED the run is therefore claimed first, before
  // anything else competes for the budget.
  let lastFailureIndex = -1;
  steps.forEach((step, i) => {
    if (step.error != null || step.step_type === 'error') lastFailureIndex = i;
  });
  const priority = (i: number): number => {
    if (i === lastFailureIndex) return 0;
    if (isImportantStep(steps[i])) return 1;
    return 2;
  };

  const order = steps.map((_, i) => i).sort((a, b) => priority(a) - priority(b) || a - b);

  const keep = new Set<number>();
  const rendered = new Map<number, string>();
  let used = 0;
  for (const i of order) {
    // No fixed minimum line length: a `1. [thought] plan` line is 17 characters,
    // so a 40-char floor dropped steps that FIT and then reported them as
    // omitted — a trace that fits entirely was handed to the judge as truncated.
    if (used >= charBudget) break;
    const line = renderStepSummary(steps[i], outputLimit);
    if (used + line.length + 1 > charBudget) continue;
    rendered.set(i, line);
    keep.add(i);
    used += line.length + 1;
  }

  // Emitted in step order whatever order they were claimed in.
  const lines = [...keep].sort((a, b) => a - b).map((i) => rendered.get(i)!);
  const omitted = steps.length - lines.length;
  // Say so WHENEVER anything was dropped. The marker used to be emitted only on
  // the budget-break path, so the prioritizing branch could silently discard 40
  // of 41 steps and leave an evaluator reasoning about step counts and
  // efficiency over a trace that looked like it had one step.
  if (omitted > 0) lines.push(`... (${omitted} more steps omitted for brevity)`);

  return lines;
}

/**
 * Steps that must survive a budget cut: the failure, the answer, and the choice.
 *
 * A decision record can be attached to a step of any type via the live recorder
 * (see listDecisions), so key off the record's presence, not just
 * `step_type === 'decision'`.
 */
function isImportantStep(step: TraceStep): boolean {
  return Boolean(
    step.error ||
      step.step_type === 'error' ||
      step.step_type === 'output' ||
      step.step_type === 'decision' ||
      step.decision != null,
  );
}

function renderStepSummary(step: TraceStep, outputLimit: number): string {
  let line = `${step.step_number}. [${step.step_type}] ${step.name}`;

  // Duration + tokens
  const parts: string[] = [];
  if (step.duration_ms != null) parts.push(formatDuration(step.duration_ms));
  if (step.tokens_used != null) parts.push(`${step.tokens_used}tok`);
  if (step.model) parts.push(`model=${step.model}`);
  if (parts.length > 0) line += ` (${parts.join(', ')})`;

  if (step.error) line += ' ERROR';

  // Output summary — same guard, same reason as the trace output above.
  if (hasRenderableContent(step.output)) {
    line += `\n   -> ${truncObj(step.output, outputLimit)}`;
  }

  // Input for tool_call steps (often contains critical info like file paths)
  if (step.step_type === 'tool_call' && hasRenderableContent(step.input)) {
    line += `\n   input: ${truncObj(step.input, outputLimit)}`;
  }

  // Decision record — the chosen option and why, so an AI evaluator can reason
  // about the agent's choices (root-cause / quality analysis).
  if (step.decision) {
    const d = step.decision;
    const conf = d.confidence != null ? ` (confidence ${d.confidence})` : '';
    const by = d.decided_by ? ` by ${d.decided_by}` : '';
    // Bounded like the rationale beside it: this was the only unbounded field
    // left, so a decision carrying a multi-kilobyte `chosen` — claimed first
    // when it sits on the failing step — could eat the whole budget and leave a
    // summary of three steps.
    line += `\n   chose: ${truncate(d.chosen, 150)}${conf}${by}`;
    if (d.rationale) line += `\n   rationale: ${truncate(d.rationale, 150)}`;
  }

  // Error detail
  if (step.error) {
    line += `\n   error: ${truncate(step.error, 150)}`;
  }

  return line;
}

/**
 * `unknown`, not `Record<string, unknown>`: these fields hold arbitrary JSON —
 * a scalar input, a `false` output — and the callers no longer narrow with a
 * truthiness test that was itself the bug (it hid exactly those values).
 */
function truncObj(obj: unknown, maxLen: number): string {
  try {
    const str = JSON.stringify(obj);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  } catch {
    return String(obj).slice(0, maxLen);
  }
}
