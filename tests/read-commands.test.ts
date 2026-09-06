import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace, attachDecision, getTrace, getStepSnapshot } from '../src/services/trace-service.js';
import { runShow } from '../src/commands/show.js';
import { runList } from '../src/commands/list.js';
import { forkTrace } from '../src/services/fork-service.js';
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

  it('says what the replay totals were taken over', async () => {
    // A trace mixing timed and untimed steps reported "3 steps | 150ms" — the
    // sum of the two that carried a duration, presented as the run's. An
    // imported session is exactly this shape: its steps are finished but
    // undurated, because a transcript records when a record was written and not
    // how long a tool took.
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const mixed = ingestTrace(db, {
      agent_name: 'mixed', status: 'completed', input: { q: 1 },
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'timed', duration_ms: 120 },
        { step_number: 2, step_type: 'tool_call', name: 'untimed' },
        { step_number: 3, step_type: 'output', name: 'done', duration_ms: 30 },
      ],
    } as never).id;
    out.length = 0;
    await runReplay(mixed, { dir, speed: '0' });
    expect(out.join('\n')).toMatch(/150ms \(over 2 of 3\)/);

    // A fully measured trace says nothing extra.
    const timed = ingestTrace(db, {
      agent_name: 'timed', status: 'completed', input: { q: 2 },
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'a', duration_ms: 10 },
        { step_number: 2, step_type: 'output', name: 'b', duration_ms: 20 },
      ],
    } as never).id;
    out.length = 0;
    await runReplay(timed, { dir, speed: '0' });
    expect(out.join('\n')).toMatch(/30ms/);
    expect(out.join('\n')).not.toMatch(/over \d+ of/);
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

