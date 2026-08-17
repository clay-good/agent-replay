import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, getStepSnapshot } from '../src/services/trace-service.js';
import { parseEventLine, validateEvent } from '../src/services/event-protocol.js';
import { applyEvent, TraceRecorder } from '../src/services/recorder.js';
import type { CaptureEvent } from '../src/services/event-protocol.js';
import type { IngestTraceInput, TraceWithDetails } from '../src/models/types.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

// ── Event protocol (task 2.3) ─────────────────────────────────────────────

describe('event protocol', () => {
  it('parses a valid trace_start line', () => {
    const { event, warning } = parseEventLine('{"v":1,"type":"trace_start","trace_id":"trc_x","agent_name":"a"}');
    expect(warning).toBeNull();
    expect(event?.type).toBe('trace_start');
  });

  it('skips blank and comment lines without warning', () => {
    expect(parseEventLine('   ')).toEqual({ event: null, warning: null });
    expect(parseEventLine('// note')).toEqual({ event: null, warning: null });
  });

  it('warns on invalid JSON', () => {
    const { event, warning } = parseEventLine('{not json');
    expect(event).toBeNull();
    expect(warning).toMatch(/invalid JSON/);
  });

  it('warns and skips an unknown event type', () => {
    const { event, warning } = validateEvent({ v: 1, type: 'wat', trace_id: 't' });
    expect(event).toBeNull();
    expect(warning).toMatch(/unknown event type/);
  });

  it('skips an unsupported protocol version', () => {
    const { warning } = validateEvent({ v: 2, type: 'trace_end', trace_id: 't' });
    expect(warning).toMatch(/unsupported protocol version/);
  });

  it('requires trace_id on non-start events and step_number on step events', () => {
    expect(validateEvent({ v: 1, type: 'step_end', step_number: 1 }).warning).toMatch(/requires trace_id/);
    expect(validateEvent({ v: 1, type: 'step_end', trace_id: 't' }).warning).toMatch(/step_number/);
  });

  it('rejects a step event whose inline decision has no chosen', () => {
    // An inline decision's chosen is bound straight into SQL by appendStep; a
    // missing chosen would throw and roll back the WHOLE step (and its inline
    // snapshot). Validation must catch it here — as it does a top-level decision.
    const missing = validateEvent({
      v: 1, type: 'step', trace_id: 't', step_number: 1, step_type: 'tool_call', name: 'act',
      decision: { options: [{ option: 'a' }] },
    });
    expect(missing.event).toBeNull();
    expect(missing.warning).toMatch(/inline decision requires chosen/);

    // Empty-string chosen is rejected too — the top-level decision path already
    // rejects it, so the inline path must not accept it (closing the asymmetry).
    const empty = validateEvent({
      v: 1, type: 'step', trace_id: 't', step_number: 1, step_type: 'tool_call', name: 'act',
      decision: { chosen: '' },
    });
    expect(empty.event).toBeNull();
    expect(empty.warning).toMatch(/inline decision requires chosen/);

    // A well-formed inline decision still passes, and a step with no decision is
    // unaffected.
    expect(validateEvent({
      v: 1, type: 'step', trace_id: 't', step_number: 1, step_type: 'tool_call', name: 'act',
      decision: { chosen: 'a', options: [{ option: 'a' }] },
    }).event).not.toBeNull();
    expect(validateEvent({
      v: 1, type: 'step', trace_id: 't', step_number: 1, step_type: 'tool_call', name: 'act',
    }).event).not.toBeNull();
  });
});

// ── Recorder equivalence (task 3.3) ───────────────────────────────────────

const CANONICAL: IngestTraceInput = {
  agent_name: 'recorder-agent',
  agent_version: '1.0.0',
  trigger: 'api',
  status: 'completed',
  session_id: 'sess_rec_1',
  input: { task: 'do the thing' },
  output: { result: 'done' },
  total_tokens: 900,
  steps: [
    { step_number: 1, step_type: 'thought', name: 'plan', input: { q: 'x' }, output: { p: 'y' }, tokens_used: 100 },
    {
      step_number: 2,
      step_type: 'decision',
      name: 'choose',
      caused_by_step: 1,
      tokens_used: 200,
      decision: {
        options: [{ option: 'a', score: 0.9 }, { option: 'b' }],
        chosen: 'a',
        rationale: 'a is better',
        confidence: 0.9,
        decided_by: 'agent',
      },
    },
    {
      step_number: 3,
      step_type: 'tool_call',
      name: 'act',
      parent_step: 2,
      caused_by_step: 2,
      model: 'gpt-x',
      output: { ok: true },
      tokens_used: 600,
    },
  ],
};

