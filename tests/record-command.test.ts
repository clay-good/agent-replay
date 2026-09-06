import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';

/**
 * `record` is the live-capture entry point: an agent's output is piped into it
 * and it must never turn a producer's mistake into a silently clean run. Its
 * command layer — format selection, `--tags`, the finalize-on-EOF contract and
 * the "nothing was recorded" gate — was covered only for the wrapper-trace
 * case. These are the rest of its documented contracts.
 */
let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;
const realStdin = process.stdin;

function setStdin(chunks: string[]): void {
  Object.defineProperty(process, 'stdin', { value: Readable.from(chunks), configurable: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-reccmd-'));
  ensureDatabase(resolve(dir, 'traces.db'));
  resetConnection();
  out = []; err = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
  prevExit = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
  process.exitCode = prevExit;
  resetConnection();
  rmSync(dir, { recursive: true, force: true });
});

const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
const stdout = () => noAnsi(out.join('\n'));
const stderr = () => noAnsi(err.join('\n'));

async function record(lines: string[], opts: Record<string, unknown> = {}): Promise<void> {
  const { runRecord } = await import('../src/commands/record.js');
  setStdin(lines.map((l) => l + '\n'));
  await runRecord({ dir, ...opts });
}

/** Read the store back. */
function store<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(resolve(dir, 'traces.db'), { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

const TID = 'trc_rec_1';
const start = JSON.stringify({ v: 1, type: 'trace_start', trace_id: TID, agent_name: 'rec-bot', input: { q: 1 } });
const step = (n: number) => JSON.stringify({ v: 1, type: 'step', trace_id: TID, step_number: n, step_type: 'tool_call', name: `t${n}` });
const end = JSON.stringify({ v: 1, type: 'trace_end', trace_id: TID, status: 'completed' });

describe('record: the native protocol', () => {
  it('records a whole stream and reports what it did', async () => {
    await record([start, step(1), step(2), end]);
    expect(process.exitCode).toBe(0);
    expect(stdout()).toMatch(/Traces touched:\s+1/);
    expect(stdout()).toMatch(/Total steps:\s+2/);
    expect(store((db) => (db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(TID) as { status: string }).status))
      .toBe('completed');
  });

  it('finalizes a trace left open at EOF as timeout, unless told not to', async () => {
    await record([start, step(1)]);
    expect(stdout()).toMatch(/Finalized as timeout:\s+1/);
    expect(store((db) => (db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(TID) as { status: string }).status))
      .toBe('timeout');
  });

  it('leaves it running under --leave-open', async () => {
    await record([start, step(1)], { leaveOpen: true });
    expect(store((db) => (db.prepare('SELECT status FROM agent_traces WHERE id = ?').get(TID) as { status: string }).status))
      .toBe('running');
  });

  it('adds --tags to the trace it opens', async () => {
    await record([start, step(1), end], { tags: 'production, v2 ,,' });
    const tags = store((db) => JSON.parse((db.prepare('SELECT tags FROM agent_traces WHERE id = ?').get(TID) as { tags: string }).tags));
    expect(tags).toEqual(['production', 'v2']);
  });

  it('keeps recording after a line it cannot use', async () => {
    // Per-event leniency is deliberate: one bad line must never cost the rest
    // of the stream. But it is reported, not swallowed.
    await record([start, '{not json', step(1), end]);
    expect(process.exitCode).toBe(0);
    expect(stderr()).toMatch(/invalid JSON/);
    expect(stdout()).toMatch(/Warnings:\s+1/);
    expect(store((db) => (db.prepare('SELECT COUNT(*) c FROM agent_trace_steps WHERE trace_id = ?').get(TID) as { c: number }).c))
      .toBe(1);
  });

  it('treats a comment-only stream as a clean no-op', async () => {
    // `//` is part of the NATIVE protocol, so counting comments as input made a
    // legal comment-only stream report "none of the N line(s) matched" at exit 1.
    await record(['// nothing to see', '// still nothing']);
    expect(process.exitCode).toBe(0);
    expect(stderr()).not.toMatch(/Nothing was recorded/);
  });

  it('is a clean no-op on an empty stream', async () => {
    await record([]);
    expect(process.exitCode).toBe(0);
    expect(stderr()).not.toMatch(/Nothing was recorded/);
  });

  it('fails when input arrived and nothing at all was recorded', async () => {
    // The gate that stops `agent | agent-replay record && agent-replay check`
    // from reading a total capture failure as a clean run.
    await record(['{not json', 'also not json']);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/Nothing was recorded/);
  });
});

describe('record: harness stream translation', () => {
  it('refuses a --format it does not support', async () => {
    await record([start], { format: 'nonsense' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/--format nonsense is not supported/);
    // Nothing was written under a format it never understood.
    expect(store((db) => (db.prepare('SELECT COUNT(*) c FROM agent_traces').get() as { c: number }).c)).toBe(0);
  });

  it('translates a codex-exec stream into a trace', async () => {
    await record([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'c1', command: 'ls', aggregated_output: 'a\nb', exit_code: 0 } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: 'done' } }),
    ], { format: 'codex-exec' });
    expect(process.exitCode).toBe(0);
    const steps = store((db) => db.prepare('SELECT step_type, name FROM agent_trace_steps ORDER BY step_number').all() as { step_type: string; name: string }[]);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((s) => s.step_type === 'tool_call')).toBe(true);
  });

  it('fails rather than reporting success when the --format is the wrong one', async () => {
    // A translator IGNORES an unrecognized line silently rather than warning, so
    // keying the failure gate on the warning count missed exactly this: piping a
    // native stream with `--format codex-exec` left warnings at 0 and reported a
    // clean run having recorded nothing.
    await record([start, step(1), end], { format: 'codex-exec' });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/Nothing was recorded/);
    expect(stderr()).toMatch(/codex-exec/);
  });
});

