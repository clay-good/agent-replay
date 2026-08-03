import type Database from 'better-sqlite3';
import type { TraceDiffResult, StepDiff } from '../models/types.js';
import type { LlmClientOptions } from './llm-client.js';
import { callLlm } from './llm-client.js';
import { getTrace } from './trace-service.js';
import { summarizeDiffForLlm } from './trace-summarizer.js';
import { extractJson } from './eval-service.js';
import { stableStringify } from './check-service.js';
import { safeParseJson } from '../utils/json.js';

/**
 * Compare two traces step-by-step, identifying the divergence point and
 * all field-level differences.
 *
 * Adapted from proxilion-managed-main/crates/agent-replay/src/services.rs
 * compute_diff (lines 192-300).
 */
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

  return {
    left_trace_id: leftTraceId,
    right_trace_id: rightTraceId,
    divergence_step,
    left_step_count: leftSteps.length,
    right_step_count: rightSteps.length,
    diffs,
  };
}

// ── AI-Powered Diff Analysis ────────────────────────────────────────────

export interface AiDiffAnalysis {
  explanation: string;
  better_trace: 'left' | 'right' | 'neither';
  reasoning: string;
  key_differences: string[];
  cost: { tokens_used: number; cost_usd: number };
}

const DIFF_SYSTEM_PROMPT = `You are comparing two AI agent execution traces. Analyze the differences and explain:
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
    prompt: `Analyze this trace comparison:\n\n${summary.text}`,
    max_tokens: 1024,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(response.text);
  } catch {
    parsed = {
      explanation: response.text.slice(0, 500),
      better_trace: 'neither',
      reasoning: 'Could not parse structured response',
      key_differences: [],
    };
  }

  return {
    explanation: String(parsed.explanation ?? ''),
    better_trace: (['left', 'right', 'neither'].includes(String(parsed.better_trace))
      ? String(parsed.better_trace) as 'left' | 'right' | 'neither'
      : 'neither'),
    reasoning: String(parsed.reasoning ?? ''),
    key_differences: Array.isArray(parsed.key_differences)
      ? (parsed.key_differences as string[]).map(String)
      : [],
    cost: {
      tokens_used: response.input_tokens + response.output_tokens,
      cost_usd: response.cost_estimate_usd,
    },
  };
}
