import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace } from '../src/services/trace-service.js';
import { runWrapped } from '../src/services/harness-service.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

// A child that emits two step events on the recording channel, then exits 0.
const INSTRUMENTED = `
const fs = require('fs');
const f = process.env.AGENT_REPLAY_EVENTS;
const t = process.env.AGENT_REPLAY_TRACE_ID;
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: 1, step_type: 'thought', name: 'plan' }) + '\\n');
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: 2, step_type: 'output', name: 'done', output: { ok: true } }) + '\\n');
`;

describe('runWrapped', () => {
  it('records an instrumented run as a full trace and completes on exit 0', async () => {
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', INSTRUMENTED], agentName: 'my-bot' });
    expect(res.exitCode).toBe(0);
    expect(res.eventsApplied).toBe(2);

    const trace = getTrace(db, res.traceId)!;
    expect(trace.agent_name).toBe('my-bot');
    expect(trace.status).toBe('completed');
    expect(trace.steps.map((s) => s.name)).toEqual(['plan', 'done']);
    expect(trace.metadata.exit_code).toBe(0);
    expect(trace.total_duration_ms).not.toBeNull();
  }, 15000);

  it('finalizes as failed and propagates a non-zero exit code', async () => {
    const script = `
      const fs = require('fs');
      fs.appendFileSync(process.env.AGENT_REPLAY_EVENTS, JSON.stringify({ v: 1, type: 'step', trace_id: process.env.AGENT_REPLAY_TRACE_ID, step_number: 1, step_type: 'tool_call', name: 'risky' }) + '\\n');
      process.exit(3);
    `;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', script] });
    expect(res.exitCode).toBe(3);

    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('failed');
    expect(trace.error).toMatch(/code 3/);
    expect(trace.metadata.exit_code).toBe(3);
    expect(trace.steps).toHaveLength(1);
  }, 15000);

  it('still records a minimal trace for an uninstrumented child', async () => {
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', 'process.exit(0)'] });
    expect(res.exitCode).toBe(0);
    expect(res.eventsApplied).toBe(0);

    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('completed');
    expect(trace.steps).toHaveLength(0);
    expect(trace.metadata.exit_code).toBe(0);
    expect(trace.total_duration_ms).not.toBeNull();
  }, 15000);

  it('captures many events written across poll cycles (incremental drain)', async () => {
    // Write a batch, sleep past the 200ms poll interval so a mid-run poll reads
    // incrementally, then write another batch and exit — exercising the
    // byte-offset read across a poll boundary and the final drain together.
    const script = `
      const fs = require('fs');
      const f = process.env.AGENT_REPLAY_EVENTS, t = process.env.AGENT_REPLAY_TRACE_ID;
      const ev = (n) => fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: n, step_type: 'thought', name: 'n' + n }) + '\\n');
      for (let i = 1; i <= 120; i++) ev(i);
      setTimeout(() => { for (let i = 121; i <= 240; i++) ev(i); process.exit(0); }, 320);
    `;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', script] });
    expect(res.eventsApplied).toBe(240);
    const trace = getTrace(db, res.traceId)!;
    expect(trace.steps).toHaveLength(240);
    // Steps are distinct and complete (no partial-line corruption at boundaries).
    expect(new Set(trace.steps.map((s) => s.step_number)).size).toBe(240);
  }, 15000);

  it('reassembles a multi-byte UTF-8 character split across a poll boundary', async () => {
    // The child writes an event whose name contains a 4-byte emoji, but flushes
    // the line in two halves — split mid-emoji — with a >200ms gap, so a poll
    // reads a partial character. A naive byte→string decode would corrupt it
    // into U+FFFD; the StringDecoder must recombine it.
    const script = `
      const fs = require('fs');
      const f = process.env.AGENT_REPLAY_EVENTS, t = process.env.AGENT_REPLAY_TRACE_ID;
      const line = JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: 1, step_type: 'thought', name: 'boundary_\u{1F600}_test' }) + '\\n';
      const buf = Buffer.from(line, 'utf8');
      const split = buf.indexOf(Buffer.from('\u{1F600}', 'utf8')) + 2; // mid-emoji
      fs.appendFileSync(f, buf.subarray(0, split));
      setTimeout(() => { fs.appendFileSync(f, buf.subarray(split)); process.exit(0); }, 320);
    `;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', script] });
    expect(res.eventsApplied).toBe(1);
    const trace = getTrace(db, res.traceId)!;
    expect(trace.steps[0].name).toBe('boundary_\u{1F600}_test');
  }, 15000);

  it('honors an explicit trace_end emitted by the child', async () => {
    const script = `
      const fs = require('fs');
      const t = process.env.AGENT_REPLAY_TRACE_ID;
      fs.appendFileSync(process.env.AGENT_REPLAY_EVENTS, JSON.stringify({ v: 1, type: 'trace_end', trace_id: t, status: 'completed', total_tokens: 42 }) + '\\n');
    `;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', script] });
    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('completed');
    expect(trace.total_tokens).toBe(42);
  }, 15000);

  it('finalizes as failed when a statusless trace_end is followed by a non-zero exit', async () => {
    // The child emits a bare trace_end (no status), which the recorder defaults
    // to `completed`, then exits 3. The wrapper must still record the trace as
    // failed with the exit code — the default must not mask the failure.
    const script = `
      const fs = require('fs');
      const t = process.env.AGENT_REPLAY_TRACE_ID;
      fs.appendFileSync(process.env.AGENT_REPLAY_EVENTS, JSON.stringify({ v: 1, type: 'trace_end', trace_id: t, total_tokens: 7 }) + '\\n');
      process.exit(3);
    `;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', script] });
    expect(res.exitCode).toBe(3);
    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('failed');
    expect(trace.error).toMatch(/code 3/);
    expect(trace.metadata.exit_code).toBe(3);
  }, 15000);

  it('still honors an EXPLICIT child status even when the exit code disagrees', async () => {
    // The child explicitly declares success, then exits non-zero. An explicit
    // status is authoritative (unlike the statusless default above), so the
    // trace stays completed while the exit code is still propagated/recorded.
    const script = `
      const fs = require('fs');
      const t = process.env.AGENT_REPLAY_TRACE_ID;
      fs.appendFileSync(process.env.AGENT_REPLAY_EVENTS, JSON.stringify({ v: 1, type: 'trace_end', trace_id: t, status: 'completed' }) + '\\n');
      process.exit(5);
    `;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', script] });
    expect(res.exitCode).toBe(5);
    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('completed'); // explicit status honored
    expect(trace.metadata.exit_code).toBe(5); // exit code still recorded
  }, 15000);
});
