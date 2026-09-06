import type Database from 'better-sqlite3';
import type { TraceDiffResult, StepDiff } from '../models/types.js';
import type { LlmClientOptions } from './llm-client.js';
import { callLlm, modelRateIsKnown } from './llm-client.js';
import { getTrace } from './trace-service.js';
import { summarizeDiffForLlm } from './trace-summarizer.js';
import { extractJson, fenceTraceContent, INJECTION_GUARD, DEFAULT_EVAL_MAX_TOKENS } from './eval-service.js';
import { stableStringify } from './check-service.js';
import { safeParseJson, truncate } from '../utils/json.js';

/**
 * Compare two traces step-by-step, identifying the divergence point and
 * all field-level differences.
 *
 * Adapted from proxilion-managed-main/crates/agent-replay/src/services.rs
 * compute_diff (lines 192-300).
 */
/**
 * Every step's decision record for one trace, keyed by step_number.
 *
 * The table keys on step_id, so this joins through the steps; read once per
 * trace rather than per step. Confidence and the option list are deliberately
 * excluded from the comparable shape — they are the model's self-report and vary
 * run to run without the agent having acted differently, which is the
 * false-positive class this comparison has to avoid.
 */
function decisionsByStep(
  db: Database.Database,
  traceId: string,
): Map<number, { chosen: string; rationale: string | null; decided_by: string }> {
  const rows = db
    .prepare(
      `SELECT s.step_number, d.chosen, d.rationale, d.decided_by
         FROM agent_trace_decisions d
         JOIN agent_trace_steps s ON s.id = d.step_id
        WHERE s.trace_id = ?`,
    )
    .all(traceId) as Array<{ step_number: number; chosen: string; rationale: string | null; decided_by: string }>;
  return new Map(rows.map((r) => [r.step_number, { chosen: r.chosen, rationale: r.rationale, decided_by: r.decided_by }]));
}

