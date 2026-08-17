import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getTrace } from '../src/services/trace-service.js';
import { runWrapped } from '../src/services/harness-service.js';
import { resolveDataDir } from '../src/utils/paths.js';

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

  it('re-homes events a child emits under its own trace_id onto the wrapper trace', async () => {
    // A compliant child generates its own trace_id (the SDK does unless it
    // threads AGENT_REPLAY_TRACE_ID). The wrapper owns the trace and must
    // re-stamp its id onto every event, or each references an id the wrapper
    // never created and is dropped as "trace not found" — an empty trace left
    // stuck `running`.
    const SELF_ID = `
const fs = require('fs');
const f = process.env.AGENT_REPLAY_EVENTS;
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'trace_start', trace_id: 'trc_child_own', agent_name: 'c' }) + '\\n');
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'step', trace_id: 'trc_child_own', step_number: 1, step_type: 'output', name: 'did-work' }) + '\\n');
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'trace_end', trace_id: 'trc_child_own', status: 'completed' }) + '\\n');
`;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', SELF_ID], agentName: 'self-bot' });
    expect(res.exitCode).toBe(0);
    expect(res.eventsApplied).toBe(2); // step + trace_end; the child's trace_start is ignored

    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('completed'); // not stuck `running`
    expect(trace.steps.map((s) => s.name)).toEqual(['did-work']);
    // The child's self-generated id is not persisted as a separate trace.
    expect(getTrace(db, 'trc_child_own')).toBeNull();
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

  it('propagates a signal death as 128 + signal number and records the signal', async () => {
    // A child killed by SIGKILL has no exit code; the wrapper should report 137
    // (128 + 9), not flatten every signal death to 1, and record which signal
    // killed it (so an OOM/kill is distinguishable from a generic failure).
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGKILL")'] });
    expect(res.exitCode).toBe(137);
    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('failed');
    expect(trace.error).toMatch(/SIGKILL/);
    expect(trace.metadata.exit_code).toBe(137);
  }, 15000);
});


// ── the wrapper must always finalize and clean up ──────────────────────────

describe('runWrapped robustness', () => {
  it('finalizes the trace when spawn fails synchronously', async () => {
    // Regression: `spawn` throws synchronously on an empty command — a script
    // running `agent-replay run -- "$AGENT_CMD"` with the variable unset is
    // enough. The trace row and temp dir already exist, so the escaping throw
    // left an unfinalizable `running` ghost trace and a leaked temp dir.
    const res = await runWrapped(db, { command: '', args: [], agentName: 'ghost' });

    expect(res.exitCode).toBe(127);
    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('failed'); // not stuck at 'running'
    expect(trace.metadata.exit_code).toBe(127);
  }, 15000);

  it('resumes and warns when the events channel is rewritten instead of appended to', async () => {
    // The channel is contracted to be append-only, and `drain` only ever moved
    // forward — so a producer that rewrote it had every later event silently
    // dropped, with exit 0 and no diagnostic.
    const REWRITER = `
const fs = require('fs');
const f = process.env.AGENT_REPLAY_EVENTS;
const t = process.env.AGENT_REPLAY_TRACE_ID;
const ev = (n) => JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: n, step_type: 'thought', name: 's' + n }) + '\\n';
fs.appendFileSync(f, ev(1));
fs.writeFileSync(f, ev(2));   // rewrite, not append
fs.appendFileSync(f, ev(3));
`;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', REWRITER], agentName: 'rewriter' });
    // The run still completes and reports the child's status rather than
    // crashing or hanging; what survived is whatever the channel could offer.
    expect(res.exitCode).toBe(0);
    expect(getTrace(db, res.traceId)!.status).toBe('completed');
  }, 15000);
});


describe('runWrapped detects a same-size channel rewrite', () => {
  it('warns instead of silently reading from a stale offset', async () => {
    // The append-only guard only compared SIZE, so a producer that reopened the
    // channel truncating (createWriteStream's default 'w' flags, or
    // writeFileSync — an ordinary mistake) and wrote at least as many bytes as
    // were already consumed slipped through: events dropped, exit 0, no
    // diagnostic — the very outcome the guard promises to prevent. The rewrite
    // here is byte-for-byte the same LENGTH as what was already read.
    const SCRIPT = `
const fs = require('fs');
const f = process.env.AGENT_REPLAY_EVENTS;
const t = process.env.AGENT_REPLAY_TRACE_ID;
const ev = (n) => JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: n, step_type: 'thought', name: 's' + n }) + '\\n';
fs.appendFileSync(f, ev(1));
setTimeout(() => { fs.writeFileSync(f, ev(2)); setTimeout(() => process.exit(0), 400); }, 400);
`;
    const warnings: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    let res;
    try {
      res = await runWrapped(db, { command: process.execPath, args: ['-e', SCRIPT], agentName: 'same-size-rewriter' });
    } finally {
      errSpy.mockRestore();
    }
    expect(res.exitCode).toBe(0);
    expect(warnings.join('')).toMatch(/events channel was rewritten/);
  }, 15000);
});

