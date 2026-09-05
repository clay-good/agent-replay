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

  it('omits the window key when the window left nothing out', async () => {
    // `step_window` marks a SUBSET, not the presence of the flags. A window
    // that happens to cover the whole trace returns the whole trace, so a
    // consumer reading the key to tell "is this everything?" gets the same
    // answer it gets for an unwindowed call -- which is the true one.
    //
    // Worth pinning because the obvious "simplification" is to attach the key
    // whenever --from-step/--to-step is passed, which would make the key mean
    // "flags were used" instead of "steps are missing" and quietly break the
    // one question it exists to answer. The README claimed the flag-based rule
    // until this case was actually run.
    await runShow(id, { dir, json: true, fromStep: '1', toStep: '4' });
    expect(doc().steps).toHaveLength(4);
    expect(doc().step_window).toBeUndefined();
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

  // The --pause path had no coverage at all, in either direction.
  describe('--pause', () => {
    // `process.stdout/stdin.isTTY` is a plain DATA property, not a getter:
    // set and restore it directly (vi.spyOn(..., 'get') throws here).
    const realIsTTY = process.stdin.isTTY;
    afterEach(() => {
      process.stdin.isTTY = realIsTTY;
    });

    it('says the flag has no effect when stdin is not a terminal', async () => {
      process.stdin.isTTY = undefined;
      await runReplay(id, { dir, speed: '0', pause: true });
      // It replayed straight through — correctly, since blocking off a TTY
      // would hang a pipeline — but used to do so in complete silence, so a
      // --pause left in a script looked exactly like a paused run.
      expect(stderr()).toMatch(/--pause has no effect without an interactive terminal/);
      expect(stdout()).toMatch(/Replay complete: 4 steps/);
      expect(process.exitCode).toBe(0);
    });

    it('stays silent about --pause when it is not passed', async () => {
      process.stdin.isTTY = undefined;
      await runReplay(id, { dir, speed: '0' });
      expect(stderr()).not.toMatch(/--pause/);
    });

    it('waits for a keypress between steps on a terminal, and not after the last', async () => {
      process.stdin.isTTY = true;
      // Stand in for the terminal. `setRawMode`/`isRaw` exist only on a real
      // tty.ReadStream, so they are DEFINED here rather than spied on, and
      // deleted again afterwards.
      const stdin = process.stdin as unknown as Record<string, unknown>;
      const saved = { once: stdin.once, resume: stdin.resume, pause: stdin.pause };
      const onceFn = vi.fn((event: string, cb: (d: Buffer) => void) => {
        // Answer on the next tick, so the replay advances without a real key.
        if (event === 'data') setImmediate(() => cb(Buffer.from([0x20])));
        return process.stdin;
      });
      const rawFn = vi.fn(() => process.stdin);
      const resumeFn = vi.fn(() => process.stdin);
      const pauseFn = vi.fn(() => process.stdin);
      stdin.once = onceFn; stdin.resume = resumeFn; stdin.pause = pauseFn;
      stdin.setRawMode = rawFn; stdin.isRaw = false;
      try {
        await runReplay(id, { dir, speed: '0', pause: true });
        // Four steps means three gaps: it must not pause after the last one.
        expect(onceFn).toHaveBeenCalledTimes(3);
        expect(stdout()).toMatch(/Press any key to continue/);
        // Raw mode is entered and restored for each pause, never left on.
        expect(rawFn).toHaveBeenCalledWith(true);
        expect(rawFn).toHaveBeenLastCalledWith(false);
        expect(resumeFn).toHaveBeenCalledTimes(3);
        expect(pauseFn).toHaveBeenCalledTimes(3);
        expect(stderr()).not.toMatch(/no effect/);
      } finally {
        stdin.once = saved.once; stdin.resume = saved.resume; stdin.pause = saved.pause;
        delete stdin.setRawMode; delete stdin.isRaw;
      }
    });
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

describe('show says when a flag it was given does nothing', () => {
  // `--steps-only` returns before the evaluations and snapshots sections, so
  // asking for either alongside it gets you neither -- silently, and the output
  // is indistinguishable from a trace that has none. The export path already
  // warns for its own inert pair (`--with-evals` with `--format golden`); this
  // is the same rule at the twin site.
  it('warns that --evals and --snapshots are inert with --steps-only', async () => {
    await runShow(id, { dir, stepsOnly: true, evals: true, snapshots: true });
    const text = stderr();
    expect(text).toMatch(/--evals and --snapshots have no effect with --steps-only/);
    // Plural agreement: the same list rendered for one flag must read "has".
    err.length = 0;
    await runShow(id, { dir, stepsOnly: true, evals: true });
    expect(stderr()).toMatch(/--evals has no effect with --steps-only/);
  });

  it('says nothing when --steps-only is used on its own', async () => {
    // The cry-wolf guard: the warning must key off the flags actually given.
    await runShow(id, { dir, stepsOnly: true });
    expect(stderr()).not.toMatch(/no effect/);
  });

  it('keeps the warning off stdout, so --steps-only stays pipeable', async () => {
    // The steps table is the thing a caller pipes; a warning belongs on stderr.
    await runShow(id, { dir, stepsOnly: true, evals: true });
    expect(stdout()).not.toMatch(/no effect/);
    expect(stdout()).toMatch(/Steps/);
  });

  it('leaves the full view alone, where both flags do something', async () => {
    await runShow(id, { dir, evals: true });
    expect(stderr()).not.toMatch(/no effect/);
  });
});