export function diffTraces(
  db: Database.Database,
  leftTraceId: string,
  rightTraceId: string,
): TraceDiffResult {
  const leftSteps = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number',
    )
    .all(leftTraceId) as Record<string, unknown>[];

  const rightSteps = db
    .prepare(
      'SELECT * FROM agent_trace_steps WHERE trace_id = ? ORDER BY step_number',
    )
    .all(rightTraceId) as Record<string, unknown>[];

  const leftDecisions = decisionsByStep(db, leftTraceId);
  const rightDecisions = decisionsByStep(db, rightTraceId);

  const diffs: StepDiff[] = [];
  let divergence_step: number | null = null;

  // Align steps by step_number, not array position. Step numbers can have gaps
  // — validation only requires each be a positive integer (see validators.ts),
  // and an ingested, forked, or OTLP-assembled trace can leave holes — so
  // pairing by index would compare unrelated steps and mis-pin the divergence
  // point (which also feeds the AI diff analysis). Both lists are ordered by
  // step_number, so a two-pointer merge-join pairs equal numbers and treats a
  // number present on only one side as a one-sided step. Walking in ascending
  // order means the first difference found is at the smallest step number.
  let li = 0;
  let ri = 0;

  while (li < leftSteps.length || ri < rightSteps.length) {
    const left = leftSteps[li];
    const right = rightSteps[ri];
    const ln = left ? (left.step_number as number) : Infinity;
    const rn = right ? (right.step_number as number) : Infinity;

    if (left && right && ln === rn) {
      const stepNum = ln;

      if (left.step_type !== right.step_type) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'step_type',
          left_value: left.step_type,
          right_value: right.step_type,
        });
      }

      if (left.name !== right.name) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'name',
          left_value: left.name,
          right_value: right.name,
        });
      }

      // Compare the parsed values, not the raw JSON TEXT. Two traces carrying
      // the same input/output but produced by different pipelines (e.g. an
      // OTLP-ingested trace vs. a hook-recorded one) can serialize equal data
      // with different key order or whitespace; a raw-string compare would then
      // report a phantom diff and, worse, pin `divergence_step` to it — which
      // feeds the AI diff analysis. stableStringify normalizes both.
      const leftInput = safeParseJson(left.input as string);
      const rightInput = safeParseJson(right.input as string);
      if (stableStringify(leftInput) !== stableStringify(rightInput)) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'input',
          left_value: leftInput,
          right_value: rightInput,
        });
      }

      const leftOutput = safeParseJson(left.output as string | null) ?? null;
      const rightOutput = safeParseJson(right.output as string | null) ?? null;
      if (stableStringify(leftOutput) !== stableStringify(rightOutput)) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'output',
          left_value: leftOutput,
          right_value: rightOutput,
        });
      }

      // Model — surfaces the "swapped a model and it broke" case directly, not
      // just via its downstream effects.
      if (left.model !== right.model) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'model',
          left_value: (left.model as string | null) ?? null,
          right_value: (right.model as string | null) ?? null,
        });
      }

      // Error — the whole point of "it worked before, what changed?". Without
      // this, a step that failed on one side and succeeded on the other, with
      // everything else equal, reported no differences at all — under a header
      // showing COMPLETED beside FAILED. (The renderer said "Traces are
      // identical." then; it now reports what it compared, for a related
      // reason: even a full comparison leaves the state snapshots out.) Every live capture path records a failed tool
      // as a normal step with `error` set, so this is the common shape.
      const leftErr = (left.error as string | null) ?? null;
      const rightErr = (right.error as string | null) ?? null;
      if (leftErr !== rightErr) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'error',
          left_value: leftErr,
          right_value: rightErr,
        });
      }

      // The decision record — the single field this whole tool exists to
      // explain. Without it, two runs that took OPPOSITE actions at the same
      // step reported no differences at all (exit 0) whenever every other
      // field matched, while `decisions` and `why` on the same pair correctly
      // showed one choosing `rm_rf` and the other `safe_path`. `diff --ai` was
      // handed a summary with no differences at all and asked why they diverged.
      const leftDecision = leftDecisions.get(stepNum) ?? null;
      const rightDecision = rightDecisions.get(stepNum) ?? null;
      if (stableStringify(leftDecision) !== stableStringify(rightDecision)) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'decision',
          left_value: leftDecision,
          right_value: rightDecision,
        });
      }

      li++;
      ri++;
    } else if (ln < rn) {
      // A step number present on the left only.
      const stepNum = ln;
      if (divergence_step === null) divergence_step = stepNum;
      diffs.push({
        step_number: stepNum,
        field: 'missing_right',
        left_value: (left as Record<string, unknown>).name,
        right_value: null,
      });
      li++;
    } else {
      // A step number present on the right only.
      const stepNum = rn;
      if (divergence_step === null) divergence_step = stepNum;
      diffs.push({
        step_number: stepNum,
        field: 'missing_left',
        left_value: null,
        right_value: (right as Record<string, unknown>).name,
      });
      ri++;
    }
  }

  // Trace-level fields. Nothing outside the step list was compared, so two runs
  // with identical steps but opposite outcomes — one completed, one failed with
  // an error, or with different final outputs — were reported as identical.
  // These carry `step_number: null`: they belong to the trace, not to a step,
  // and must not pin `divergence_step`, which means "the first step that went
  // different".
  const leftTrace = db.prepare('SELECT status, error, output, input FROM agent_traces WHERE id = ?').get(leftTraceId) as
    | Record<string, unknown>
    | undefined;
  const rightTrace = db.prepare('SELECT status, error, output, input FROM agent_traces WHERE id = ?').get(rightTraceId) as
    | Record<string, unknown>
    | undefined;

  if (leftTrace && rightTrace) {
    // The trace's own input. Its absence hid the one thing `fork --modify-input`
    // changes — and `fork` closes by telling the user to run exactly this diff,
    // which then reported the modified run as differing only in status. Two
    // separately-ingested traces whose only difference was the prompt compared
    // as "identical". The AI summary already showed INPUT A / INPUT B, so
    // `diff` and `diff --ai` could contradict each other about the same pair.
    const leftIn = safeParseJson(leftTrace.input as string | null) ?? null;
    const rightIn = safeParseJson(rightTrace.input as string | null) ?? null;
    if (stableStringify(leftIn) !== stableStringify(rightIn)) {
      diffs.push({
        step_number: null,
        field: 'trace_input',
        left_value: leftIn,
        right_value: rightIn,
      });
    }
    if (leftTrace.status !== rightTrace.status) {
      diffs.push({
        step_number: null,
        field: 'status',
        left_value: leftTrace.status ?? null,
        right_value: rightTrace.status ?? null,
      });
    }
    if ((leftTrace.error ?? null) !== (rightTrace.error ?? null)) {
      diffs.push({
        step_number: null,
        field: 'trace_error',
        left_value: leftTrace.error ?? null,
        right_value: rightTrace.error ?? null,
      });
    }
    const leftOut = safeParseJson(leftTrace.output as string | null) ?? null;
    const rightOut = safeParseJson(rightTrace.output as string | null) ?? null;
    if (stableStringify(leftOut) !== stableStringify(rightOut)) {
      diffs.push({
        step_number: null,
        field: 'trace_output',
        left_value: leftOut,
        right_value: rightOut,
      });
    }
  }

  // "Stopped" is not "went differently".
  //
  // `divergence_step` is pinned by the first step present on one side only, so
  // a run that simply ENDS early — a fork nobody has explored yet, a run that
  // crashed at step 2, a capture whose producer died — was announced as
  // DIVERGES AT STEP 3 with a row per remaining step, when the two agreed on
  // every step they both have. `fork` prints `agent-replay diff <parent>
  // <fork>` as the next thing to run, so that reading was the FIRST thing a
  // user saw about a copy that had not run at all.
  //
  // The test is structural and cheap: every step-level difference is a step
  // missing from the same side. If any paired step differed there would be a
  // diff of another field, and if steps were missing from both sides the two
  // sides would not be prefix and extension.
  const stepDiffs = diffs.filter((d) => d.step_number != null);
  const missingFrom = (field: string) => stepDiffs.length > 0 && stepDiffs.every((d) => d.field === field);
  const shorter = missingFrom('missing_right') ? 'right' : missingFrom('missing_left') ? 'left' : null;
  const shortSteps = shorter === 'right' ? rightSteps : leftSteps;
  const longSteps = shorter === 'right' ? leftSteps : rightSteps;
  // The last step NUMBER they share, not a count: step numbers can have gaps
  // (the merge-join above exists for exactly that reason), so counting would
  // name a step the trace does not have.
  const lastCommon = shortSteps.length > 0 ? (shortSteps[shortSteps.length - 1].step_number as number) : 0;

  return {
    left_trace_id: leftTraceId,
    right_trace_id: rightTraceId,
    divergence_step,
    left_step_count: leftSteps.length,
    right_step_count: rightSteps.length,
    diffs,
    ...(shorter
      ? {
          common_prefix: {
            shorter,
            last_common_step: lastCommon,
            missing_steps: longSteps.length - shortSteps.length,
          },
        }
      : {}),
  };
}