/** A structural view that ignores generated ids and timestamps. */
function normalize(t: TraceWithDetails) {
  return {
    agent_name: t.agent_name,
    status: t.status,
    session_id: t.session_id,
    input: t.input,
    output: t.output,
    total_tokens: t.total_tokens,
    steps: t.steps.map((s) => ({
      step_number: s.step_number,
      step_type: s.step_type,
      name: s.name,
      input: s.input,
      output: s.output,
      tokens_used: s.tokens_used,
      model: s.model,
      parent_step_number: s.parent_step_number,
      caused_by_step_number: s.caused_by_step_number,
      decision: s.decision
        ? {
            options: s.decision.options,
            chosen: s.decision.chosen,
            rationale: s.decision.rationale,
            confidence: s.decision.confidence,
            decided_by: s.decision.decided_by,
          }
        : null,
    })),
  };
}

function eventStream(): CaptureEvent[] {
  const tid = 'trc_stream_1';
  return [
    { v: 1, type: 'trace_start', trace_id: tid, agent_name: 'recorder-agent', agent_version: '1.0.0', trigger: 'api', session_id: 'sess_rec_1', input: { task: 'do the thing' } },
    { v: 1, type: 'step_start', trace_id: tid, step_number: 1, step_type: 'thought', name: 'plan', input: { q: 'x' } },
    { v: 1, type: 'step_end', trace_id: tid, step_number: 1, output: { p: 'y' }, tokens_used: 100 },
    { v: 1, type: 'step_start', trace_id: tid, step_number: 2, step_type: 'decision', name: 'choose', caused_by_step: 1 },
    { v: 1, type: 'decision', trace_id: tid, step_number: 2, options: [{ option: 'a', score: 0.9 }, { option: 'b' }], chosen: 'a', rationale: 'a is better', confidence: 0.9, decided_by: 'agent' },
    { v: 1, type: 'step_end', trace_id: tid, step_number: 2, tokens_used: 200 },
    { v: 1, type: 'step', trace_id: tid, step_number: 3, step_type: 'tool_call', name: 'act', parent_step: 2, caused_by_step: 2, model: 'gpt-x', output: { ok: true }, tokens_used: 600 },
    { v: 1, type: 'trace_end', trace_id: tid, status: 'completed', output: { result: 'done' }, total_tokens: 900 },
  ];
}

describe('recorder produces a trace identical to batch ingest', () => {
  it('applyEvent stream == ingestTrace', () => {
    const batch = ingestTrace(db, CANONICAL);
    let streamId = '';
    for (const ev of eventStream()) {
      streamId = applyEvent(db, ev).traceId;
    }

    const batchFull = getTrace(db, batch.id)!;
    const streamFull = getTrace(db, streamId)!;
    expect(normalize(streamFull)).toEqual(normalize(batchFull));
    expect(streamFull.status).toBe('completed');
  });

  it('honors a client-supplied trace_id and marks running until trace_end', () => {
    const s = eventStream();
    applyEvent(db, s[0]); // trace_start
    expect(getTrace(db, 'trc_stream_1')!.status).toBe('running');
    applyEvent(db, s[1]);
    applyEvent(db, s[2]);
    // Still running mid-stream
    expect(getTrace(db, 'trc_stream_1')!.status).toBe('running');
  });
});

// ── TraceRecorder SDK (task 3.2) ──────────────────────────────────────────

describe('TraceRecorder SDK', () => {
  it('records an equivalent trace through the class API', () => {
    const batch = ingestTrace(db, CANONICAL);

    const rec = new TraceRecorder(db);
    rec.startTrace({ agent_name: 'recorder-agent', agent_version: '1.0.0', trigger: 'api', session_id: 'sess_rec_1', input: { task: 'do the thing' } });
    rec.startStep({ step_number: 1, step_type: 'thought', name: 'plan', input: { q: 'x' } });
    rec.endStep(1, { output: { p: 'y' }, tokens_used: 100 });
    rec.startStep({ step_number: 2, step_type: 'decision', name: 'choose', caused_by_step: 1 });
    rec.decision(2, { options: [{ option: 'a', score: 0.9 }, { option: 'b' }], chosen: 'a', rationale: 'a is better', confidence: 0.9, decided_by: 'agent' });
    rec.endStep(2, { tokens_used: 200 });
    rec.step({ step_number: 3, step_type: 'tool_call', name: 'act', parent_step: 2, caused_by_step: 2, model: 'gpt-x', output: { ok: true }, tokens_used: 600 });
    rec.endTrace({ status: 'completed', output: { result: 'done' }, total_tokens: 900 });

    const streamFull = getTrace(db, rec.currentTraceId!)!;
    expect(normalize(streamFull)).toEqual(normalize(getTrace(db, batch.id)!));
  });

  it('throws if a step is recorded before startTrace', () => {
    const rec = new TraceRecorder(db);
    expect(() => rec.startStep({ step_number: 1, step_type: 'thought', name: 'x' })).toThrow(/startTrace/);
  });

  it('attaches a snapshot to a step via the class API', () => {
    const rec = new TraceRecorder(db);
    const id = rec.startTrace({ agent_name: 'snap-bot' });
    rec.step({ step_number: 1, step_type: 'tool_call', name: 'act' });
    rec.snapshot(1, {
      context_window: { messages: 3 },
      environment: { region: 'eu' },
      tool_state: { open: 2 },
      token_count: 1234,
    });
    rec.endTrace({ status: 'completed' });

    const snap = getStepSnapshot(db, id, 1)!;
    expect(snap.context_window).toEqual({ messages: 3 });
    expect(snap.environment).toEqual({ region: 'eu' });
    expect(snap.tool_state).toEqual({ open: 2 });
    expect(snap.token_count).toBe(1234);
  });
});

