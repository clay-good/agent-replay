import ora, { type Ora, type Options as OraOptions } from 'ora';
import type { StepType } from '../models/enums.js';

// ── Spinner text per step type ────────────────────────────────────────────

const STEP_SPINNER_TEXT: Record<StepType, string> = {
  thought: 'Thinking...',
  tool_call: 'Calling tool...',
  llm_call: 'Waiting for LLM...',
  retrieval: 'Searching...',
  output: 'Generating output...',
  decision: 'Deciding...',
  error: 'Processing error...',
  guard_check: 'Checking guardrails...',
};

const STEP_SPINNER_TYPE: Record<StepType, string> = {
  thought: 'dots',
  tool_call: 'arrow3',
  llm_call: 'bouncingBall',
  retrieval: 'dots2',
  output: 'dots',
  decision: 'dots3',
  error: 'dots',
  guard_check: 'dots',
};

// ── Public API ────────────────────────────────────────────────────────────

export function startSpinner(text: string): Ora {
  return ora({
    text,
    color: 'cyan',
  }).start();
}

export function stepSpinner(stepType: StepType): Ora {
  return ora({
    text: STEP_SPINNER_TEXT[stepType] ?? 'Processing...',
    spinner: (STEP_SPINNER_TYPE[stepType] ?? 'dots') as OraOptions['spinner'],
    color: 'cyan',
  }).start();
}

export function successSpinner(spinner: Ora, text: string): void {
  spinner.succeed(text);
}

export function failSpinner(spinner: Ora, text: string): void {
  spinner.fail(text);
}

export function warnSpinner(spinner: Ora, text: string): void {
  spinner.warn(text);
}
