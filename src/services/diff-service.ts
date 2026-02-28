import type Database from 'better-sqlite3';
import type { TraceDiffResult, StepDiff } from '../models/types.js';
import type { LlmClientOptions } from './llm-client.js';
import { callLlm } from './llm-client.js';
import { getTrace } from './trace-service.js';
import { summarizeDiffForLlm } from './trace-summarizer.js';
import { extractJson } from './eval-service.js';

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

  const maxSteps = Math.max(leftSteps.length, rightSteps.length);

  for (let i = 0; i < maxSteps; i++) {
    const left = leftSteps[i];
    const right = rightSteps[i];

    if (left && right) {
      const stepNum = left.step_number as number;

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

      if (left.input !== right.input) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'input',
          left_value: safeParseJson(left.input as string),
          right_value: safeParseJson(right.input as string),
        });
      }

      if (left.output !== right.output) {
        if (divergence_step === null) divergence_step = stepNum;
        diffs.push({
          step_number: stepNum,
          field: 'output',
          left_value: safeParseJson(left.output as string | null) ?? null,
          right_value: safeParseJson(right.output as string | null) ?? null,
        });
      }
    } else if (left && !right) {
      const stepNum = left.step_number as number;
      if (divergence_step === null) divergence_step = stepNum;
      diffs.push({
        step_number: stepNum,
        field: 'missing_right',
        left_value: left.name,
        right_value: null,
      });
    } else if (!left && right) {
      const stepNum = right.step_number as number;
      if (divergence_step === null) divergence_step = stepNum;
      diffs.push({
        step_number: stepNum,
        field: 'missing_left',
        left_value: null,
        right_value: right.name,
      });
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

function safeParseJson(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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