// ── Storage concurrency (task 1.2) ────────────────────────────────────────

describe('WAL concurrency', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a writer and a reader connection coexist without SQLITE_BUSY', () => {
    dir = mkdtempSync(join(tmpdir(), 'ar-wal-'));
    const path = join(dir, 'traces.db');

    const open = (): Database.Database => {
      const d = new Database(path);
      d.pragma('journal_mode = WAL');
      d.pragma('busy_timeout = 3000');
      d.pragma('foreign_keys = ON');
      return d;
    };

    const writer = open();
    runMigrations(writer);
    const reader = open();

    // Interleave: writer inserts while the reader queries the same file.
    expect(() => {
      for (let i = 0; i < 25; i++) {
        ingestTrace(writer, { agent_name: `w${i}`, steps: [{ step_number: 1, step_type: 'thought', name: 'n' }] });
        // Reader reads concurrently on a separate connection.
        reader.prepare('SELECT COUNT(*) as c FROM agent_traces').get();
      }
    }).not.toThrow();

    const count = (reader.prepare('SELECT COUNT(*) as c FROM agent_traces').get() as { c: number }).c;
    expect(count).toBe(25);

    writer.close();
    reader.close();
  });
});

describe('recorder honors the persisted-column aliases', () => {
  it('accepts parent_step_number / caused_by_step_number on a native step event', () => {
    // A trace replayed from `show --json` / `export` uses the persisted column
    // spelling. The live recorder must honor it just like batch ingest does,
    // otherwise the hierarchy/causality is silently lost on round-trip.
    const tid = 'trc_alias_1';
    const events: CaptureEvent[] = [
      { v: 1, type: 'trace_start', trace_id: tid, agent_name: 'a' },
      { v: 1, type: 'step', trace_id: tid, step_number: 1, step_type: 'thought', name: 'root' },
      { v: 1, type: 'step_start', trace_id: tid, step_number: 2, step_type: 'tool_call', name: 'viaStart', parent_step_number: 1, caused_by_step_number: 1 },
      { v: 1, type: 'step_end', trace_id: tid, step_number: 2 },
      { v: 1, type: 'step', trace_id: tid, step_number: 3, step_type: 'tool_call', name: 'viaStep', parent_step_number: 1, caused_by_step_number: 2 },
      { v: 1, type: 'trace_end', trace_id: tid, status: 'completed' },
    ];
    for (const ev of events) applyEvent(db, ev);

    const trace = getTrace(db, tid)!;
    const viaStart = trace.steps.find((s) => s.name === 'viaStart')!;
    const viaStep = trace.steps.find((s) => s.name === 'viaStep')!;
    expect(viaStart.parent_step_number).toBe(1);
    expect(viaStart.caused_by_step_number).toBe(1);
    expect(viaStep.parent_step_number).toBe(1);
    expect(viaStep.caused_by_step_number).toBe(2);
  });
});

// ── Malformed producer scalars must not cost the run ──────────────────────

/**
 * better-sqlite3 refuses to bind an object or array, and `record` swallows that
 * throw as a per-event warning. So a single malformed scalar from a producer
 * destroyed far more than the field it was on: an object `agent_version` on
 * `trace_start` lost the WHOLE trace (every later event then failed with "trace
 * not found", exit 0), and an object `total_tokens` on `trace_end` lost the
 * finalization — a run that reported `failed` with an error was persisted as
 * `timeout` with no error, misattributing a crash as a hang.
 *
 * These fields are coerced at the bind boundary now, like `trigger`, `status`
 * and `tags` already were. The ingest path validates them upstream, so the
 * coercion only ever applies to live-captured data.
 */
