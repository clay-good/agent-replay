import type { IngestDecisionInput, IngestSnapshotInput } from '../models/types.js';
import { STEP_TYPES } from '../models/enums.js';

/**
 * Versioned JSONL event protocol for incremental trace capture.
 *
 * Every event is a single JSON object on its own line carrying `v: 1`, a
 * `type`, and (except `trace_start`, which may assign one) a `trace_id`. The
 * producer generates the `trace_id` and stamps it on every event of a run so a
 * one-way stdin stream needs no back-channel. Unknown event types and unknown
 * fields are ignored with a warning — forward compatibility with newer
 * producers.
 */

export const EVENT_PROTOCOL_VERSION = 1;

export const EVENT_TYPES = [
  'trace_start',
  'step_start',
  'step_end',
  'step',
  'decision',
  'snapshot',
  'trace_end',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ── Event shapes ────────────────────────────────────────────────────────────

interface BaseEvent {
  v: number;
  type: EventType;
  trace_id?: string;
}

export interface TraceStartEvent extends BaseEvent {
  type: 'trace_start';
  agent_name: string;
  agent_version?: string | null;
  trigger?: string;
  input?: Record<string, unknown>;
  session_id?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  started_at?: string;
}

export interface StepStartEvent extends BaseEvent {
  type: 'step_start';
  step_number: number;
  step_type: string;
  name: string;
  input?: Record<string, unknown>;
  model?: string | null;
  started_at?: string;
  parent_step?: number | null;
  caused_by_step?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StepEndEvent extends BaseEvent {
  type: 'step_end';
  step_number: number;
  output?: Record<string, unknown> | null;
  error?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  tokens_used?: number | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

/** A step recorded start-to-finish in one event. */
export interface StepEvent extends BaseEvent {
  type: 'step';
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
  parent_step?: number | null;
  caused_by_step?: number | null;
  decision?: IngestDecisionInput | null;
  snapshot?: IngestSnapshotInput;
}

export interface DecisionEvent extends BaseEvent {
  type: 'decision';
  step_number: number;
  options?: IngestDecisionInput['options'];
  chosen: string;
  rationale?: string | null;
  confidence?: number | null;
  decided_by?: string;
}

export interface SnapshotEvent extends BaseEvent {
  type: 'snapshot';
  step_number: number;
  context_window?: unknown;
  environment?: Record<string, unknown>;
  tool_state?: Record<string, unknown>;
  token_count?: number;
}

export interface TraceEndEvent extends BaseEvent {
  type: 'trace_end';
  status?: string;
  output?: Record<string, unknown> | null;
  error?: string | null;
  ended_at?: string | null;
  total_tokens?: number | null;
  total_cost_usd?: number | null;
  total_duration_ms?: number | null;
}

export type CaptureEvent =
  | TraceStartEvent
  | StepStartEvent
  | StepEndEvent
  | StepEvent
  | DecisionEvent
  | SnapshotEvent
  | TraceEndEvent;

// ── Parsing & validation ────────────────────────────────────────────────────

export interface ParseResult {
  event: CaptureEvent | null;
  /** Non-fatal reason the line was skipped, for a stderr warning. */
  warning: string | null;
}

/** Parse and validate a single JSONL line into a capture event. */
export function parseEventLine(line: string): ParseResult {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) {
    return { event: null, warning: null };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { event: null, warning: `skipped: invalid JSON (${preview(trimmed)})` };
  }
  return validateEvent(obj);
}

/** Validate an already-parsed object as a capture event. */
export function validateEvent(obj: unknown): ParseResult {
  if (obj == null || typeof obj !== 'object') {
    return { event: null, warning: 'skipped: event must be an object' };
  }
  const e = obj as Record<string, unknown>;

  if (typeof e.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(e.type)) {
    return { event: null, warning: `skipped: unknown event type "${String(e.type)}"` };
  }
  if (e.v != null && e.v !== EVENT_PROTOCOL_VERSION) {
    return { event: null, warning: `skipped: unsupported protocol version ${String(e.v)}` };
  }

  const type = e.type as EventType;

  // trace_start needs an agent_name; every other event needs a trace_id and,
  // for step-scoped events, a step_number.
  if (type === 'trace_start') {
    if (typeof e.agent_name !== 'string' || !e.agent_name) {
      return { event: null, warning: 'skipped: trace_start requires agent_name' };
    }
  } else {
    if (typeof e.trace_id !== 'string' || !e.trace_id) {
      return { event: null, warning: `skipped: ${type} requires trace_id` };
    }
  }

  const needsStep: EventType[] = ['step_start', 'step_end', 'step', 'decision', 'snapshot'];
  if (needsStep.includes(type)) {
    if (typeof e.step_number !== 'number' || !Number.isInteger(e.step_number) || e.step_number < 1) {
      return { event: null, warning: `skipped: ${type} requires a positive integer step_number` };
    }
  }

  if (type === 'step_start' || type === 'step') {
    if (typeof e.step_type !== 'string' || typeof e.name !== 'string') {
      return { event: null, warning: `skipped: ${type} requires step_type and name` };
    }
    // Reject an unknown step_type here — it would otherwise fail the DB CHECK
    // constraint inside appendStep and (in a batch ingest) abort the trace.
    if (!(STEP_TYPES as readonly string[]).includes(e.step_type)) {
      return { event: null, warning: `skipped: ${type} has invalid step_type "${e.step_type}"` };
    }
  }
  if (type === 'decision' && (typeof e.chosen !== 'string' || !e.chosen)) {
    return { event: null, warning: 'skipped: decision requires chosen' };
  }

  return { event: obj as CaptureEvent, warning: null };
}

function preview(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
