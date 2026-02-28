import { TRACE_STATUSES, STEP_TYPES, TRIGGER_TYPES, EVAL_TYPES, GUARD_ACTIONS } from '../models/enums.js';
import type { TraceStatus, StepType, TriggerType, EvalType, GuardAction } from '../models/enums.js';
import type { IngestTraceInput, IngestStepInput } from '../models/types.js';

// ── Type guards ──────────────────────────────────────────────────────────────

export function isValidStatus(value: string): value is TraceStatus {
  return (TRACE_STATUSES as readonly string[]).includes(value);
}

export function isValidStepType(value: string): value is StepType {
  return (STEP_TYPES as readonly string[]).includes(value);
}

export function isValidTrigger(value: string): value is TriggerType {
  return (TRIGGER_TYPES as readonly string[]).includes(value);
}

export function isValidEvalType(value: string): value is EvalType {
  return (EVAL_TYPES as readonly string[]).includes(value);
}

export function isValidGuardAction(value: string): value is GuardAction {
  return (GUARD_ACTIONS as readonly string[]).includes(value);
}

// ── Validation result ────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ── Trace input validation ───────────────────────────────────────────────────

export function validateTraceInput(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (input == null || typeof input !== 'object') {
    return { valid: false, errors: [{ field: 'root', message: 'Input must be an object' }] };
  }

  const data = input as Record<string, unknown>;

  // Required fields
  if (!data.agent_name || typeof data.agent_name !== 'string') {
    errors.push({ field: 'agent_name', message: 'agent_name is required and must be a string' });
  }

  // Optional enum fields
  if (data.status != null && typeof data.status === 'string' && !isValidStatus(data.status)) {
    errors.push({
      field: 'status',
      message: `Invalid status "${data.status}". Must be one of: ${TRACE_STATUSES.join(', ')}`,
    });
  }

  if (data.trigger != null && typeof data.trigger === 'string' && !isValidTrigger(data.trigger)) {
    errors.push({
      field: 'trigger',
      message: `Invalid trigger "${data.trigger}". Must be one of: ${TRIGGER_TYPES.join(', ')}`,
    });
  }

  // Numeric fields — must be finite non-negative numbers
  if (data.total_duration_ms != null) {
    if (typeof data.total_duration_ms !== 'number' || !Number.isFinite(data.total_duration_ms) || data.total_duration_ms < 0) {
      errors.push({ field: 'total_duration_ms', message: 'total_duration_ms must be a non-negative finite number' });
    }
  }
  if (data.total_tokens != null) {
    if (typeof data.total_tokens !== 'number' || !Number.isFinite(data.total_tokens) || data.total_tokens < 0) {
      errors.push({ field: 'total_tokens', message: 'total_tokens must be a non-negative finite number' });
    }
  }
  if (data.total_cost_usd != null) {
    if (typeof data.total_cost_usd !== 'number' || !Number.isFinite(data.total_cost_usd) || data.total_cost_usd < 0) {
      errors.push({ field: 'total_cost_usd', message: 'total_cost_usd must be a non-negative finite number' });
    }
  }

  // Tags — must be an array of strings
  if (data.tags != null) {
    if (!Array.isArray(data.tags)) {
      errors.push({ field: 'tags', message: 'tags must be an array' });
    } else if (data.tags.some((t: unknown) => typeof t !== 'string')) {
      errors.push({ field: 'tags', message: 'all tags must be strings' });
    }
  }

  // Steps
  if (data.steps != null) {
    if (!Array.isArray(data.steps)) {
      errors.push({ field: 'steps', message: 'steps must be an array' });
    } else {
      for (let i = 0; i < data.steps.length; i++) {
        const stepResult = validateStepInput(data.steps[i], i);
        errors.push(...stepResult.errors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Step input validation ────────────────────────────────────────────────────

export function validateStepInput(input: unknown, index?: number): ValidationResult {
  const errors: ValidationError[] = [];
  const prefix = index != null ? `steps[${index}].` : '';

  if (input == null || typeof input !== 'object') {
    return { valid: false, errors: [{ field: `${prefix}root`, message: 'Step must be an object' }] };
  }

  const data = input as Record<string, unknown>;

  // Required fields
  if (data.step_number == null || typeof data.step_number !== 'number' || !Number.isInteger(data.step_number) || data.step_number < 1) {
    errors.push({ field: `${prefix}step_number`, message: 'step_number is required and must be a positive integer' });
  }

  if (!data.step_type || typeof data.step_type !== 'string') {
    errors.push({ field: `${prefix}step_type`, message: 'step_type is required and must be a string' });
  } else if (!isValidStepType(data.step_type)) {
    errors.push({
      field: `${prefix}step_type`,
      message: `Invalid step_type "${data.step_type}". Must be one of: ${STEP_TYPES.join(', ')}`,
    });
  }

  if (!data.name || typeof data.name !== 'string') {
    errors.push({ field: `${prefix}name`, message: 'name is required and must be a string' });
  }

  // Optional numeric fields — must be finite non-negative
  if (data.duration_ms != null) {
    if (typeof data.duration_ms !== 'number' || !Number.isFinite(data.duration_ms) || data.duration_ms < 0) {
      errors.push({ field: `${prefix}duration_ms`, message: 'duration_ms must be a non-negative finite number' });
    }
  }
  if (data.tokens_used != null) {
    if (typeof data.tokens_used !== 'number' || !Number.isFinite(data.tokens_used) || data.tokens_used < 0) {
      errors.push({ field: `${prefix}tokens_used`, message: 'tokens_used must be a non-negative finite number' });
    }
  }

  return { valid: errors.length === 0, errors };
}
