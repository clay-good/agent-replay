import type Database from 'better-sqlite3';
import type { CaptureEvent } from './event-protocol.js';
import { EVENT_PROTOCOL_VERSION } from './event-protocol.js';
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
      return { traceId: trace.id };
    }

    case 'step_start': {
      appendStep(db, event.trace_id!, {
        step_number: event.step_number,
        step_type: event.step_type,
        name: event.name,
        input: event.input,
        model: event.model ?? null,
        started_at: event.started_at,
        parent_step: event.parent_step ?? null,
        caused_by_step: event.caused_by_step ?? null,
        metadata: event.metadata,
      });
      return { traceId: event.trace_id! };
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
        parent_step: event.parent_step ?? null,
        caused_by_step: event.caused_by_step ?? null,
        decision: event.decision,
        snapshot: event.snapshot,
      });
      return { traceId: event.trace_id! };
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
    const { traceId } = applyEvent(this.db, {
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

  private requireTrace(): string {
    if (!this.traceId) throw new Error('TraceRecorder: startTrace must be called first');
    return this.traceId;
  }

  startStep(step: StartStepInput): void {
    applyEvent(this.db, { v: EVENT_PROTOCOL_VERSION, type: 'step_start', trace_id: this.requireTrace(), ...step });
  }

  endStep(stepNumber: number, patch: EndStepInput = {}): void {
    applyEvent(this.db, {
      v: EVENT_PROTOCOL_VERSION,
      type: 'step_end',
      trace_id: this.requireTrace(),
      step_number: stepNumber,
      ...patch,
    });
  }

  /** Record a complete step in one call. */
  step(step: StartStepInput & EndStepInput & { decision?: IngestDecisionInput; snapshot?: IngestSnapshotInput }): void {
    applyEvent(this.db, { v: EVENT_PROTOCOL_VERSION, type: 'step', trace_id: this.requireTrace(), ...step });
  }

  decision(stepNumber: number, decision: IngestDecisionInput): void {
    applyEvent(this.db, {
      v: EVENT_PROTOCOL_VERSION,
      type: 'decision',
      trace_id: this.requireTrace(),
      step_number: stepNumber,
      ...decision,
    });
  }

  snapshot(stepNumber: number, snapshot: IngestSnapshotInput): void {
    applyEvent(this.db, {
      v: EVENT_PROTOCOL_VERSION,
      type: 'snapshot',
      trace_id: this.requireTrace(),
      step_number: stepNumber,
      ...snapshot,
    });
  }

  endTrace(patch: EndTraceInput = {}): void {
    applyEvent(this.db, { v: EVENT_PROTOCOL_VERSION, type: 'trace_end', trace_id: this.requireTrace(), ...patch });
  }
}