describe('malformed producer scalars', () => {
  it('keeps the trace when trace_start carries an object-valued scalar', () => {
    for (const field of ['agent_version', 'session_id', 'started_at']) {
      const ev = {
        v: 1, type: 'trace_start', trace_id: `trc_${field}`, agent_name: 'a',
        [field]: { nested: 1 },
      } as unknown as CaptureEvent;
      expect(() => applyEvent(db, ev)).not.toThrow();
      const t = getTrace(db, `trc_${field}`);
      expect(t).not.toBeNull();
      expect(t!.agent_name).toBe('a');
    }
  });

  it('preserves a failed status and its error when trace_end carries a bad total', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_fin', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'trace_end', trace_id: 'trc_fin', status: 'failed', error: 'crashed',
      total_tokens: { in: 5 },
    } as unknown as CaptureEvent);

    const t = getTrace(db, 'trc_fin')!;
    expect(t.status).toBe('failed');
    expect(t.error).toBe('crashed');
    expect(t.total_tokens).toBeNull(); // the bad field alone is dropped
  });

  it('keeps the step and its output when step_end carries a bad duration', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_se', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_se', step_number: 1, step_type: 'tool_call', name: 't',
    } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step_end', trace_id: 'trc_se', step_number: 1,
      duration_ms: { x: 1 }, output: { o: 1 },
    } as unknown as CaptureEvent);

    // updateStep builds one combined UPDATE, so a bad duration used to take the
    // output down with it.
    const step = getTrace(db, 'trc_se')!.steps[0];
    expect(step.output).toEqual({ o: 1 });
    expect(step.duration_ms).toBeNull();
  });

  it('keeps a step whose model or tokens_used is an object', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_sm', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_sm', step_number: 1, step_type: 'llm_call', name: 'chat',
      model: { id: 'x' }, tokens_used: [1, 2],
    } as unknown as CaptureEvent);

    const steps = getTrace(db, 'trc_sm')!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('chat');
    expect(steps[0].model).toBeNull();
    expect(steps[0].tokens_used).toBeNull();
  });

  it('accepts a numeric string for a numeric column', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_ns', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_ns', step_number: 1, step_type: 'llm_call', name: 'chat',
      tokens_used: '1234',
    } as unknown as CaptureEvent);
    expect(getTrace(db, 'trc_ns')!.steps[0].tokens_used).toBe(1234);
  });
});

// ── Causal references must point strictly earlier ─────────────────────────

/**
 * `ingest` validates that parent_step / caused_by_step reference an earlier
 * step, but the live record/SDK path passed producer values straight through —
 * and causalWalk's contract ("references are validated to point strictly
 * earlier, so the walk is acyclic") depends on it. A forward reference made
 * `why` present time-travelling causality as fact: step 1 rendered
 * "caused by #2", a step that had not happened yet.
 */
describe('step reference validation on the live path', () => {
  function twoSteps(firstCausedBy: number): TraceWithDetails {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_ref', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_ref', step_number: 1, step_type: 'llm_call', name: 'one',
      caused_by_step: firstCausedBy,
    } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_ref', step_number: 2, step_type: 'tool_call', name: 'two',
      caused_by_step: 1,
    } as CaptureEvent);
    return getTrace(db, 'trc_ref')!;
  }

  it('drops a forward caused_by reference', () => {
    const t = twoSteps(2);
    expect(t.steps[0].caused_by_step_number).toBeNull();
    // The legitimate backward reference on step 2 is untouched.
    expect(t.steps[1].caused_by_step_number).toBe(1);
  });

  it('drops a self reference', () => {
    expect(twoSteps(1).steps[0].caused_by_step_number).toBeNull();
  });

  it('drops a forward parent_step reference', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_par', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_par', step_number: 1, step_type: 'tool_call', name: 'child',
      parent_step: 5,
    } as CaptureEvent);
    expect(getTrace(db, 'trc_par')!.steps[0].parent_step_number).toBeNull();
  });

  it('keeps a valid earlier parent_step', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_ok', agent_name: 'a' } as CaptureEvent);
    applyEvent(db, { v: 1, type: 'step', trace_id: 'trc_ok', step_number: 1, step_type: 'thought', name: 'p' } as CaptureEvent);
    applyEvent(db, {
      v: 1, type: 'step', trace_id: 'trc_ok', step_number: 2, step_type: 'tool_call', name: 'c', parent_step: 1,
    } as CaptureEvent);
    expect(getTrace(db, 'trc_ok')!.steps[1].parent_step_number).toBe(1);
  });
});

describe('preview escapes control characters', () => {
  it('renders an ESC sequence from a bad line as text, not as terminal control', () => {
    // The rejected line is untrusted producer output echoed straight into the
    // supervisor's terminal and CI log, so a child could inject cursor moves,
    // color resets or OSC commands into the log of the tool watching it.
    const bad = '{"v":1,"type":"step","name":"x\u001b[31m\u0000"}garbage';
    const res = parseEventLine(bad);
    expect(res.event).toBeNull();
    expect(res.warning).not.toContain('\u001b');
    expect(res.warning).toContain('\\x1b');
  });
});