// ── AI-Powered Diff Analysis ────────────────────────────────────────────

export interface AiDiffAnalysis {
  explanation: string;
  /**
   * The model's verdict, or `unknown` when it did not give one — a reply that
   * could not be parsed, or one naming something outside the three options.
   * `neither` is a real verdict ("both runs are equivalent") and stopped being
   * the fallback for "no answer", which reported a judgement nobody made.
   */
  better_trace: 'left' | 'right' | 'neither' | 'unknown';
  reasoning: string;
  key_differences: string[];
  /**
   * How many of the comparison's divergences the model was shown, when it was
   * not all of them. The summary lists the first 15 and tells the MODEL "and N
   * more"; without these the reader was handed a verdict about "the
   * comparison" formed over 15 of 4,178 differences (measured on a real pair).
   * Absent when the model saw everything, so an ordinary analysis is unchanged.
   */
  diffs_shown?: number;
  diffs_total?: number;
  cost: { tokens_used: number; cost_usd: number; rate_unknown?: boolean };
}

const DIFF_SYSTEM_PROMPT_BODY = `You are comparing two AI agent execution traces. Analyze the differences and explain:
1. WHY the traces diverged (not just what is different, but the likely cause)
2. Which trace produced a better outcome and why
3. Key takeaways for improving the agent

Respond in this exact JSON format (no other text):
{
  "explanation": "paragraph explaining why traces diverged",
  "better_trace": "left|right|neither",
  "reasoning": "why one is better",
  "key_differences": ["diff1", "diff2", "diff3"]
}`;