describe('record --input', () => {
  const codex = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th_in' }),
    JSON.stringify({ type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ];

  it('gives a translated stream the prompt it does not carry', async () => {
    await record(codex, { format: 'codex-exec', input: 'fix the failing tests' });
    const input = store((db) => db.prepare('SELECT input FROM agent_traces').pluck().get() as string);
    expect(JSON.parse(input)).toEqual({ prompt: 'fix the failing tests' });
  });

  it('does not override an input the producer sent', async () => {
    await record([start, end], { input: 'from the command line' });
    const input = store((db) => db.prepare('SELECT input FROM agent_traces').pluck().get() as string);
    expect(JSON.parse(input)).toEqual({ q: 1 });
  });

  it('treats a blank --input as absent rather than storing an empty prompt', async () => {
    await record(codex, { format: 'codex-exec', input: '   ' });
    const input = store((db) => db.prepare('SELECT input FROM agent_traces').pluck().get() as string);
    expect(JSON.parse(input)).toEqual({});
  });

  it('records no input when none is supplied', async () => {
    await record(codex, { format: 'codex-exec' });
    const input = store((db) => db.prepare('SELECT input FROM agent_traces').pluck().get() as string);
    expect(JSON.parse(input)).toEqual({});
  });
});

describe('record --agent-name', () => {
  const codex = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th_n' }),
    JSON.stringify({ type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ];
  const names = () =>
    store((db) => db.prepare('SELECT agent_name FROM agent_traces ORDER BY id').pluck().all() as string[]);

  it('labels a translated capture, which otherwise takes the harness name', async () => {
    await record(codex, { format: 'codex-exec', agentName: 'nightly-refactor' });
    expect(names()).toEqual(['nightly-refactor']);
  });

  it('keeps the harness name when the flag is not given', async () => {
    await record(codex, { format: 'codex-exec' });
    expect(names()).toEqual(['codex']);
  });

  it('overrides the name a native producer sent, since a name is a label', async () => {
    await record([start, end], { agentName: 'renamed' });
    expect(names()).toEqual(['renamed']);
  });

  it('falls back to the stream name on a blank value, and says so', async () => {
    await record(codex, { format: 'codex-exec', agentName: '   ' });
    expect(names()).toEqual(['codex']);
    expect(stderr()).toContain('--agent-name was blank');
  });
});

describe('record: naming the format that would have worked', () => {
  const codexLines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th' }),
    JSON.stringify({ type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ];
  const claudeLines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ];
  const geminiLines = [
    JSON.stringify({ type: 'init', session_id: 's' }),
    JSON.stringify({ type: 'message', content: 'hi' }),
  ];

  it('names claude-stream when a claude stream was piped as codex-exec', async () => {
    await record(claudeLines, { format: 'codex-exec' });
    expect(stderr()).toContain('try --format claude-stream');
    expect(process.exitCode).toBe(1);
  });

  it('names codex-exec when a codex stream was piped as claude-stream', async () => {
    await record(codexLines, { format: 'claude-stream' });
    expect(stderr()).toContain('try --format codex-exec');
  });

  it('names gemini-stream when a gemini stream was piped as codex-exec', async () => {
    await record(geminiLines, { format: 'codex-exec' });
    expect(stderr()).toContain('try --format gemini-stream');
  });

  it('says nothing when the records name no format', async () => {
    // `result` is emitted by two of the streams, so it is evidence for neither.
    await record([JSON.stringify({ type: 'result', foo: 1 })], { format: 'codex-exec' });
    expect(stderr()).not.toContain('try --format');
  });

  it('says nothing when the records point at two formats at once', async () => {
    await record(
      [JSON.stringify({ type: 'thread.started' }), JSON.stringify({ type: 'tool_use', name: 'x' })],
      { format: 'claude-stream' },
    );
    expect(stderr()).not.toContain('try --format');
  });

  it('never suggests the format already in use', async () => {
    // A codex stream that records nothing for some other reason must not be
    // told to try the format it is already using.
    await record([JSON.stringify({ type: 'turn.failed', error: { message: 'x' } })], { format: 'codex-exec' });
    expect(stderr()).not.toContain('try --format');
  });
});

describe('record: a non-JSON line in a translated stream', () => {
  const good = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th_j' }),
    JSON.stringify({ type: 'item.completed', item: { item_type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ];

  it('warns and keeps going, rather than losing the run', async () => {
    // A harness that prints a progress line into its own JSON stream is the
    // real case. The rest of the stream must still be recorded.
    await record([good[0], 'Building project...', good[1], good[2]], { format: 'codex-exec' });
    expect(stderr()).toContain('invalid JSON in codex-exec stream');
    const steps = store((db) => db.prepare('SELECT COUNT(*) FROM agent_trace_steps').pluck().get() as number);
    expect(steps).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it('fails the run when every line is unparseable', async () => {
    // Nothing was recorded, so this must not report success.
    await record(['not json', 'also not json'], { format: 'codex-exec' });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain('Nothing was recorded');
  });
});
