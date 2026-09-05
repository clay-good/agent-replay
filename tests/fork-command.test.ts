import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace, getTrace } from '../src/services/trace-service.js';
import { runFork } from '../src/commands/fork.js';
import type { IngestTraceInput } from '../src/models/types.js';

/**
 * `fork` is one of the four headline features and its command layer was
 * essentially untested — the service had coverage, the argument handling did
 * not, which is where the defect below lived.
 */
const source: IngestTraceInput = {
  agent_name: 'fork-bot',
  status: 'completed',
  input: { question: 'original' },
  tags: ['first'],
  steps: [
    { step_number: 1, step_type: 'tool_call', name: 'search' },
    { step_number: 2, step_type: 'llm_call', name: 'answer' },
    { step_number: 3, step_type: 'output', name: 'done' },
  ],
};

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;
let traceId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-fork-'));
  const db = ensureDatabase(resolve(dir, 'traces.db'));
  traceId = ingestTrace(db, source).id;
  out = []; err = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
  prevExit = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = prevExit;
  resetConnection();
  rmSync(dir, { recursive: true, force: true });
});

const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
const stderr = () => noAnsi(err.join('\n'));

/** The forked trace, read back from the store. */
function forkedTrace() {
  const db = new Database(resolve(dir, 'traces.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT id FROM agent_traces WHERE parent_trace_id = ?').get(traceId) as
      | { id: string } | undefined;
    if (!row) return null;
    const rw = ensureDatabase(resolve(dir, 'traces.db'));
    return getTrace(rw, row.id);
  } finally { db.close(); }
}

describe('fork refuses a flag it would otherwise silently ignore', () => {
  // Regression: these were read with `if (opts.modifyInput)`, so an empty
  // string was falsy and the flag was skipped entirely — `fork` printed
  // "Forked trace successfully." at exit 0 for a fork that carried none of the
  // modification the caller asked for, and `--tag ""` produced an untagged
  // fork the same way. `list`, `export`, `check` and `config set` all refuse an
  // empty narrowing value for exactly this reason.
  it.each([
    ['--modify-input', { modifyInput: '' }],
    ['--modify-context', { modifyContext: '' }],
    ['--tag', { tag: '' }],
  ])('%s with an empty value is a usage error, and forks nothing', (flag, extra) => {
    runFork(traceId, { fromStep: '2', dir, ...extra });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain(`${flag} was given an empty value.`);
    expect(forkedTrace()).toBeNull();
  });

  it('still treats a literal null as the documented no-op', () => {
    // `null` keeps the original value; the refusal above must not take that away.
    runFork(traceId, { fromStep: '2', modifyInput: 'null', dir });
    expect(process.exitCode).toBe(0);
    const fork = forkedTrace()!;
    expect(fork.input).toEqual({ question: 'original' });
    expect(noAnsi(out.join('\n'))).not.toMatch(/Modified input/);
  });
});

describe('fork, end to end through the command', () => {
  it('copies the step prefix, applies the modification, and tags the copy', () => {
    runFork(traceId, {
      fromStep: '2',
      modifyInput: '{"question":"changed"}',
      tag: 'experiment',
      dir,
    });
    expect(process.exitCode).toBe(0);

    const fork = forkedTrace()!;
    expect(fork.parent_trace_id).toBe(traceId);
    expect(fork.forked_from_step).toBe(2);
    expect(fork.steps.map((s) => s.step_number)).toEqual([1, 2]);
    expect(fork.input).toEqual({ question: 'changed' });
    // The copy inherits the original's tags plus the one asked for.
    expect(fork.tags).toEqual(['first', 'experiment']);
    expect(noAnsi(out.join('\n'))).toMatch(/Modified input/);
  });

  it.each([
    ['a non-integer step', { fromStep: 'two' }, 2, /Invalid step number/],
    ['a step below 1', { fromStep: '0' }, 2, /Invalid step number/],
    ['a step past the end', { fromStep: '9' }, 1, /Step 9 doesn't exist/],
    ['a non-object modifier', { fromStep: '2', modifyInput: '5' }, 2, /expected an object, got number/],
    ['an array modifier', { fromStep: '2', modifyInput: '[1]' }, 2, /expected an object, got an array/],
    ['unparseable JSON', { fromStep: '2', modifyInput: '{oops' }, 2, /Invalid JSON for --modify-input/],
  ])('refuses %s', (_label, extra, code, pattern) => {
    runFork(traceId, { fromStep: '1', dir, ...extra });
    expect(process.exitCode).toBe(code);
    expect(stderr()).toMatch(pattern);
    expect(forkedTrace()).toBeNull();
  });

  it('reports a missing trace as a runtime failure, not a usage error', () => {
    runFork('trc_nope', { fromStep: '1', dir });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/Trace not found/);
  });
});
