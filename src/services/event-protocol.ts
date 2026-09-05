import type { IngestDecisionInput, IngestSnapshotInput } from '../models/types.js';
import { STEP_TYPES, TRACE_STATUSES } from '../models/enums.js';
import { decisionOptionProblem, isValidConfidence } from '../utils/validators.js';
import { escapeForMessage, truncate } from '../utils/json.js';

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

/**
 * Terminal statuses a producer might reasonably write, folded onto the four the
 * schema stores. Case-insensitive, because a case difference (`"Failed"`) is
 * not a different outcome.
 *
 * This exists so a value we CAN read is treated as the producer's declaration
 * rather than as something we failed to parse — the distinction `run` needs in
 * order to know when its own exit code should decide instead.
 */
const STATUS_SYNONYMS: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  completed: 'completed', complete: 'completed', success: 'completed', succeeded: 'completed',
  ok: 'completed', done: 'completed', finished: 'completed', passed: 'completed',
  failed: 'failed', failure: 'failed', fail: 'failed', error: 'failed', errored: 'failed',
  crashed: 'failed', aborted: 'failed', cancelled: 'failed', canceled: 'failed',
  interrupted: 'failed',
  timeout: 'timeout', timed_out: 'timeout', timedout: 'timeout',
  running: 'running',
});


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
  /**
   * A field this validator REPAIRED rather than took at face value.
   *
   * `status` here means the producer's terminal status was unusable and was
   * rewritten to `failed`. That distinction matters to `run`, which holds
   * ground truth the stream does not: a repaired value must not count as the
   * child DECLARING its outcome, or a child that emits an unrecognized status
   * and then exits 0 suppresses the exit-code finalization and is stored as a
   * failure with no error text.
   */
  repaired?: 'status';
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
    return { event: null, warning: `skipped: unknown event type "${escapeForMessage(String(e.type))}"` };
  }
  if (e.v != null && e.v !== EVENT_PROTOCOL_VERSION) {
    return { event: null, warning: `skipped: unsupported protocol version ${escapeForMessage(String(e.v))}` };
  }

  const type = e.type as EventType;
  /** Set when a trace_end carried a status we could not read at all. */
  let unusableStatus: string | null = null;
  /** Set when a trace_end's status was a recognizable synonym we normalized. */
  let mappedStatus: string | null = null;

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

  // A terminal status the schema does not know is REPORTED, not silently taken.
  // `validateEvent` is the door both the JSONL stream and the SDK's emit() pass
  // through, and it checked step_type, name, tags and confidence but never
  // this — so `endTrace({status: 'Failed'})` (a case difference) sailed past the
  // "an SDK call throws rather than silently drops" contract, and the stream
  // path applied it with zero warnings. `ingest` rejects the identical value.
  if (type === 'trace_end' && e.status != null) {
    // Try to UNDERSTAND the value before repairing it. A flat "anything
    // unrecognized becomes failed, and the wrapper's exit code then overrides
    // it" laundered `status: "error"` + exit 0 straight back into `completed`,
    // reopening the fail-open it was written to close — and agents that report
    // failure in-band while exiting 0 are the common shape. A value that maps
    // to a known status is a DECLARATION (kept, and `run` honours it); only a
    // value that maps to nothing is a repair the exit code gets to decide.
    // A null-prototype table, AND a string check on the result. A plain object
    // literal resolves inherited keys, so `status: "constructor"` returned
    // Object's constructor — a FUNCTION assigned to a field typed string, with
    // the native-code source echoed into the operator's warning and the repair
    // marker left unset, so `run` treated it as a declaration.
    const mapped = typeof e.status === 'string' ? STATUS_SYNONYMS[e.status.trim().toLowerCase()] : undefined;
    if (typeof mapped === 'string') {
      if (mapped !== e.status) mappedStatus = String(e.status);
      e.status = mapped;
    } else if (typeof e.status !== 'string' || !(TRACE_STATUSES as readonly string[]).includes(e.status)) {
      // Repaired, not dropped — one unusable FIELD must not cost the event.
      // Rejecting the whole `trace_end` threw away the run's output, tokens and
      // ended_at, and left the trace to be finalized as a timeout: trading a
      // fail-open for data loss. The precedent in this function is the numeric
      // drop below, which warns and keeps.
      //
      // `failed`, not `completed`: an unreadable terminal status is not evidence
      // the run succeeded, and the evaluators read this field.
      unusableStatus = String(e.status);
      e.status = 'failed';
    }
  }

  if (type === 'step_start' || type === 'step') {
    // A NON-EMPTY name: `ingest` requires one, so an empty string was a step this
    // tool wrote that its own re-ingest refuses.
    if (typeof e.step_type !== 'string' || typeof e.name !== 'string' || !e.name) {
      return { event: null, warning: `skipped: ${type} requires step_type and a non-empty name` };
    }
    // Reject an unknown step_type here — it would otherwise fail the DB CHECK
    // constraint inside appendStep and (in a batch ingest) abort the trace.
    if (!(STEP_TYPES as readonly string[]).includes(e.step_type)) {
      return { event: null, warning: `skipped: ${type} has invalid step_type "${escapeForMessage(String(e.step_type))}"` };
    }
  }
  // Tags must be strings, not merely an array: `insertTraceRow` coerces the
  // CONTAINER but never the elements, so `tags: [1, {x: 2}]` was stored and then
  // rejected by `ingest` ("all tags must be strings").
  if (e.tags != null) {
    if (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== 'string')) {
      return { event: null, warning: `skipped: ${type} tags must all be strings` };
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
  // `confidence` is held to ingest's rule too — same shared-function treatment
  // as `options`, for the same reason: the live path stored any number while
  // ingest refuses anything outside [0, 1], so `record` wrote traces that could
  // not be restored from their own export.
  const decisionOf = type === 'decision' ? e : (e.decision as Record<string, unknown> | null | undefined);
  const confidence = decisionOf?.confidence;
  let droppedConfidence = false;
  if (confidence != null && !isValidConfidence(confidence)) {
    // DROPPED, not rejected — the rule this function applies to every other
    // unusable field (the status repair above, the five numeric fields and the
    // four causal references below): one bad field must not cost the event.
    // This one skipped the whole step, so a producer sending `confidence: 99`
    // lost the decision itself — the chosen option, its options and rationale,
    // the very record the tool exists to explain — over a single number. Its
    // sibling `decided_by` is normalized on this same path rather than
    // rejected, and the persistence layer drops an out-of-range confidence to
    // null for exactly this reason ("one unusable field should not cost the
    // whole decision"). Dropping still satisfies what the check was added for:
    // `null` is a legal confidence, so the trace re-ingests from its own export.
    delete decisionOf!.confidence;
    droppedConfidence = true;
  }
  if (opts != null) {
    if (!Array.isArray(opts)) {
      return { event: null, warning: `skipped: ${type} decision options must be an array` };
    }
    // The SAME rule `ingest` applies (one exported function, not a second copy):
    // otherwise `record` stores an options array `ingest` rejects, and a trace
    // this tool wrote cannot be restored from its own export.
    for (const o of opts) {
      const problem = decisionOptionProblem(o);
      if (problem) return { event: null, warning: `skipped: ${type} decision options: ${problem.message}` };
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
  // A causal reference that does not point strictly EARLIER is not a
  // reference. `appendStep` already refuses to store one — `causalWalk`'s
  // contract depends on the graph being acyclic, and a forward reference made
  // `why` present time-travelling causality as fact ("step 1 caused by #2") —
  // but it dropped the value in silence. `ingest` rejects the same input
  // loudly, with the field named, so the live path was the one door where a
  // producer could send a reference, be told nothing, and find it missing.
  // Same treatment as the numeric fields above: drop the field, keep the step,
  // and say which field went.
  const droppedRefs: string[] = [];
  const stepNo = (e as { step_number?: unknown }).step_number;
  if (typeof stepNo === 'number') {
    for (const field of ['parent_step', 'caused_by_step', 'parent_step_number', 'caused_by_step_number'] as const) {
      const v = (e as Record<string, unknown>)[field];
      if (v == null) continue;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v >= stepNo) {
        delete (e as Record<string, unknown>)[field];
        droppedRefs.push(field);
      }
    }
  }

  if (dropped.length > 0 || droppedRefs.length > 0 || droppedConfidence) {
    return {
      event: obj as CaptureEvent,
      // Joined with a status repair when both happened: an early return here
      // swallowed the status warning entirely, so the value was rewritten with
      // no mention of it at all.
      warning: [
        unusableStatus != null
          ? `trace_end status "${escapeForMessage(unusableStatus)}" is not one of ${TRACE_STATUSES.join(', ')} — recorded as failed`
          : mappedStatus != null
            ? `trace_end status "${escapeForMessage(mappedStatus)}" read as "${(obj as { status?: string }).status}"`
            : null,
        dropped.length > 0
          ? `ignored ${dropped.join(', ')}: must be a non-negative finite number`
          : null,
        droppedRefs.length > 0
          ? `ignored ${droppedRefs.join(', ')}: must reference a strictly earlier step`
          : null,
        droppedConfidence
          ? 'ignored decision.confidence: must be a number between 0 and 1'
          : null,
      ].filter(Boolean).join('; '),
      ...(unusableStatus != null ? { repaired: 'status' as const } : {}),
    };
  }

  if (unusableStatus != null) {
    return {
      event: obj as CaptureEvent,
      warning: `trace_end status "${escapeForMessage(unusableStatus)}" is not one of ${TRACE_STATUSES.join(', ')} — recorded as failed`,
      // Only an UNREADABLE status is a repair. A recognized synonym is the
      // producer's declaration and must not hand the decision to the exit code.
      repaired: 'status',
    };
  }
  if (mappedStatus != null) {
    return {
      event: obj as CaptureEvent,
      warning: `trace_end status "${escapeForMessage(mappedStatus)}" read as "${(obj as { status?: string }).status}"`,
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
  // The MESSAGE escaper: C0, DEL and C1, plus tab and newline. This stopped at
  // DEL while the renderer had been widened to C1 — and a terminal that decodes
  // UTF-8 C1 reads U+009B as CSI, so the class stayed open through the very
  // messages that quote a producer's own bytes back at the operator. Newline is
  // escaped here and NOT in the renderer, deliberately: a preview is one line,
  // and a raw newline in it forges a second.
  const safe = escapeForMessage(s);
  // Surrogate-safe: this quotes a producer's own bytes back at the operator,
  // and a bare slice can cut an astral character in half.
  return truncate(safe, 60);
}
