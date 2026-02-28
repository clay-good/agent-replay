import type {
  TraceStatus,
  StepType,
  EvalType,
  TriggerType,
  GuardAction,
} from './enums.js';

// ── Core Entities ─────────────────────────────────────────────────────────

/** A complete agent execution trace. */
export interface Trace {
  id: string;
  agent_name: string;
  agent_version: string | null;
  trigger: TriggerType;
  status: TraceStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  total_duration_ms: number | null;
  total_tokens: number | null;
  total_cost_usd: number | null;
  error: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  parent_trace_id: string | null;
  forked_from_step: number | null;
  created_at: string;
}

/** A single step within a trace. */
export interface TraceStep {
  id: string;
  trace_id: string;
  step_number: number;
  step_type: StepType;
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  tokens_used: number | null;
  model: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

/** Frozen state snapshot at a specific step. */
export interface TraceSnapshot {
  id: string;
  step_id: string;
  context_window: unknown;
  environment: Record<string, unknown>;
  tool_state: Record<string, unknown>;
  token_count: number;
}

/** Evaluation result for a trace. */
export interface EvalResult {
  id: string;
  trace_id: string;
  evaluator_type: EvalType;
  evaluator_name: string;
  score: number;
  passed: boolean;
  details: Record<string, unknown>;
  evaluated_at: string;
}

/** A guardrail policy definition. */
export interface GuardrailPolicy {
  id: string;
  name: string;
  description: string | null;
  action: GuardAction;
  priority: number;
  enabled: boolean;
  match_pattern: Record<string, unknown>;
  action_params: Record<string, unknown> | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

// ── Composite / Response Types ────────────────────────────────────────────

/** A trace with its steps and evaluations. */
export interface TraceWithDetails extends Trace {
  steps: TraceStep[];
  evals: EvalResult[];
}

// ── Ingest Input Types ────────────────────────────────────────────────────

export interface IngestSnapshotInput {
  context_window?: unknown;
  environment?: Record<string, unknown>;
  tool_state?: Record<string, unknown>;
  token_count?: number;
}

export interface IngestStepInput {
  step_number: number;
  step_type: string;
  name: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  started_at?: string;
  ended_at?: string | null;
  duration_ms?: number | null;
  tokens_used?: number | null;
  model?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  snapshot?: IngestSnapshotInput;
}

export interface IngestTraceInput {
  agent_name: string;
  agent_version?: string | null;
  trigger?: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  started_at?: string;
  ended_at?: string | null;
  total_duration_ms?: number | null;
  total_tokens?: number | null;
  total_cost_usd?: number | null;
  error?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  steps?: IngestStepInput[];
}

// ── Update Types ──────────────────────────────────────────────────────────

export interface UpdateTraceInput {
  status?: string;
  output?: Record<string, unknown>;
  ended_at?: string;
  total_duration_ms?: number;
  total_tokens?: number;
  total_cost_usd?: number;
  error?: string;
}

export interface CreateEvalInput {
  evaluator_type: string;
  evaluator_name: string;
  score: number;
  passed: boolean;
  details?: Record<string, unknown>;
}

// ── Diff Types ────────────────────────────────────────────────────────────

export interface StepDiff {
  step_number: number;
  field: string;
  left_value: unknown;
  right_value: unknown;
}

export interface TraceDiffResult {
  left_trace_id: string;
  right_trace_id: string;
  divergence_step: number | null;
  left_step_count: number;
  right_step_count: number;
  diffs: StepDiff[];
}

// ── Fork Types ────────────────────────────────────────────────────────────

export interface ForkResult {
  original_trace_id: string;
  forked_trace_id: string;
  forked_from_step: number;
  steps_copied: number;
}

// ── Filter / Query Types ──────────────────────────────────────────────────

export interface ListTracesFilter {
  status?: string;
  agent_name?: string;
  tag?: string;
  since?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
