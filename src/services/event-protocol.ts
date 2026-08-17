import type { IngestDecisionInput, IngestSnapshotInput } from '../models/types.js';
import { STEP_TYPES } from '../models/enums.js';

/**
 * Versioned JSONL event protocol for incremental trace capture.
 *
 * Every event is a single JSON object on its own line carrying `v: 1`, a
 * `type`, and (except `trace_start`, which may assign one) a `trace_id`. The
 * producer generates the `trace_id` and stamps it on every event of a run so a
 * one-way stdin stream needs no back-channel. An unknown event TYPE is skipped
 * with a warning; an unknown FIELD is ignored silently, so a newer producer's
 * extra keys cost nothing.
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
/**
 * C0 controls, DEL and C1. An identifier never contains one; an escape sequence,
 * a NUL or a stray carriage return in one is either a mistake or an attempt to
 * address the terminal of whoever later inspects the trace.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

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
  /** Aliases matching the persisted/exported column names, so a trace replayed
   * from `show --json` / `export` re-records with its hierarchy intact — the
   * same aliases `ingestTrace` accepts. */
  parent_step_number?: number | null;
  caused_by_step_number?: number | null;
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
  /** Aliases matching the persisted/exported column names (see StepStartEvent). */
  parent_step_number?: number | null;
  caused_by_step_number?: number | null;
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
  // A producer may CHOOSE the trace id (`trace_start.trace_id`), and the id is
  // then rendered by `show`, `list`, `watch`, `why`, `decisions`, `fork` and
  // `check`, and copied into `parent_trace_id` by `fork`. Escaping it at each of
  // those render sites was tried and drifted four times — a new site, or a new
  // copy of the id, kept being missed. So reject a control character HERE, where
  // there is exactly one door: an id is an identifier, and no legitimate one
  // contains an escape sequence, a NUL or a newline. Everything downstream is
  // then safe by construction, which is what the schema does for `trigger` and
  // `status`.
  if (typeof e.trace_id === 'string' && (!e.trace_id.trim() || CONTROL_CHARS.test(e.trace_id))) {
    return { event: null, warning: `skipped: ${type} trace_id must be a non-empty identifier without control characters` };
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
  // Each option must be `{option: string, ...}`. `chosen` was validated and the
  // options array was not, so the most obvious wrong guess at this schema — a
  // plain array of strings — was stored verbatim and then CRASHED `decisions`
  // with a bare TypeError on `opt.option.replace`, aborting the command whose
  // whole job is that output and losing every later decision point in the trace.
  const optionsOf = (v: unknown): unknown =>
    type === 'decision' ? v : ((v as Record<string, unknown> | null)?.options);
  const opts = type === 'decision' ? e.options
    : type === 'step' && e.decision != null ? optionsOf(e.decision)
    : undefined;
  if (opts != null) {
    if (!Array.isArray(opts) || opts.some((o) => typeof o !== 'object' || o === null || Array.isArray(o) || typeof (o as Record<string, unknown>).option !== 'string')) {
      return { event: null, warning: `skipped: ${type} decision options must each be an object with a string "option"` };
    }
  }
  // A `step` event may carry an INLINE decision (StepEvent.decision). Validate
  // its `chosen` exactly as the top-level `decision` event above — the same
  // field, same rule. Without this, appendStep binds an undefined `chosen`
  // straight into SQL, better-sqlite3 throws, and the surrounding transaction
  // rolls back the whole step (and any inline snapshot) — a silent data loss
  // swallowed as a generic per-event warning. An empty-string `chosen` was also
  // accepted here while the top-level path rejected it; this closes that
  // asymmetry too.
  if (type === 'step' && e.decision != null) {
    const dec = e.decision as Record<string, unknown>;
    if (typeof dec !== 'object' || Array.isArray(dec) || typeof dec.chosen !== 'string' || !dec.chosen) {
      return { event: null, warning: 'skipped: step inline decision requires chosen' };
    }
  }

  // A negative or non-finite usage/timing count is not a measurement. It used to
  // be stored verbatim on this path only — the importers and the stream
  // translators both clamp — and `ingest` REJECTS such a value, so an export of
  // the resulting trace could not be restored: the round-trip the golden gate
  // depends on was broken by data this very tool wrote. Drop the field with a
  // warning rather than the whole step; every other field of it is still good.
  const dropped: string[] = [];
  for (const field of ['tokens_used', 'duration_ms', 'total_tokens', 'total_duration_ms', 'total_cost_usd'] as const) {
    const v = e[field];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      delete e[field];
      dropped.push(field);
    }
  }
  if (dropped.length > 0) {
    return {
      event: obj as CaptureEvent,
      warning: `ignored ${dropped.join(', ')}: must be a non-negative finite number`,
    };
  }

  return { event: obj as CaptureEvent, warning: null };
}

function preview(s: string): string {
  // Escape C0 controls (and DEL) before echoing. This string is by definition
  // untrusted producer output — the line we just failed to parse — and it is
  // written straight to the supervisor's terminal and CI log. A child emitting
  // ESC sequences could move the cursor, recolor, or issue OSC commands in the
  // log of the tool watching it.
  const safe = s.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return safe.length > 60 ? `${safe.slice(0, 57)}...` : safe;
}
