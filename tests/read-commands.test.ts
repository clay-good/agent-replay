import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace, attachDecision } from '../src/services/trace-service.js';
import { runShow } from '../src/commands/show.js';
import { runWhy } from '../src/commands/why.js';
import { runDecisions } from '../src/commands/decisions.js';
import { runReplay } from '../src/commands/replay.js';
import type { IngestTraceInput } from '../src/models/types.js';

/**
 * The four read commands are the primary way anyone looks at a trace, and
 * their command layers — argument handling, window scoping, output shape —
 * were almost entirely untested; the services beneath them were not. This is
 * the standing net for that layer.
 */
const trace: IngestTraceInput = {
  agent_name: 'read-bot',
  status: 'completed',
  input: { q: 'what now' },
  output: { text: 'done' },
  steps: [
    { step_number: 1, step_type: 'tool_call', name: 'search', input: { term: 'x' } },
    { step_number: 2, step_type: 'decision', name: 'pick_route', caused_by_step: 1 },
    { step_number: 3, step_type: 'llm_call', name: 'answer', caused_by_step: 2 },
    { step_number: 4, step_type: 'output', name: 'done' },
  ],
};

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;
let id: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-read-'));
  const db = ensureDatabase(resolve(dir, 'traces.db'));
  id = ingestTrace(db, trace).id;
  attachDecision(db, id, 2, {
    chosen: 'route_a',
    options: [{ option: 'route_a', score: 0.9 }, { option: 'route_b', score: 0.2 }],
    confidence: 0.9,
    rationale: 'cheaper',
    decided_by: 'model',
  });
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
const stdout = () => noAnsi(out.join('\n'));
const stderr = () => noAnsi(err.join('\n'));
const doc = () => JSON.parse(stdout());

describe('show', () => {
  it('renders the trace, its steps, and the decision it made', async () => {
    await runShow(id, { dir });
    expect(process.exitCode).toBe(0);
    const text = stdout();
    expect(text).toMatch(/read-bot/);
    expect(text).toMatch(/search/);
    expect(text).toMatch(/pick_route/);
  });

  it('says what a --from-step/--to-step window left out, in both shapes', async () => {
    await runShow(id, { dir, fromStep: '2', toStep: '3' });
    expect(stdout()).toMatch(/Showing 2 of 4 steps/);

    out.length = 0;
    await runShow(id, { dir, json: true, fromStep: '2', toStep: '3' });
    const d = doc();
    expect(d.steps).toHaveLength(2);
    expect(d.step_window).toEqual({ from: 2, to: 3, shown: 2, omitted: 2 });
  });

  it('leaves an unwindowed --json document with no window key at all', async () => {
    await runShow(id, { dir, json: true });
    expect(doc().step_window).toBeUndefined();
    expect(doc().steps).toHaveLength(4);
  });

  it.each([
    ['a non-integer --from-step', { fromStep: 'two' }, /Invalid --from-step/],
    ['--to-step below 1', { toStep: '0' }, /Invalid --to-step/],
    ['an inverted window', { fromStep: '3', toStep: '2' }, /cannot be greater than/],
  ])('refuses %s as a usage error', async (_l, extra, pattern) => {
    await runShow(id, { dir, json: true, ...extra });
    expect(process.exitCode).toBe(2);
    expect(doc()).toMatchObject({ ok: false });
    expect(doc().error).toMatch(pattern);
  });

  it('renders the tree view without losing a step', async () => {
    await runShow(id, { dir, tree: true });
    const text = stdout();
    for (const name of ['search', 'pick_route', 'answer', 'done']) {
      expect(text).toContain(name);
    }
  });
});