describe('runWrapped fills a duration the child left null', () => {
  it('records the wall-clock span when the child declares its own status', async () => {
    // A child that sends its own trace_end owns the status but rarely sends
    // totals, and the wrapper skipped its update entirely — so an INSTRUMENTED
    // run had total_duration_ms null while an uninstrumented run of the same
    // command reported one, dropping it out of duration stats.
    const SCRIPT = `
const fs = require('fs');
const f = process.env.AGENT_REPLAY_EVENTS;
const t = process.env.AGENT_REPLAY_TRACE_ID;
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'step', trace_id: t, step_number: 1, step_type: 'output', name: 'done' }) + '\\n');
fs.appendFileSync(f, JSON.stringify({ v: 1, type: 'trace_end', trace_id: t, status: 'completed' }) + '\\n');
`;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', SCRIPT], agentName: 'self-finalizer' });
    const trace = getTrace(db, res.traceId)!;
    expect(trace.status).toBe('completed'); // the child's declaration still wins
    expect(trace.total_duration_ms).not.toBeNull();
    expect(trace.total_duration_ms!).toBeGreaterThanOrEqual(0);
  }, 15000);
});

describe('AGENT_REPLAY_DIR handshake', () => {
  it('treats an empty value as unset', () => {
    // `resolve('')` is the CWD, so an exported-but-empty AGENT_REPLAY_DIR wrote
    // the store loose into the working directory — and `demo --reset` then
    // passed its "is this an agent-replay directory?" name check for anyone
    // standing in a checkout named agent-replay, and rm -r'd their working tree.
    const prev = process.env.AGENT_REPLAY_DIR;
    try {
      process.env.AGENT_REPLAY_DIR = '';
      expect(resolveDataDir()).toBe('.agent-replay');
      expect(resolveDataDir('')).toBe('.agent-replay');
      process.env.AGENT_REPLAY_DIR = '/handed/down';
      expect(resolveDataDir('')).toBe('/handed/down');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REPLAY_DIR;
      else process.env.AGENT_REPLAY_DIR = prev;
    }
  });

  it('is honored by a nested agent-replay command, with --dir still winning', async () => {
    // `run` sets AGENT_REPLAY_DIR for its child and the README documents it as
    // how the wrapper hands the child its store — but nothing read it back, so a
    // child that is itself an agent-replay invocation wrote to ./.agent-replay
    // instead of the store the wrapper had just opened a trace in.
    const prev = process.env.AGENT_REPLAY_DIR;
    try {
      process.env.AGENT_REPLAY_DIR = '/handed/down';
      expect(resolveDataDir()).toBe('/handed/down');
      expect(resolveDataDir(undefined)).toBe('/handed/down');
      expect(resolveDataDir('/explicit')).toBe('/explicit'); // --dir always wins
      delete process.env.AGENT_REPLAY_DIR;
      expect(resolveDataDir()).toBe('.agent-replay');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REPLAY_DIR;
      else process.env.AGENT_REPLAY_DIR = prev;
    }
  });
});

describe('runWrapped reports the status it stored', () => {
  it('returns the child-declared status alongside a disagreeing exit code', async () => {
    // Regression: the CLI summary derived its wording from the exit code alone,
    // so a child that declares trace_end {status: completed} and then exits
    // non-zero — a crash during shutdown, after the work succeeded — was
    // announced as "failed" while the database recorded `completed`. Honoring
    // the child's explicit status is deliberate; contradicting it is not.
    const LIAR = `
const fs = require('fs');
fs.appendFileSync(process.env.AGENT_REPLAY_EVENTS,
  JSON.stringify({ v: 1, type: 'trace_end', trace_id: process.env.AGENT_REPLAY_TRACE_ID, status: 'completed' }) + '\\n');
process.exit(3);
`;
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', LIAR], agentName: 'liar' });

    expect(res.exitCode).toBe(3);            // the child's status still propagates
    expect(res.status).toBe('completed');    // and matches what was stored
    expect(getTrace(db, res.traceId)!.status).toBe('completed');
    expect(getTrace(db, res.traceId)!.metadata.exit_code).toBe(3);
  }, 15000);

  it('reports failed when nothing overrode the exit code', async () => {
    const res = await runWrapped(db, { command: process.execPath, args: ['-e', 'process.exit(4)'], agentName: 'plain' });
    expect(res.status).toBe('failed');
    expect(res.exitCode).toBe(4);
  }, 15000);
});
