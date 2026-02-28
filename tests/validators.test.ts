import { describe, it, expect } from 'vitest';
import {
  isValidStatus,
  isValidStepType,
  isValidTrigger,
  isValidEvalType,
  isValidGuardAction,
  validateTraceInput,
  validateStepInput,
} from '../src/utils/validators.js';

// ── Type guards ──────────────────────────────────────────────────────────

describe('isValidStatus', () => {
  it('accepts valid statuses', () => {
    expect(isValidStatus('running')).toBe(true);
    expect(isValidStatus('completed')).toBe(true);
    expect(isValidStatus('failed')).toBe(true);
    expect(isValidStatus('timeout')).toBe(true);
  });

  it('rejects invalid statuses', () => {
    expect(isValidStatus('pending')).toBe(false);
    expect(isValidStatus('')).toBe(false);
    expect(isValidStatus('COMPLETED')).toBe(false);
  });
});

describe('isValidStepType', () => {
  it('accepts all valid step types', () => {
    const valid = ['thought', 'tool_call', 'llm_call', 'retrieval', 'output', 'decision', 'error', 'guard_check'];
    for (const t of valid) {
      expect(isValidStepType(t)).toBe(true);
    }
  });

  it('rejects invalid step types', () => {
    expect(isValidStepType('action')).toBe(false);
    expect(isValidStepType('THOUGHT')).toBe(false);
  });
});

describe('isValidTrigger', () => {
  it('accepts valid triggers', () => {
    expect(isValidTrigger('manual')).toBe(true);
    expect(isValidTrigger('user_message')).toBe(true);
    expect(isValidTrigger('api')).toBe(true);
  });

  it('rejects invalid triggers', () => {
    expect(isValidTrigger('user')).toBe(false);
    expect(isValidTrigger('auto')).toBe(false);
  });
});

describe('isValidEvalType', () => {
  it('accepts valid eval types', () => {
    expect(isValidEvalType('rubric')).toBe(true);
    expect(isValidEvalType('llm_judge')).toBe(true);
    expect(isValidEvalType('policy_check')).toBe(true);
  });

  it('rejects invalid eval types', () => {
    expect(isValidEvalType('human')).toBe(false);
  });
});

describe('isValidGuardAction', () => {
  it('accepts valid guard actions', () => {
    expect(isValidGuardAction('allow')).toBe(true);
    expect(isValidGuardAction('deny')).toBe(true);
    expect(isValidGuardAction('warn')).toBe(true);
    expect(isValidGuardAction('require_review')).toBe(true);
  });

  it('rejects invalid guard actions', () => {
    expect(isValidGuardAction('block')).toBe(false);
  });
});

// ── validateTraceInput ───────────────────────────────────────────────────

describe('validateTraceInput', () => {
  it('accepts a minimal valid trace', () => {
    const result = validateTraceInput({ agent_name: 'test-agent' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a fully-specified trace', () => {
    const result = validateTraceInput({
      agent_name: 'test-agent',
      agent_version: '1.0',
      trigger: 'api',
      status: 'completed',
      input: { task: 'test' },
      output: { result: 'ok' },
      total_duration_ms: 1000,
      total_tokens: 500,
      total_cost_usd: 0.01,
      tags: ['test'],
      metadata: {},
      steps: [
        { step_number: 1, step_type: 'thought', name: 'think' },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects null input', () => {
    const result = validateTraceInput(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('root');
  });

  it('rejects non-object input', () => {
    const result = validateTraceInput('string');
    expect(result.valid).toBe(false);
  });

  it('rejects missing agent_name', () => {
    const result = validateTraceInput({});
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'agent_name')).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = validateTraceInput({ agent_name: 'a', status: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'status')).toBe(true);
  });

  it('rejects invalid trigger', () => {
    const result = validateTraceInput({ agent_name: 'a', trigger: 'user' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'trigger')).toBe(true);
  });

  it('rejects non-number total_duration_ms', () => {
    const result = validateTraceInput({ agent_name: 'a', total_duration_ms: 'fast' as unknown });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'total_duration_ms')).toBe(true);
  });

  it('rejects non-array tags', () => {
    const result = validateTraceInput({ agent_name: 'a', tags: 'test' as unknown });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'tags')).toBe(true);
  });

  it('validates nested steps', () => {
    const result = validateTraceInput({
      agent_name: 'a',
      steps: [
        { step_number: 1, step_type: 'invalid_type', name: 'x' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.startsWith('steps[0].'))).toBe(true);
  });

  it('rejects non-array steps', () => {
    const result = validateTraceInput({ agent_name: 'a', steps: 'not_array' as unknown });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'steps')).toBe(true);
  });

  it('collects multiple errors', () => {
    const result = validateTraceInput({
      status: 'bad',
      trigger: 'bad',
      total_tokens: 'many' as unknown,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── validateStepInput ────────────────────────────────────────────────────

describe('validateStepInput', () => {
  it('accepts a valid step', () => {
    const result = validateStepInput({
      step_number: 1,
      step_type: 'thought',
      name: 'think',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects missing step_number', () => {
    const result = validateStepInput({ step_type: 'thought', name: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('step_number'))).toBe(true);
  });

  it('rejects missing step_type', () => {
    const result = validateStepInput({ step_number: 1, name: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('step_type'))).toBe(true);
  });

  it('rejects invalid step_type', () => {
    const result = validateStepInput({ step_number: 1, step_type: 'action', name: 'x' });
    expect(result.valid).toBe(false);
  });

  it('rejects missing name', () => {
    const result = validateStepInput({ step_number: 1, step_type: 'thought' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('name'))).toBe(true);
  });

  it('rejects non-number duration_ms', () => {
    const result = validateStepInput({
      step_number: 1,
      step_type: 'thought',
      name: 'x',
      duration_ms: 'fast' as unknown,
    });
    expect(result.valid).toBe(false);
  });

  it('includes index prefix when provided', () => {
    const result = validateStepInput({ step_number: 'bad' as unknown, step_type: 'thought', name: 'x' }, 3);
    expect(result.errors[0].field).toMatch(/^steps\[3\]\./);
  });

  it('rejects null input', () => {
    const result = validateStepInput(null);
    expect(result.valid).toBe(false);
  });
});