describe('why', () => {
  it('walks the chain back to the root and names each link', async () => {
    await runWhy(id, { step: '3', dir, json: true });
    const d = doc();
    expect(d.step).toBe(3);
    expect(d.chain.map((h: { step_number: number }) => h.step_number)).toEqual([3, 2, 1]);
    expect(d.chain[0].link).toBe('origin');
    expect(d.chain[1].link).toBe('caused_by');
    // The decision on the way is carried, since explaining it is the point.
    expect(d.chain[1].decision.chosen).toBe('route_a');
  });

  it('renders the chain and the decision for a human', async () => {
    await runWhy(id, { step: '3', dir });
    const text = stdout();
    expect(text).toMatch(/causal chain \(3 steps\)/);
    expect(text).toMatch(/route_a/);
    expect(text).toMatch(/cheaper/);
    expect(text).toMatch(/Chain terminates at step 1/);
  });

  it.each([
    ['a missing --step', {}, 2, /--step <N> is required/],
    ['a non-integer --step', { step: 'x' }, 2, /--step <N> is required/],
    ['a step that does not exist', { step: '99' }, 1, /Step 99 not found/],
  ])('refuses %s', async (_l, extra, code, pattern) => {
    await runWhy(id, { dir, json: true, ...extra });
    expect(process.exitCode).toBe(code);
    expect(doc().error).toMatch(pattern);
  });
});

describe('decisions', () => {
  it('lists the decision point with its options and rationale', async () => {
    await runDecisions(id, { dir });
    const text = stdout();
    expect(text).toMatch(/1 decision point\(s\)/);
    expect(text).toMatch(/route_a/);
    expect(text).toMatch(/route_b/);
    expect(text).toMatch(/cheaper/);
  });

  it('reports the same record in --json', async () => {
    await runDecisions(id, { dir, json: true });
    const d = doc();
    expect(d.trace_id).toBe(id);
    expect(d.decisions).toHaveLength(1);
    expect(d.decisions[0]).toMatchObject({ step_number: 2, name: 'pick_route', chosen: 'route_a' });
  });

  it('says so plainly when a trace recorded none', async () => {
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const bare = ingestTrace(db, {
      agent_name: 'no-decisions', status: 'completed', input: {},
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    } as IngestTraceInput);
    await runDecisions(bare.id, { dir });
    expect(process.exitCode).toBe(0);
    expect(stdout()).toMatch(/No decision steps recorded/);

    out.length = 0;
    await runDecisions(bare.id, { dir, json: true });
    expect(doc().decisions).toEqual([]);
  });
});

describe('replay', () => {
  // The per-step lines are drawn by ora on stderr (and suppressed off a TTY),
  // so the stdout contract is the header panel and the closing tally.
  it('replays instantly at --speed 0 and tallies what it played', async () => {
    await runReplay(id, { dir, speed: '0' });
    expect(process.exitCode).toBe(0);
    const text = stdout();
    expect(text).toMatch(/read-bot/);
    expect(text).toMatch(/instant/);
    expect(text).toMatch(/Replay complete: 4 steps/);
  });

  it('honors --from-step/--to-step in the tally', async () => {
    await runReplay(id, { dir, speed: '0', fromStep: '2', toStep: '3' });
    expect(stdout()).toMatch(/Replay complete: 2 steps/);
  });

  it('says a range holds no steps rather than replaying nothing silently', async () => {
    await runReplay(id, { dir, speed: '0', fromStep: '90' });
    expect(stderr()).toMatch(/No steps in the specified range/);
    // And FAILS. It said this and then exited 0, so a script asking to replay
    // steps that do not exist was told the run succeeded. `fork --from-step`
    // has always refused the same mistake at exit 1.
    expect(process.exitCode).toBe(1);
    // Naming the range that does exist is what makes the line actionable,
    // exactly as `fork` names its max step.
    expect(stderr()).toMatch(/this trace has steps 1-\d+/);
  });

  it.each([
    ['a negative --speed', { speed: '-1' }, /Invalid --speed/],
    ['a non-finite --speed', { speed: 'Infinity' }, /Invalid --speed/],
    ['an inverted window', { speed: '0', fromStep: '3', toStep: '2' }, /cannot be greater than/],
  ])('refuses %s as a usage error', async (_l, extra, pattern) => {
    await runReplay(id, { dir, ...extra });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(pattern);
  });
});