const DIFF_SYSTEM_PROMPT = DIFF_SYSTEM_PROMPT_BODY + INJECTION_GUARD;

export async function aiDiffAnalysis(
  db: Database.Database,
  leftTraceId: string,
  rightTraceId: string,
  llmOpts: LlmClientOptions,
): Promise<AiDiffAnalysis> {
  const leftTrace = getTrace(db, leftTraceId);
  const rightTrace = getTrace(db, rightTraceId);
  if (!leftTrace) throw new Error(`Trace ${leftTraceId} not found`);
  if (!rightTrace) throw new Error(`Trace ${rightTraceId} not found`);

  const diff = diffTraces(db, leftTraceId, rightTraceId);
  const summary = summarizeDiffForLlm(diff, leftTrace, rightTrace);

  const response = await callLlm(llmOpts, {
    system: DIFF_SYSTEM_PROMPT,
    // Fenced and injection-guarded exactly like the eval path: this summary is
    // built from agent prompts, tool inputs and TOOL OUTPUTS, so a tool result
    // reading "ignore previous instructions…" otherwise landed in instruction
    // position, and its answer was printed as this tool's verdict.
    prompt: `Analyze this trace comparison:\n\n${fenceTraceContent(summary.text)}`,
    // The caller's configured ceiling wins, exactly as on the eval path. A
    // request-level `max_tokens` OVERRIDES `opts.max_tokens` in callLlm, so the
    // hard 1024 here made `config set ai.max_tokens` — validated, stored, and
    // honored by `eval --ai` — do nothing at all for `diff --ai`. A comparison
    // with many differences then returned a truncated reply, `extractJson`
    // threw, and the catch below substituted `better_trace: "neither"` with
    // "Could not parse structured response": a verdict the model never gave,
    // billed in full, with no supported way to raise the ceiling.
    max_tokens: llmOpts.max_tokens ?? DEFAULT_EVAL_MAX_TOKENS,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(response.text);
  } catch {
    // No verdict was given, so none is reported. `better_trace: 'neither'` used
    // to fill this slot, which reads as the model having weighed both runs and
    // called them equal — a judgement it never made. `unknown` is rendered in
    // the same place and cannot be mistaken for one.
    //
    // When the provider says it stopped at the ceiling, say that and name the
    // flag that fixes it: an unparseable answer is the EXPECTED result of a
    // JSON object cut off mid-write, and the caller was left to guess.
    parsed = {
      explanation: truncate(response.text, 500),
      better_trace: 'unknown',
      reasoning: response.truncated
        ? `The model's answer was cut off at the ${llmOpts.max_tokens ?? DEFAULT_EVAL_MAX_TOKENS}-token ceiling, so it could not be parsed. Re-run with a larger --max-tokens.`
        : 'Could not parse structured response',
      key_differences: [],
    };
  }

  return {
    explanation: String(parsed.explanation ?? ''),
    better_trace: (['left', 'right', 'neither', 'unknown'].includes(String(parsed.better_trace))
      ? String(parsed.better_trace) as AiDiffAnalysis['better_trace']
      // An answer outside the options is not a verdict for `neither`, which is
      // itself one of the options the model was offered.
      : 'unknown'),
    reasoning: String(parsed.reasoning ?? ''),
    key_differences: Array.isArray(parsed.key_differences)
      ? (parsed.key_differences as string[]).map(String)
      : [],
    ...(summary.diffs_total != null && summary.diffs_shown != null && summary.diffs_shown < summary.diffs_total
      ? { diffs_shown: summary.diffs_shown, diffs_total: summary.diffs_total }
      : {}),
    cost: {
      tokens_used: response.input_tokens + response.output_tokens,
      cost_usd: response.cost_estimate_usd,
      // Whether that figure is the model's own rate or the fallback. This build
      // knows a rate for three models, all cheap-tier defaults, so for anything
      // else the number is a FLOOR — and printed to six decimals it reads as a
      // measurement. The eval path records the same distinction.
      ...(modelRateIsKnown(response.model) ? {} : { rate_unknown: true }),
    },
  };
}
