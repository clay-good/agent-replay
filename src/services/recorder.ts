import type Database from 'better-sqlite3';
import type { CaptureEvent } from './event-protocol.js';
import { EVENT_PROTOCOL_VERSION, validateEvent } from './event-protocol.js';
import { TRACE_STATUSES } from '../models/enums.js';
import {
  startTrace,
  appendStep,
  updateStep,
  updateTrace,
  attachDecision,
  attachSnapshot,
} from './trace-service.js';
import type { IngestDecisionInput, IngestSnapshotInput } from '../models/types.js';

/**
 * Live recorder: applies capture events to the store incrementally so a trace
 * grows step-by-step while an agent runs, ending up identical to the same run
 * ingested as one batch. See event-protocol.ts for the wire format.
 */

function isoNow(): string {
  return new Date().toISOString();
}

export interface ApplyResult {
  /** The trace this event belongs to (resolved for trace_start). */
  traceId: string;
  /**
   * Something was repaired while storing this event, and the caller should say
   * so. A dropped causal reference is the case today: silently discarding it
   * left `why` and `show --tree` disagreeing about the same trace.
   */
  warning?: string;
  /**
   * Something the caller should SAY, though nothing was repaired or dropped —
   * so it must not be counted as a warning. Today: this stream opened a trace
   * for a session the store already has one for.
   */
  note?: string;
}

/**
 * Other root traces already recorded for this session, as a note.
 *
 * Bounded: the ids of the first few, because a session with many is a
 * configuration mistake and a console line naming fifty ids helps nobody.
 */
function otherSessionTraces(db: Database.Database, sessionId: unknown, selfId: string): string | undefined {
  // Typed `unknown`, and checked: this value came off an untrusted stream, and
  // a producer that sends `session_id: {nested: 1}` is a case this file already
  // stores defensively rather than crashing on. Handing that object to a bound
  // parameter throws `RangeError: Too few parameter values were provided` —
  // which would take down a capture over a NOTE, the least important thing here.
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const rows = db
    .prepare(
      `SELECT id FROM agent_traces
        WHERE session_id = ? AND id != ? AND parent_trace_id IS NULL
        ORDER BY started_at ASC LIMIT 4`,
    )
    .all(sessionId, selfId) as Array<{ id: string }>;
  if (rows.length === 0) return undefined;
  const ids = rows.slice(0, 3).map((r) => r.id).join(', ');
  const more = rows.length > 3 ? ', …' : '';
  return `session ${sessionId} already has a trace in this store (${ids}${more}); this stream opened another, and every store-wide count includes both.`;
}

/**
 * Apply one validated capture event. Mutations are small and self-contained;
 * callers that consume an untrusted stream should wrap this in try/catch and
 * surface failures as per-event warnings rather than aborting the stream.
 */
