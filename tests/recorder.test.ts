import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, getStepSnapshot, startTrace } from '../src/services/trace-service.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';

/** Feed `runRecord` a stdin stream of pre-split lines (readline needs a real stream). */
function setStdin(chunks: string[]): void {
  Object.defineProperty(process, 'stdin', {
    value: Readable.from(chunks),
    configurable: true,
  });
}
import { parseEventLine, validateEvent } from '../src/services/event-protocol.js';
import { validateStepInput } from '../src/utils/validators.js';
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

describe('record finalization contract', () => {
  it('finalizes a trace it resumed by id, but not the wrapper trace it was handed', async () => {
    // Narrowing finalization to traces this stream OPENED fixed a nested-`run`
    // case but broke the documented contract for every OTHER resumed trace:
    // "EOF with a trace still open and no --leave-open → finalized as timeout so
    // it cannot dangle silently". Only the enclosing wrapper's own trace is
    // exempt, and it is identifiable exactly — AGENT_REPLAY_TRACE_ID.
    const { runRecord } = await import('../src/commands/record.js');
    const dir = mkdtempSync(join(tmpdir(), 'ar-record-fin-'));
    const prevTraceEnv = process.env.AGENT_REPLAY_TRACE_ID;
    const prevEventsEnv = process.env.AGENT_REPLAY_EVENTS;
    try {
      const rdb = ensureDatabase(resolve(dir, 'traces.db'));
      const resumed = startTrace(rdb, { agent_name: 'resumed' });
      const wrapper = startTrace(rdb, { agent_name: 'wrapper' });
      resetConnection();

      // A LIVE wrapper: `run` removes its channel dir as it finalizes, so an
      // events file that still exists is what distinguishes an enclosing run
      // from a stale id inherited from one that already finished.
      const channel = join(dir, 'events.jsonl');
      writeFileSync(channel, '');
      process.env.AGENT_REPLAY_EVENTS = channel;
      process.env.AGENT_REPLAY_TRACE_ID = wrapper.id;
      const line = (id: string, n: number) =>
        JSON.stringify({ v: 1, type: 'step', trace_id: id, step_number: n, step_type: 'thought', name: 's' }) + '\n';
      setStdin([line(resumed.id, 1), line(wrapper.id, 1)]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runRecord({ dir });
      } finally {
        logSpy.mockRestore();
      }

      const db2 = ensureDatabase(resolve(dir, 'traces.db'));
      const statusOf = (id: string) =>
        (db2.prepare('SELECT status FROM agent_traces WHERE id = ?').get(id) as { status: string }).status;
      expect(statusOf(resumed.id)).toBe('timeout'); // cannot dangle silently
      expect(statusOf(wrapper.id)).toBe('running'); // the wrapper finalizes its own

      // A STALE id — the wrapper has finished and taken its channel with it —
      // must not exempt anything, or a legitimately resumed trace dangles.
      rmSync(channel, { force: true });
      resetConnection();
      setStdin([JSON.stringify({ v: 1, type: 'step', trace_id: wrapper.id, step_number: 2, step_type: 'thought', name: 's2' }) + '\n']);
      const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runRecord({ dir });
      } finally {
        logSpy2.mockRestore();
      }
      const db3 = ensureDatabase(resolve(dir, 'traces.db'));
      expect((db3.prepare('SELECT status FROM agent_traces WHERE id = ?').get(wrapper.id) as { status: string }).status).toBe('timeout');
    } finally {
      if (prevTraceEnv === undefined) delete process.env.AGENT_REPLAY_TRACE_ID;
      else process.env.AGENT_REPLAY_TRACE_ID = prevTraceEnv;
      if (prevEventsEnv === undefined) delete process.env.AGENT_REPLAY_EVENTS;
      else process.env.AGENT_REPLAY_EVENTS = prevEventsEnv;
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateEvent — unusable numeric fields', () => {
  // The importers and the stream translators both clamp a negative usage count,
  // but the NATIVE protocol stored it verbatim — and `ingest` rejects such a
  // value, so an export of the resulting trace could not be restored: this tool
  // wrote data its own gate refuses. The field is dropped, not the step.
  for (const bad of [-5, Infinity, NaN, '12']) {
    it(`ignores tokens_used: ${String(bad)} but keeps the step`, () => {
      const { event, warning } = validateEvent({
        v: 1, type: 'step', trace_id: 't1', step_number: 1,
        step_type: 'llm_call', name: 'call', tokens_used: bad,
      });
      expect(event).not.toBeNull();
      expect(warning).toMatch(/tokens_used/);
      expect((event as unknown as { tokens_used?: number }).tokens_used).toBeUndefined();
      expect((event as unknown as { name: string }).name).toBe('call');
    });
  }

  it('keeps a legitimate zero', () => {
    const { event, warning } = validateEvent({
      v: 1, type: 'step', trace_id: 't1', step_number: 1,
      step_type: 'llm_call', name: 'call', tokens_used: 0, duration_ms: 0,
    });
    expect(warning).toBeNull();
    expect((event as unknown as { tokens_used: number }).tokens_used).toBe(0);
  });
});

describe('validateEvent — total_cost_usd', () => {
  // `ingest` rejects a negative total_cost_usd exactly as it rejects a negative
  // token count, so storing one verbatim broke the same export → ingest round
  // trip the token clamp was added to protect — and cost is what `stats` and
  // `list --sort cost` read.
  it('drops a negative total_cost_usd from trace_end but keeps the event', () => {
    const { event, warning } = validateEvent({
      v: 1, type: 'trace_end', trace_id: 't1', status: 'completed',
      total_cost_usd: -3.5, total_tokens: 10,
    });
    expect(event).not.toBeNull();
    expect(warning).toMatch(/total_cost_usd/);
    expect((event as unknown as { total_cost_usd?: number }).total_cost_usd).toBeUndefined();
    expect((event as unknown as { total_tokens: number }).total_tokens).toBe(10);
  });

  it('keeps a legitimate cost', () => {
    const { event, warning } = validateEvent({
      v: 1, type: 'trace_end', trace_id: 't1', status: 'completed', total_cost_usd: 0.0002,
    });
    expect(warning).toBeNull();
    expect((event as unknown as { total_cost_usd: number }).total_cost_usd).toBe(0.0002);
  });
});

describe('a producer-chosen trace id cannot carry control characters', () => {
  it('rejects the event rather than storing an id that addresses the terminal', () => {
    // The id is rendered by show, list, watch, why, decisions, fork and check,
    // and copied into parent_trace_id by fork. Escaping it at each render site
    // was tried and drifted four times — a new site, or a new copy of the id,
    // kept being missed. One door instead: an identifier never contains a
    // control character, so reject it where it enters.
    const evil = `trc_\u001b]0;PWNED\u0007x`;
    const start = validateEvent({ v: 1, type: 'trace_start', trace_id: evil, agent_name: 'a' });
    expect(start.event).toBeNull();
    expect(start.warning).toMatch(/control characters/);

    const step = validateEvent({ v: 1, type: 'step', trace_id: evil, step_number: 1, step_type: 'output', name: 'n' });
    expect(step.event).toBeNull();

    // A normal id is untouched.
    const ok = validateEvent({ v: 1, type: 'trace_start', trace_id: 'trc_normal-01', agent_name: 'a' });
    expect(ok.event).not.toBeNull();
  });

  it('refuses an id that is not an identifier at all, not just one with controls', () => {
    // An EMPTY id is not nullish, so `?? generateId` did not replace it: the row
    // stored `id = ''`, and since every later event needs a non-empty trace_id
    // that trace was unreachable forever — finalized `timeout`, counted by
    // `list` and by `check`'s candidate scan, openable by nothing.
    expect(validateEvent({ v: 1, type: 'trace_start', trace_id: '', agent_name: 'a' }).event).toBeNull();
    expect(validateEvent({ v: 1, type: 'trace_start', trace_id: '   ', agent_name: 'a' }).event).toBeNull();
    expect(() =>
      startTrace(db, { agent_name: 'a', status: 'running', input: {} }, { id: '  ' }),
    ).toThrow(/non-empty identifier/);
  });

  it('rejects decision options that are not option objects', () => {
    // `chosen` was validated and the options array was not, so a plain array of
    // strings — the most obvious wrong guess at this schema — was stored and then
    // crashed `decisions` with a bare TypeError, aborting the command whose whole
    // job is that output and losing every LATER decision point in the trace.
    const bad = validateEvent({
      v: 1, type: 'step', trace_id: 'trc_d', step_number: 1, step_type: 'decision', name: 'pick',
      decision: { options: ['a', 'b'], chosen: 'a' },
    });
    expect(bad.event).toBeNull();
    expect(bad.warning).toMatch(/each option must be an object/);

    // The top-level decision event is held to the same rule...
    expect(validateEvent({
      v: 1, type: 'decision', trace_id: 'trc_d', step_number: 1, chosen: 'a', options: [{ label: 'x' }],
    }).event).toBeNull();

    // ...and the correct shape still passes, with options absent also fine.
    expect(validateEvent({
      v: 1, type: 'step', trace_id: 'trc_d', step_number: 1, step_type: 'decision', name: 'pick',
      decision: { options: [{ option: 'a', score: 1 }], chosen: 'a' },
    }).event).not.toBeNull();
    expect(validateEvent({
      v: 1, type: 'step', trace_id: 'trc_d', step_number: 2, step_type: 'decision', name: 'pick',
      decision: { chosen: 'a' },
    }).event).not.toBeNull();

    // The live path applies the SAME rule ingest does, from one exported
    // function — otherwise `record` stores what `ingest` refuses and a trace
    // cannot be restored from its own export. These two are the cases the first
    // version of the live check missed.
    for (const options of [[{ option: '' }], [{ option: 'a', score: Number.NaN }]]) {
      expect(validateEvent({
        v: 1, type: 'step', trace_id: 'trc_d', step_number: 3, step_type: 'decision', name: 'pick',
        decision: { options, chosen: 'a' },
      }).event, JSON.stringify(options)).toBeNull();
      expect(validateStepInput({
        step_number: 3, step_type: 'decision', name: 'pick',
        decision: { chosen: 'a', decided_by: 'agent', options },
      }).valid).toBe(false);
    }
    // A score of 0 is legitimate and must pass both.
    expect(validateEvent({
      v: 1, type: 'step', trace_id: 'trc_d', step_number: 4, step_type: 'decision', name: 'pick',
      decision: { options: [{ option: 'a', score: 0 }], chosen: 'a' },
    }).event).not.toBeNull();
  });

  it('holds decision confidence to ingest\'s range, like options', () => {
    // The same drift the options rule was unified to prevent, one field over:
    // the live path stored any number while ingest refuses anything outside
    // [0, 1], so `record` wrote traces that failed their own re-ingest.
    //
    // The field is DROPPED, not the step. This asserted the step was skipped —
    // but the goal above is round-trip safety, and `null` is a legal
    // confidence, so dropping reaches it without throwing away the decision
    // itself: the chosen option, the options and the rationale, the very record
    // `why` and `decisions` exist to show. That is the rule this validator
    // applies to every other unusable field (the trace_end status repair, the
    // five numeric fields, the four causal references), it is how the sibling
    // `decided_by` is already treated on this same path, and it is what the
    // persistence layer does one layer down — "one unusable field should not
    // cost the whole decision".
    const mk = (confidence: unknown) => ({
      v: 1, type: 'step', trace_id: 'trc_conf', step_number: 1,
      step_type: 'decision', name: 'p',
      decision: { chosen: 'A', options: [{ option: 'A' }], confidence },
    });
    for (const bad of [-1, 1.5, 5, Number.NaN, 'high']) {
      const { event, warning } = validateEvent(mk(bad));
      // The step survives, without the field, and the drop is reported.
      expect(event, String(bad)).not.toBeNull();
      expect((event as { decision?: Record<string, unknown> }).decision, String(bad))
        .not.toHaveProperty('confidence');
      expect((event as { decision?: { chosen?: string } }).decision?.chosen, String(bad)).toBe('A');
      expect(warning, String(bad)).toMatch(/ignored decision.confidence/);
    }
    for (const ok of [0, 0.5, 1]) {
      expect(validateEvent(mk(ok)).event, String(ok)).not.toBeNull();
    }
    // Absent is fine, and both paths agree on every one of the above.
    expect(validateEvent({
      v: 1, type: 'step', trace_id: 'trc_conf', step_number: 2,
      step_type: 'decision', name: 'p', decision: { chosen: 'A' },
    }).event).not.toBeNull();
  });

  it('accepts and rejects exactly the same option shapes as ingest does', () => {
    // Asserts AGREEMENT rather than specific verdicts: the defect this guards is
    // the two paths drifting, which is what happened when the live check was
    // written by hand instead of calling ingest's rule. A shape one path accepts
    // and the other refuses means a trace this tool wrote cannot be restored
    // from its own export.
    const shapes: Array<[string, unknown]> = [
      ['valid', [{ option: 'a' }]],
      ['score 0', [{ option: 'a', score: 0 }]],
      ['extra properties', [{ option: 'a', score: 1, rationale: 'r', extra: 'x' }]],
      ['empty array', []],
      ['absent', undefined],
      ['empty option string', [{ option: '' }]],
      ['numeric option', [{ option: 123 }]],
      ['null element', [null]],
      ['nested array', [['a']]],
      ['bare string element', ['a']],
      ['NaN score', [{ option: 'a', score: Number.NaN }]],
      ['string score', [{ option: 'a', score: 'high' }]],
      ['long list', Array.from({ length: 50 }, (_, i) => ({ option: `o${i}` }))],
    ];
    for (const [label, options] of shapes) {
      const decision = options === undefined ? { chosen: 'a' } : { chosen: 'a', options };
      const liveOk = validateEvent({
        v: 1, type: 'step', trace_id: 'trc_agree', step_number: 1,
        step_type: 'decision', name: 'pick', decision,
      }).event !== null;
      const ingestOk = validateStepInput({
        step_number: 1, step_type: 'decision', name: 'pick',
        decision: { ...decision, decided_by: 'agent' },
      }).valid;
      expect(liveOk, `live vs ingest disagree on: ${label}`).toBe(ingestOk);
    }
  });

  it('is refused on the programmatic path too, which skips the protocol parser', () => {
    // `TraceRecorder.startTrace` builds an event and calls `applyEvent`
    // directly, so `validateEvent` never sees it — the protocol parser is not
    // the single door the WRITE is. Guarded at `startTrace`, which every route
    // goes through.
    expect(() =>
      startTrace(db, { agent_name: 'a', status: 'running', input: {} }, { id: 'trc_\u001b]0;X\u0007' }),
    ).toThrow(/control characters/);
    // A normal id still opens a trace.
    expect(startTrace(db, { agent_name: 'a', status: 'running', input: {} }, { id: 'trc_fine-01' }).id).toBe('trc_fine-01');
  });
});

describe('the SDK is held to the same rules as the JSONL stream', () => {
  it('refuses what ingest would reject, instead of storing it', () => {
    // `TraceRecorder` built events and called `applyEvent` DIRECTLY, so
    // `validateEvent` — where the live path's rules live — never saw a
    // programmatic event. The trace-id guard was moved to the write for exactly
    // this reason; every other rule was left at the parser, so the SDK could
    // store traces that fail their own re-ingest.
    const r = new TraceRecorder(db);
    r.startTrace({ agent_name: 'sdk', trigger: 'manual', input: {} });

    const bad: [string, Record<string, unknown>][] = [
      // `confidence out of range` is deliberately NOT here: it is dropped with
      // a warning rather than rejected, so the decision survives. See the
      // validator test above.
      ['bare-string options', { chosen: 'x', options: ['a', 'b'] }],
      ['empty chosen', { chosen: '', options: [{ option: 'a' }] }],
    ];
    for (const [label, decision] of bad) {
      expect(
        () => r.step({ step_number: 1, step_type: 'decision', name: 'pick', input: {}, decision } as never),
        label,
      ).toThrow(/invalid capture event/);
    }
    expect(() => r.step({ step_number: 2, step_type: 'output', name: '', input: {} } as never)).toThrow();
    expect(() =>
      new TraceRecorder(db).startTrace({ agent_name: 'x', trigger: 'manual', input: {}, tags: [1] } as never),
    ).toThrow();

    // A legitimate decision is unaffected.
    expect(() =>
      r.step({
        step_number: 3, step_type: 'decision', name: 'ok', input: {},
        decision: { chosen: 'x', confidence: 0.9, options: [{ option: 'a', score: 0 }] },
      } as never),
    ).not.toThrow();

    // ...and one with an unusable confidence is recorded, minus that field.
    expect(() =>
      r.step({
        step_number: 4, step_type: 'decision', name: 'kept', input: {},
        decision: { chosen: 'x', confidence: 5, options: [{ option: 'a' }] },
      } as never),
    ).not.toThrow();
    const kept = getTrace(db, r.traceId!)!.steps.find((s) => s.step_number === 4)!;
    expect(kept.decision?.chosen).toBe('x');
    expect(kept.decision?.confidence).toBeNull();
  });
});

describe('a terminal status the schema does not know', () => {
  // Two paths, two deliberately different answers for the same value.
  //
  // The STREAM repairs it: an unusable field must not cost a producer its
  // output, tokens and ended_at. Rejecting the whole `trace_end` traded a
  // fail-open for data loss, and left the trace to be finalized as a timeout.
  it('is repaired on the stream, keeping the rest of the finalization', () => {
    // A value that maps to NOTHING. A recognizable synonym is a different case
    // — see below — because treating one as unreadable let the wrapper's exit
    // code override an outcome the child had actually stated.
    const { event, warning } = validateEvent({
      v: 1,
      type: 'trace_end',
      trace_id: 't1',
      status: 'wat',
      output: { text: 'the answer' },
      total_tokens: 500,
    });
    expect(event).not.toBeNull();
    expect(warning).toMatch(/recorded as failed/);
    // Fails CLOSED — an unreadable terminal status is not evidence of success,
    // and the deterministic evaluators read this field.
    expect((event as { status?: string }).status).toBe('failed');
    expect((event as { output?: unknown }).output).toEqual({ text: 'the answer' });
    expect((event as { total_tokens?: number }).total_tokens).toBe(500);
  });

  // A status we can READ is the producer's declaration, not a parse failure. A
  // flat "anything unrecognized becomes failed, and the exit code then decides"
  // laundered `status: "error"` + exit 0 back into `completed` — reopening the
  // fail-open the repair was written to close, on the common shape of an agent
  // that reports failure in-band while exiting 0.
  it.each([
    ['success', 'completed'],
    ['ok', 'completed'],
    ['error', 'failed'],
    ['Failed', 'failed'],
    ['aborted', 'failed'],
    ['timed_out', 'timeout'],
  ])('reads %s as %s and does not mark it repaired', (given, expected) => {
    const { event, repaired } = validateEvent({ v: 1, type: 'trace_end', trace_id: 't1', status: given });
    expect((event as { status?: string }).status).toBe(expected);
    expect(repaired).toBeUndefined();
  });

  it('leaves a recognized status alone', () => {
    const { event, warning } = validateEvent({ v: 1, type: 'trace_end', trace_id: 't1', status: 'timeout' });
    expect(warning).toBeNull();
    expect((event as { status?: string }).status).toBe('timeout');
  });

  // The SDK is our own code, so the same value is a CALLER error there: a
  // programmatic caller writing `endTrace({status: 'Failed'})` wants to hear
  // that the case did not match, not to find the run recorded as failed later.
  it('is an error from the SDK', () => {
    const rec = new TraceRecorder(db);
    rec.startTrace({ agent_name: 'a' });
    expect(() => rec.endTrace({ status: 'wat' as never })).toThrow(/Invalid trace status "wat"/);
    // A valid one still works.
    expect(() => rec.endTrace({ status: 'failed' })).not.toThrow();
  });
});

describe('warnings that quote a producer do not carry its control bytes', () => {
  // These strings are echoed to the supervisor's terminal and CI log, and they
  // quote the producer's own value back — an unknown event type, a bad
  // step_type or status, an unparsable line. The protocol's line preview
  // escaped only C0 and DEL while the renderer had been widened to C1, so two
  // guards for one concept disagreed about what a control character is; both
  // now share one definition.
  const ESC = '\u001b';
  const C1 = '\u009b';

  it.each([
    ['unknown event type', { v: 1, type: `evil${ESC}[31m${C1}2J` }],
    ['invalid step_type', { v: 1, type: 'step', trace_id: 't', step_number: 1, step_type: `q${ESC}[31m${C1}2J`, name: 'n' }],
    ['invalid status', { v: 1, type: 'trace_end', trace_id: 't', status: `x${ESC}[31m${C1}2J` }],
  ])('escapes both alphabets in the %s warning', (_label, event) => {
    const { warning } = validateEvent(event as Record<string, unknown>);
    expect(warning).toBeTruthy();
    expect(warning).not.toContain(ESC);
    expect(warning).not.toContain(C1);
    expect(warning).toContain('\\x1b');
  });

  it('escapes an unparsable line preview, ESC and C1 alike', () => {
    const { warning } = parseEventLine(`{bad${ESC}[31m${C1}2J`);
    expect(warning).toBeTruthy();
    expect(warning).not.toContain(C1);
    // ESC asserted too — it is the alphabet the preview was said to cover, and
    // the previous version of this test only checked C1.
    expect(warning).not.toContain(ESC);
  });

  // A one-line diagnostic must not let a producer forge a second line that
  // reads like this tool's own output. The renderer deliberately preserves
  // newline and tab (a multi-line error keeps its shape); a message must not.
  it('escapes a newline so a producer cannot forge a log line', () => {
    const { warning } = validateEvent({ v: 1, type: 'evil\nagent-replay run: all good' });
    expect(warning).toBeTruthy();
    expect(warning).not.toContain('\n');
    expect(warning).toContain('\\x0a');
  });

  it('escapes a producer-supplied protocol version', () => {
    const { warning } = validateEvent({ v: `9${ESC}[31m${C1}2J`, type: 'trace_end', trace_id: 't' });
    expect(warning).toMatch(/unsupported protocol version/);
    expect(warning).not.toContain(ESC);
    expect(warning).not.toContain(C1);
  });

  // A plain object literal resolves INHERITED keys, so `status: "constructor"`
  // returned Object's constructor: a function assigned to a field typed string,
  // its native-code source echoed into the warning, and the repair marker left
  // unset so `run` treated it as a declaration.
  it.each(['constructor', '__proto__', 'Constructor', 'valueOf'])(
    'does not resolve %s through the prototype chain',
    (name) => {
      const { event, repaired } = validateEvent({ v: 1, type: 'trace_end', trace_id: 't', status: name });
      expect(typeof (event as { status?: unknown }).status).toBe('string');
      expect((event as { status?: string }).status).toBe('failed');
      expect(repaired).toBe('status');
    },
  );
});


describe('a causal reference that is not strictly earlier is dropped WITH a warning', () => {
  // `appendStep` already refuses to store a forward or self reference —
  // `causalWalk`'s contract depends on the graph being acyclic, and a forward
  // reference made `why` present time-travelling causality as fact ("step 1
  // caused by #2"). But it dropped the value in SILENCE, while `ingest` rejects
  // the same input loudly with the field named. The live path was the one door
  // where a producer could send a reference, be told nothing, and later find it
  // missing. The precedent for an unusable FIELD on this path is the numeric
  // sweep beside it: drop the field, keep the step, and say which field went.
  const step = (over: Record<string, unknown>) => validateEvent({
    v: 1, type: 'step', trace_id: 't', step_number: 3, step_type: 'tool_call', name: 'x', ...over,
  });

  it.each([
    ['a forward reference', { parent_step: 5 }],
    ['a self reference', { caused_by_step: 3 }],
    ['a zero reference', { parent_step: 0 }],
    ['a non-integer reference', { parent_step: 1.5 }],
  ])('warns about %s', (_label, over) => {
    const { event, warning } = step(over);
    expect(warning).toMatch(/strictly earlier/);
    for (const key of Object.keys(over)) {
      expect((event as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }
  });

  it('keeps a genuinely earlier reference, with no warning', () => {
    const { event, warning } = step({ parent_step: 1, caused_by_step: 2 });
    expect(warning).toBeFalsy();
    expect((event as unknown as Record<string, unknown>).parent_step).toBe(1);
    expect((event as unknown as Record<string, unknown>).caused_by_step).toBe(2);
  });

  it('still names the numeric reason when both kinds are dropped', () => {
    // The two sweeps share one warning line; an earlier version of this fix
    // collapsed them and lost the numeric explanation.
    const { warning } = step({ parent_step: 9, tokens_used: -1 });
    expect(warning).toMatch(/non-negative finite number/);
    expect(warning).toMatch(/strictly earlier/);
  });
});

describe('a trace written through the SDK re-ingests from its own export', () => {
  // The invariant the README states for the programmatic API, end to end
  // through the two documented entry points. It used to be reached by
  // REJECTING a decision whose confidence was out of range, which cost the
  // whole step — the chosen option, the options and the rationale went with
  // it. Dropping the one unusable field reaches the same invariant and keeps
  // the record, and this is the test that says so: it exports what the SDK
  // wrote and feeds it back to `ingestTrace`, the stricter of the two paths.
  it('survives a decision field the stricter path would refuse', async () => {
    const { exportTraces } = await import('../src/services/export-service.js');

    const rec = new TraceRecorder(db);
    rec.startTrace({ agent_name: 'rt-bot', session_id: 's1', input: { task: 't' }, tags: ['x'] });
    rec.step({
      step_number: 1, step_type: 'decision', name: 'pick',
      decision: {
        chosen: 'route_a',
        options: [{ option: 'route_a' }, { option: 'route_b' }],
        confidence: 7,          // out of [0, 1]
        decided_by: 'nonsense', // not a recognized value
        rationale: 'cheaper',
      },
    } as never);
    rec.step({ step_number: 2, step_type: 'output', name: 'done', output: { text: 'ok' } } as never);
    rec.endTrace({ status: 'completed', output: { text: 'ok' } });

    const exported = JSON.parse(exportTraces(db, {}, 'json')) as IngestTraceInput[];
    expect(exported).toHaveLength(1);
    // The decision survived; only the two unusable fields were normalized away.
    const decisionStep = exported[0].steps!.find((s) => s.step_number === 1)!;
    expect(decisionStep.decision).toMatchObject({
      chosen: 'route_a', rationale: 'cheaper', confidence: null, decided_by: 'agent',
    });

    // ...and the export is accepted by `ingestTrace`, which refuses both of the
    // original values outright. That is the whole point of normalizing them.
    const fresh = new Database(':memory:');
    try {
      fresh.pragma('foreign_keys = ON');
      runMigrations(fresh);
      const back = ingestTrace(fresh, exported[0]);
      const full = getTrace(fresh, back.id)!;
      expect(full.steps).toHaveLength(2);
      expect(full.steps[0].decision?.chosen).toBe('route_a');
      expect(full.tags).toEqual(['x']);
    } finally {
      fresh.close();
    }
  });
});

describe('a stream that opens a session the store already has', () => {
  // Nothing correlates capture paths: the hook adapter finds its OWN open trace
  // for a session, the OTel receiver merges only within its own source format,
  // and the recorder opens a trace unconditionally. So a stream carrying the
  // session id of a run captured another way adds a second trace with the same
  // session id, and every store-wide count includes both.
  it('returns a note naming the trace already there', () => {
    const first = ingestTrace(db, {
      agent_name: 'claude-code', status: 'running', session_id: 'sess-dup',
      input: { prompt: 'x' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'Bash' }],
    } as never);

    const result = applyEvent(db, {
      v: 1, type: 'trace_start', trace_id: 'trc_streamdup01', agent_name: 'claude-code', session_id: 'sess-dup',
    } as CaptureEvent);

    expect(result.note).toContain('sess-dup');
    expect(result.note).toContain(first.id);
    // A note is not a warning: nothing was repaired or dropped, and the
    // `record` summary's tally (and its "nothing was recorded" rule) key on
    // warnings.
    expect(result.warning).toBeUndefined();
  });

  it('says nothing for a session the store has never seen', () => {
    const result = applyEvent(db, {
      v: 1, type: 'trace_start', trace_id: 'trc_streamnew01', agent_name: 'a', session_id: 'sess-fresh',
    } as CaptureEvent);
    expect(result.note).toBeUndefined();
  });

  it('does not crash the capture when the producer sends a non-string session id', () => {
    // The lookup binds this value, and a producer that sends
    // `session_id: {nested: 1}` — a case this file already stores defensively —
    // would otherwise throw `RangeError: Too few parameter values were
    // provided` and take down the capture over a NOTE.
    ingestTrace(db, {
      agent_name: 'a', status: 'running', session_id: 'sess-x', input: { p: 1 },
      steps: [{ step_number: 1, step_type: 'output', name: 'o' }],
    } as never);
    const ev = {
      v: 1, type: 'trace_start', trace_id: 'trc_streambad01', agent_name: 'a', session_id: { nested: 1 },
    } as unknown as CaptureEvent;
    expect(() => applyEvent(db, ev)).not.toThrow();
    expect(applyEvent(db, { ...ev, trace_id: 'trc_streambad02' } as CaptureEvent).note).toBeUndefined();
  });

  it('says nothing when the stream carries no session id at all', () => {
    ingestTrace(db, {
      agent_name: 'a', status: 'running', input: { prompt: 'x' },
      steps: [{ step_number: 1, step_type: 'output', name: 'o' }],
    } as never);
    const result = applyEvent(db, { v: 1, type: 'trace_start', trace_id: 'trc_streamnos01', agent_name: 'a' } as CaptureEvent);
    expect(result.note).toBeUndefined();
  });
});
