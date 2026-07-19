import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace } from '../src/services/trace-service.js';
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