export function applyEvent(db: Database.Database, event: CaptureEvent): ApplyResult {
  switch (event.type) {
    case 'trace_start': {
      const trace = startTrace(
        db,
        {
          agent_name: event.agent_name,
          agent_version: event.agent_version ?? null,
          trigger: event.trigger,
          input: event.input,
          session_id: event.session_id ?? null,
          tags: event.tags,
          metadata: event.metadata,
          started_at: event.started_at,
          status: 'running',
        },
        { id: event.trace_id },
      );
      // Say when this session is already in the store.
      //
      // Nothing correlates capture paths: the hook adapter finds its OWN open
      // trace for a session, the OTel receiver merges only within its own source
      // format, and this recorder opens a trace unconditionally. So a stream
      // carrying the session id of a run captured another way — the hook on a
      // live session, a previous `record` of the same session — adds a second
      // trace with the same session id, and every store-wide count includes
      // both. A note, not a warning: nothing was repaired or dropped, and the
      // two captures may hold different things.
      const note = otherSessionTraces(db, event.session_id, trace.id);
      return { traceId: trace.id, ...(note ? { note } : {}) };
    }

    case 'step_start': {
      const droppedRefs: string[] = [];
      appendStep(db, event.trace_id!, {
        step_number: event.step_number,
        step_type: event.step_type,
        name: event.name,
        input: event.input,
        model: event.model ?? null,
        started_at: event.started_at,
        parent_step: event.parent_step ?? event.parent_step_number ?? null,
        caused_by_step: event.caused_by_step ?? event.caused_by_step_number ?? null,
        metadata: event.metadata,
      }, droppedRefs);
      return {
        traceId: event.trace_id!,
        ...(droppedRefs.length > 0
          ? { warning: `ignored ${droppedRefs.join(', ')}: no such step in this trace` }
          : {}),
      };
    }

    case 'step_end': {
      updateStep(db, event.trace_id!, event.step_number, {
        output: event.output,
        error: event.error,
        ended_at: event.ended_at ?? isoNow(),
        duration_ms: event.duration_ms,
        tokens_used: event.tokens_used,
        model: event.model,
        metadata: event.metadata,
      });
      return { traceId: event.trace_id! };
    }

    case 'step': {
      const droppedRefs: string[] = [];
      appendStep(db, event.trace_id!, {
        step_number: event.step_number,
        step_type: event.step_type,
        name: event.name,
        input: event.input,
        output: event.output,
        started_at: event.started_at,
        ended_at: event.ended_at,
        duration_ms: event.duration_ms,
        tokens_used: event.tokens_used,
        model: event.model ?? null,
        error: event.error,
        metadata: event.metadata,
        parent_step: event.parent_step ?? event.parent_step_number ?? null,
        caused_by_step: event.caused_by_step ?? event.caused_by_step_number ?? null,
        decision: event.decision,
        snapshot: event.snapshot,
      }, droppedRefs);
      return {
        traceId: event.trace_id!,
        ...(droppedRefs.length > 0
          ? { warning: `ignored ${droppedRefs.join(', ')}: no such step in this trace` }
          : {}),
      };
    }

    case 'decision': {
      attachDecision(db, event.trace_id!, event.step_number, {
        options: event.options,
        chosen: event.chosen,
        rationale: event.rationale ?? null,
        confidence: event.confidence ?? null,
        decided_by: event.decided_by,
      });
      return { traceId: event.trace_id! };
    }

    case 'snapshot': {
      attachSnapshot(db, event.trace_id!, event.step_number, {
        context_window: event.context_window,
        environment: event.environment,
        tool_state: event.tool_state,
        token_count: event.token_count,
      });
      return { traceId: event.trace_id! };
    }

    case 'trace_end': {
      updateTrace(db, event.trace_id!, {
        status: event.status ?? 'completed',
        output: event.output ?? undefined,
        error: event.error ?? undefined,
        ended_at: event.ended_at ?? isoNow(),
        total_tokens: event.total_tokens ?? undefined,
        total_cost_usd: event.total_cost_usd ?? undefined,
        total_duration_ms: event.total_duration_ms ?? undefined,
      });
      return { traceId: event.trace_id! };
    }
  }
}

// ── Programmatic SDK ────────────────────────────────────────────────────────

export interface StartTraceInput {
  agent_name: string;
  agent_version?: string | null;
  trigger?: string;
  input?: Record<string, unknown>;
  session_id?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Optional client-chosen trace id (else one is generated). */
  trace_id?: string;
}

export interface StartStepInput {
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

export interface EndStepInput {
  output?: Record<string, unknown> | null;
  error?: string | null;
  ended_at?: string | null;
  duration_ms?: number | null;
  tokens_used?: number | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EndTraceInput {
  status?: string;
  output?: Record<string, unknown> | null;
  error?: string | null;
  ended_at?: string | null;
  total_tokens?: number | null;
  total_cost_usd?: number | null;
  total_duration_ms?: number | null;
}

/**
 * Record a trace directly from TypeScript, without files or a subprocess.
 * Thin wrapper over {@link applyEvent}: each method builds a `v: 1` event and
 * applies it, so SDK-recorded and stream-recorded traces are identical.
 */
export class TraceRecorder {
  private traceId: string | null = null;

  constructor(private readonly db: Database.Database) {}