describe('show --json carries the snapshots it was asked for', () => {
  // `--snapshots` reached the human path only: `show --json --snapshots`
  // answered with a document that had no snapshot data at all, so there was NO
  // machine-readable way to read a snapshot out of this tool -- while the very
  // same trace printed them without `--json`. `evals`, the sibling section
  // right above it, has always been in the payload. Same defect, and same fix,
  // as `diff --ai --json`.
  let snapId: string;

  beforeEach(() => {
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    snapId = ingestTrace(db, {
      agent_name: 'snap-bot',
      status: 'completed',
      input: { q: 'snapshot me' },
      steps: [
        {
          step_number: 1,
          step_type: 'tool_call',
          name: 'first',
          snapshot: { context_window: { messages: 2 }, environment: { db: 'prod' }, token_count: 111 },
        },
        { step_number: 2, step_type: 'llm_call', name: 'no-snapshot-here' },
        {
          step_number: 3,
          step_type: 'output',
          name: 'last',
          snapshot: { tool_state: { conn: 'open' }, token_count: 333 },
        },
      ],
    }).id;
  });

  const payload = (): Record<string, unknown> => JSON.parse(out.join('\n'));
  const steps = (): Array<Record<string, unknown>> =>
    payload().steps as Array<Record<string, unknown>>;

  it('attaches each snapshot to its own step, as export does', async () => {
    await runShow(snapId, { dir, json: true, snapshots: true });
    const s = steps();
    // The fixture must actually carry snapshots, or every assertion below
    // passes vacuously against a trace that simply has none.
    expect(s).toHaveLength(3);
    expect(s[0].snapshot).toMatchObject({ token_count: 111, context_window: { messages: 2 }, environment: { db: 'prod' } });
    expect(s[2].snapshot).toMatchObject({ token_count: 333, tool_state: { conn: 'open' } });
    // `null`, not a missing key, on a step that has none -- the shape
    // `export --with-snapshots` writes, so an absence is never ambiguous.
    expect(s[1].snapshot).toBeNull();
  });

  it('re-ingests with its snapshots intact', async () => {
    // The point of matching export's shape: `ingest` reads `steps[].snapshot`,
    // so a top-level array (what this first shipped as) was accepted with
    // "Ingested 1 trace(s) successfully" and silently kept no snapshot at all.
    // A success message for data that was dropped is the failure this tool
    // exists to catch, so the round-trip is pinned rather than the shape alone.
    await runShow(snapId, { dir, json: true, snapshots: true });
    const doc = payload() as unknown as IngestTraceInput;

    const other = mkdtempSync(join(tmpdir(), 'ar-snap-rt-'));
    try {
      const db2 = ensureDatabase(resolve(other, 'traces.db'));
      const reId = ingestTrace(db2, doc).id;
      const back = getTrace(db2, reId);
      expect(back).toBeTruthy();
      const first = getStepSnapshot(db2, reId, 1);
      const third = getStepSnapshot(db2, reId, 3);
      expect(first?.token_count).toBe(111);
      expect(first?.environment).toEqual({ db: 'prod' });
      expect(third?.tool_state).toEqual({ conn: 'open' });
      // The step that had none must not acquire one from the `null`.
      expect(getStepSnapshot(db2, reId, 2)).toBeNull();
    } finally {
      resetConnection();
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('leaves the steps untouched without --snapshots, so the old payload is unchanged', async () => {
    await runShow(snapId, { dir, json: true });
    expect(steps()[0]).not.toHaveProperty('snapshot');
  });

  it('applies the --from-step/--to-step window, as the human path does', async () => {
    // The window scopes `steps`; snapshots ride along on the steps that remain.
    await runShow(snapId, { dir, json: true, snapshots: true, fromStep: '2' });
    const s = steps();
    expect(s.map((x) => x.step_number)).toEqual([2, 3]);
    expect(s[1].snapshot).toMatchObject({ token_count: 333 });
  });
});

describe('show says when a render flag does nothing under --json', () => {
  // `--steps-only` and `--tree` shape the human view only: the JSON document is
  // the whole trace either way, so passing them with `--json` produced a payload
  // identical to one without them, silently. Unlike `--evals`/`--snapshots`,
  // which name data the payload can carry, nothing in a JSON document could
  // honour these two -- so the honest answer is to say the flag did nothing.
  it('warns for --steps-only and --tree, with plural agreement', async () => {
    await runShow(id, { dir, json: true, stepsOnly: true, tree: true });
    expect(stderr()).toMatch(/--steps-only and --tree have no effect with --json/);
    err.length = 0;
    await runShow(id, { dir, json: true, tree: true });
    expect(stderr()).toMatch(/--tree has no effect with --json/);
  });

  it('says nothing when --json is used on its own', async () => {
    // The cry-wolf guard: the warning must key off the flags actually given.
    await runShow(id, { dir, json: true });
    expect(stderr()).not.toMatch(/no effect/);
  });

  it('does not warn for the flags --json genuinely honours', async () => {
    // `--snapshots` is carried in the payload and `evals` is always present, so
    // neither is inert -- flagging them would send the reader looking for data
    // that is right there.
    await runShow(id, { dir, json: true, snapshots: true, evals: true });
    expect(stderr()).not.toMatch(/no effect/);
  });

  it('keeps the warning off stdout, so the document still parses', async () => {
    await runShow(id, { dir, json: true, tree: true });
    expect(stdout()).not.toMatch(/no effect/);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
  });
});

describe('an abandoned-looking trace says so everywhere, not just in the listing', () => {
  // `list` marks a run that has been `running` past the threshold with
  // "⚠ abandoned?". `show` — the view you open NEXT, precisely to look into
  // that run — printed a bare RUNNING, and `show --json` carried nothing at
  // all, so the two views disagreed about the same trace and a script could not
  // see what the table was showing.
  let dir: string;
  let id: string;
  let out: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-abandoned-'));
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    id = ingestTrace(db, {
      agent_name: 'crasher', status: 'running', input: { prompt: 'p' },
      started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'committed' }],
    } as Parameters<typeof ingestTrace>[1]).id;
    out = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m ?? '')); });
  });
  afterEach(() => {
    logSpy.mockRestore();
    resetConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks it in the show header', async () => {
    await runShow(id, { dir });
    expect(out.join('\n').replace(/\x1B\[[0-9;]*m/g, '')).toMatch(/abandoned\?/);
  });

  it('reports it in show --json, so a script sees what the table shows', async () => {
    await runShow(id, { dir, json: true });
    const doc = JSON.parse(out.join('\n')) as { possibly_abandoned: boolean; status: string };
    expect(doc.status).toBe('running');
    expect(doc.possibly_abandoned).toBe(true);
  });

  it('filters by capture path, and names the paths present when nothing matches', () => {
    // Every path now stamps `metadata.source_format`, and the case that needs
    // it is the one the tool reports out loud: a session with two traces. The
    // filter is EXACT, because the formats prefix one another
    // (`record:native`, `record:codex-exec`) and a substring match would answer
    // a narrower question than it was asked — so a typo has to be tellable from
    // "nothing was captured that way".
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    ingestTrace(db, {
      agent_name: 'a', status: 'completed', input: { q: 1 }, metadata: { source_format: 'hook' },
      steps: [{ step_number: 1, step_type: 'output', name: 'o' }],
    } as never);
    ingestTrace(db, {
      agent_name: 'b', status: 'completed', input: { q: 2 }, metadata: { source_format: 'record:native' },
      steps: [{ step_number: 1, step_type: 'output', name: 'o' }],
    } as never);

    out.length = 0;
    runList({ dir, source: 'hook', json: true });
    const doc = JSON.parse(out.join('\n')) as { items: Array<{ agent_name: string }> };
    expect(doc.items.map((t) => t.agent_name)).toEqual(['a']);

    // A prefix is not a match, and the refusal names what the store has.
    out.length = 0;
    runList({ dir, source: 'record' });
    const text = out.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
    expect(text).toMatch(/No traces found/);
    expect(text).toMatch(/This store holds: hook, record:native/);
  });

  it('reports possibly_abandoned in list --json, where a scan for stuck runs happens', () => {
    // The listing draws "⚠ abandoned?" and the document said nothing, so a
    // script had to re-implement the threshold to find what the table was
    // already showing it.
    out.length = 0;
    runList({ dir, json: true });
    const doc = JSON.parse(out.join('\n')) as { items: Array<{ id: string; possibly_abandoned: boolean }> };
    const stale = doc.items.find((t) => t.id === id)!;
    expect(stale.possibly_abandoned).toBe(true);
  });

  it('never calls a fork abandoned, however long it sits', async () => {
    // `fork` copies a run up to a step and leaves the copy `running` for the
    // user to explore. Half an hour later every what-if sandbox in the store
    // was reported as a capture whose writer had died — in the listing, in
    // `show`, in `show --json` and on the dashboard — when nothing is wrong
    // with it and none of the marker's remedies apply.
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const forked = forkTrace(db, id, 1, {}).forked_trace_id;
    db.prepare('UPDATE agent_traces SET started_at = ? WHERE id = ?').run(
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      forked,
    );
    out.length = 0;
    await runShow(forked, { dir, json: true });
    const doc = JSON.parse(out.join('\n')) as { possibly_abandoned: boolean; status: string; parent_trace_id: string };
    expect(doc.status).toBe('running');
    expect(doc.parent_trace_id).toBe(id);
    expect(doc.possibly_abandoned).toBe(false);

    // The listing says what it IS instead.
    out.length = 0;
    await runList({ dir });
    const table = out.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
    const forkRow = table.split('\n').find((l) => l.includes(forked.slice(0, 12)));
    expect(forkRow).toMatch(/⑂ fork/);
    expect(forkRow).not.toMatch(/abandoned\?/);
    // The run it was forked from is genuinely stale, and still says so.
    expect(table.split('\n').find((l) => l.includes(id.slice(0, 12)))).toMatch(/abandoned\?/);
  });

  it('says nothing for a run that started moments ago', async () => {
    // The marker is about a run that looks STUCK; a live one must not be
    // slandered, or the warning means nothing.
    const db = ensureDatabase(resolve(dir, 'traces.db'));
    const fresh = ingestTrace(db, {
      agent_name: 'live', status: 'running', input: { prompt: 'p' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'now' }],
    } as Parameters<typeof ingestTrace>[1]).id;
    out.length = 0;
    await runShow(fresh, { dir, json: true });
    expect((JSON.parse(out.join('\n')) as { possibly_abandoned: boolean }).possibly_abandoned).toBe(false);
  });
});
