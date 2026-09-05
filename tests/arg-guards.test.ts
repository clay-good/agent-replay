import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { runList } from '../src/commands/list.js';
import { runWatch } from '../src/commands/watch.js';
import { runDashboard } from '../src/commands/dashboard.js';

/**
 * The hardening pass added a layer of argument guards whose whole purpose is
 * that a malformed flag becomes a usage error instead of a silent fall-back to
 * the default — a listing ordered by start time is indistinguishable from one
 * ordered as asked, and `LIMIT -1` is SQLite for "no limit", the inverse of
 * the request. Every one of those branches was unexercised, so nothing would
 * have caught a regression that restored exactly the silence they were written
 * to remove. This is the standing net for them.
 */
let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-args-'));
  const db = ensureDatabase(resolve(dir, 'traces.db'));
  ingestTrace(db, {
    agent_name: 'arg-bot',
    status: 'completed',
    input: { q: 'x' },
    steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
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
const stderr = () => noAnsi(err.join('\n'));
const stdout = () => noAnsi(out.join('\n'));

describe('list refuses a malformed filter rather than widening the listing', () => {
  // An empty value is the script-interpolation case: `--agent "$AGENT"` with
  // AGENT unset must not quietly list EVERY trace, which reads exactly like a
  // correct answer.
  it.each([
    ['--status', { status: '' }],
    ['--agent', { agent: '' }],
    ['--tag', { tag: '' }],
    ['--session', { session: '' }],
    ['--since', { since: '' }],
  ])('refuses %s given an empty value', (flag, extra) => {
    runList({ dir, ...extra });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain(`${flag} was given an empty value.`);
    // A refusal must not also print a listing.
    expect(stdout()).not.toMatch(/arg-bot/);
  });

  it('refuses --sort given an empty value, instead of falling back to the default order', () => {
    // `listTraces` rejects an unknown sort field deliberately; a bare
    // truthiness guard let "" past it and did the silent fall-back the check
    // exists to prevent.
    runList({ dir, sort: '' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain('--sort was given an empty value.');
  });

  it('refuses an unknown --sort field', () => {
    runList({ dir, sort: 'bogus' });
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ['zero', '0'],
    ['a negative', '-1'],
    ['a non-integer', '1.5'],
    ['a non-number', 'abc'],
    ['an empty value', ''],
  ])('refuses %s --limit', (_label, limit) => {
    runList({ dir, limit });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Invalid --limit/);
  });

  it('reads --limit with Number, not parseInt', () => {
    // "1e2" is 100 to Number and 1 to parseInt; a second parse would disagree
    // with the value that was validated. Accepted, and not a usage error.
    runList({ dir, limit: '1e2', json: true });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout())).toHaveProperty('items');
  });

  it('answers a --json refusal with a document, not a bare stderr line', () => {
    // A pipeline must always get something parseable: the refusal helper writes
    // `{ ok: false, error }` to stdout under --json rather than the human
    // stderr message, so a consumer can tell a refusal from an empty result.
    runList({ dir, limit: '0', json: true });
    expect(process.exitCode).toBe(2);
    const doc = JSON.parse(stdout());
    expect(doc.ok).toBe(false);
    expect(doc.error).toMatch(/Invalid --limit/);
    expect(stderr()).toBe('');
  });
});

describe('watch refuses a malformed --interval', () => {
  it.each([
    ['zero', '0'],
    ['a negative', '-5'],
    ['a non-number', 'soon'],
  ])('refuses %s', (_label, interval) => {
    runWatch(undefined, { dir, interval });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Invalid --interval/);
  });

  it('refuses a value that would overflow the timer and poll every millisecond', () => {
    // Node clamps a delay past the 32-bit signed range to 1ms, so a value that
    // plainly asks to poll almost never polls ~1000x/second — the inverse of
    // the request.
    runWatch(undefined, { dir, interval: '999999999999' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/maximum is \d+ ms/);
    expect(stderr()).toMatch(/overflows the timer/);
  });

  it('validates before resolving the trace, so a bad value is an error with nothing to watch', () => {
    // The ordering is deliberate: the typo belongs to the script that made it,
    // and must not be masked by "no running trace".
    runWatch(undefined, { dir, interval: '-1' });
    expect(stderr()).toMatch(/Invalid --interval/);
    expect(stderr()).not.toMatch(/No running trace/);
  });

  it('separates a named trace that does not exist from nothing running', () => {
    // An explicitly named trace is an error (exit 1); the auto case is a normal
    // empty state and must stay at exit 0.
    runWatch('trc_nope', { dir });
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/Trace not found/);
    err.length = 0;
    process.exitCode = 0;
    runWatch(undefined, { dir });
    expect(process.exitCode).toBe(0);
    expect(stderr()).toMatch(/No running trace/);
  });
});

describe('dashboard validates its arguments before anything else', () => {
  // Every case here refuses before the TUI is drawn or the store is opened, so
  // none of them can hang a test run on a full-screen view that exits only on
  // a keypress.
  it.each([
    ['zero', '0'],
    ['a negative', '-1'],
    ['a non-integer', '2.5'],
    ['a non-number', 'fast'],
  ])('refuses %s --refresh', (_label, refresh) => {
    runDashboard({ dir, refresh });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Invalid --refresh/);
  });

  it('refuses a --refresh that would overflow the timer', () => {
    runDashboard({ dir, refresh: '999999999' });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/maximum is \d+ seconds/);
  });

  it('reports a bad --refresh even with no terminal, ahead of the TTY refusal', () => {
    // Deliberate ordering: a typo goes to the script that made it rather than
    // being masked by the environment check. Under vitest there is no TTY, so
    // this is exactly the state a CI job is in.
    runDashboard({ dir, refresh: 'nope' });
    expect(stderr()).toMatch(/Invalid --refresh/);
    expect(stderr()).not.toMatch(/needs an interactive terminal/);
  });

  it('refuses with no interactive terminal, pointing at a scriptable alternative', () => {
    runDashboard({ dir });
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/needs an interactive terminal/);
    expect(stderr()).toMatch(/stats --json/);
  });
});