  /** Open a trace (status `running`) and return its id. */
  startTrace(input: StartTraceInput): string {
    const { traceId } = this.emit({
      v: EVENT_PROTOCOL_VERSION,
      type: 'trace_start',
      trace_id: input.trace_id,
      agent_name: input.agent_name,
      agent_version: input.agent_version ?? null,
      trigger: input.trigger,
      input: input.input,
      session_id: input.session_id ?? null,
      tags: input.tags,
      metadata: input.metadata,
    });
    this.traceId = traceId;
    return traceId;
  }

  /** The current trace id, or null before startTrace. */
  get currentTraceId(): string | null {
    return this.traceId;
  }

  /**
   * Validate, then apply.
   *
   * The SDK used to call `applyEvent` directly, so `validateEvent` — where the
   * live path's rules live — never saw a programmatic event at all. The trace-id
   * guard was moved to the write for exactly this reason; every OTHER rule
   * (decision options and confidence, step_type, name, tags, negative counters)
   * was left at the parser, so the SDK could store what `ingest` refuses and the
   * trace could not be restored from its own export.
   *
   * A rejection THROWS here rather than warning: a JSONL stream is a foreign
   * producer and leniency keeps the rest of the run, but an SDK call is this
   * process's own code and a silently dropped event would be a bug it never
   * learns about.
   */
  private emit(event: CaptureEvent): ApplyResult {
    const { event: valid, warning } = validateEvent(event as unknown as Record<string, unknown>);
    if (!valid) throw new Error(`invalid capture event: ${warning ?? 'rejected'}`);
    return applyEvent(this.db, valid);
  }

  private requireTrace(): string {
    if (!this.traceId) throw new Error('TraceRecorder: startTrace must be called first');
    return this.traceId;
  }

  startStep(step: StartStepInput): void {
    this.emit({ v: EVENT_PROTOCOL_VERSION, type: 'step_start', trace_id: this.requireTrace(), ...step });
  }

  endStep(stepNumber: number, patch: EndStepInput = {}): void {
    this.emit({
      v: EVENT_PROTOCOL_VERSION,
      type: 'step_end',
      trace_id: this.requireTrace(),
      step_number: stepNumber,
      ...patch,
    });
  }

  /** Record a complete step in one call. */
  step(step: StartStepInput & EndStepInput & { decision?: IngestDecisionInput; snapshot?: IngestSnapshotInput }): void {
    this.emit({ v: EVENT_PROTOCOL_VERSION, type: 'step', trace_id: this.requireTrace(), ...step });
  }

  decision(stepNumber: number, decision: IngestDecisionInput): void {
    this.emit({
      v: EVENT_PROTOCOL_VERSION,
      type: 'decision',
      trace_id: this.requireTrace(),
      step_number: stepNumber,
      ...decision,
    });
  }

  snapshot(stepNumber: number, snapshot: IngestSnapshotInput): void {
    this.emit({
      v: EVENT_PROTOCOL_VERSION,
      type: 'snapshot',
      trace_id: this.requireTrace(),
      step_number: stepNumber,
      ...snapshot,
    });
  }

  endTrace(patch: EndTraceInput = {}): void {
    // The SDK is our own code, so a status it cannot use is a CALLER error and
    // is reported. The stream is more forgiving on purpose: it NORMALIZES a
    // recognizable spelling (`Failed`, `error`, `ok`) onto the four stored
    // statuses and only repairs what it cannot read at all, because it carries
    // a producer's data and an unusable field must not cost them their output
    // and tokens. A programmatic caller writing `endTrace({status: 'Failed'})`
    // wants to hear that the case did not match — they can spell it correctly.
    if (patch.status != null && !(TRACE_STATUSES as readonly string[]).includes(patch.status)) {
      throw new Error(`Invalid trace status "${patch.status}". Valid: ${TRACE_STATUSES.join(', ')}`);
    }
    this.emit({ v: EVENT_PROTOCOL_VERSION, type: 'trace_end', trace_id: this.requireTrace(), ...patch });
  }
}
