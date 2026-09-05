import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { runEvalCommand } from '../src/commands/eval.js';
import type { IngestTraceInput } from '../src/models/types.js';

/**
 * `eval --rubric <file>` reads a file the user WROTE, and its parser carries
 * eleven distinct validations — every one added because the alternative was a
 * false CI verdict on a correct trace, not a crash. None of them was covered:
 * the rubric tests exercised `runCustomRubric` (the scorer) and never the file
 * path that feeds it. This is that path.
 *
 * A rubric error is exit 2 (a usage error), never exit 1, so a CI job can tell
 * "your rubric is broken" from "the agent regressed".
 */
const TRACE: IngestTraceInput = {
  agent_name: 'rubric-bot',
  status: 'completed',
  input: { q: 'hello' },
  output: { text: 'the answer is 42' },
  steps: [{ step_number: 1, step_type: 'output', name: 'done', output: { text: 'the answer is 42' } }],
};

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;
let id: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-rubric-'));
  const db = ensureDatabase(resolve(dir, 'traces.db'));
  id = ingestTrace(db, TRACE).id;
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

/** Write a rubric file and evaluate the seeded trace against it. */
async function evalRubric(body: string, ext = 'json', opts: Record<string, unknown> = {}): Promise<void> {
  const file = join(dir, `rubric.${ext}`);
  writeFileSync(file, body);
  await runEvalCommand(id, { rubric: file, dir, ...opts });
}

const VALID = {
  name: 'quality',
  threshold: 0.5,
  criteria: [{ name: 'mentions the answer', pattern: '42', expected: true }],
};

describe('a rubric file that works', () => {
  it('scores the trace and passes', async () => {
    await evalRubric(JSON.stringify(VALID));
    expect(process.exitCode).toBe(0);
    expect(noAnsi(out.join('\n'))).toMatch(/quality/);
  });

  it('reads YAML as readily as JSON', async () => {
    await evalRubric(
      'name: quality\nthreshold: 0.5\ncriteria:\n  - name: has answer\n    pattern: "42"\n    expected: true\n',
      'yaml',
    );
    expect(process.exitCode).toBe(0);
  });

  it('accepts a quoted threshold and weight, as a YAML author writes them', async () => {
    // Both arrive as strings from YAML. Left uncoerced, `score >= "0.5"` and
    // `totalWeight += "2"` would silently fail or corrupt the aggregate.
    await evalRubric(
      'name: quality\nthreshold: "0.5"\ncriteria:\n  - name: has answer\n    pattern: "42"\n    expected: true\n    weight: "2"\n',
      'yaml',
    );
    expect(process.exitCode).toBe(0);
  });

  it('fails the gate when the trace misses the threshold', async () => {
    await evalRubric(JSON.stringify({
      name: 'strict', threshold: 0.9,
      criteria: [{ name: 'mentions unicorns', pattern: 'unicorn', expected: true }],
    }));
    // Exit 1 — a genuine quality failure, distinct from a broken rubric (2).
    expect(process.exitCode).toBe(1);
  });
});

describe('a rubric file that cannot be trusted is a usage error, not a verdict', () => {
  it.each([
    ['a file that does not exist', null, /Rubric error/],
    ['a file that is not JSON', '{oops', /Rubric error/],
    ['an empty JSON file', '', /Rubric error/],
    ['a bare list', '[1,2,3]', /object with "name" and "criteria"/],
    ['no name', JSON.stringify({ criteria: [{ name: 'a', pattern: 'x', expected: true }] }), /must have a "name"/],
    ['no criteria', JSON.stringify({ name: 'r' }), /non-empty "criteria" array/],
    ['an empty criteria array', JSON.stringify({ name: 'r', criteria: [] }), /non-empty "criteria" array/],
    ['a threshold above 1', JSON.stringify({ ...VALID, threshold: 5 }), /"threshold".*between 0 and 1/],
    ['a non-numeric threshold', JSON.stringify({ ...VALID, threshold: 'high' }), /"threshold".*between 0 and 1/],
    ['a criterion with no name', JSON.stringify({ name: 'r', criteria: [{ pattern: 'x', expected: true }] }), /criteria\[0\] must have a "name"/],
    ['a criterion with no pattern', JSON.stringify({ name: 'r', criteria: [{ name: 'a', expected: true }] }), /criteria\[0\] must have a "pattern"/],
    ['a criterion with no expected', JSON.stringify({ name: 'r', criteria: [{ name: 'a', pattern: 'x' }] }), /criteria\[0\] must have an "expected"/],
    ['a negative weight', JSON.stringify({ name: 'r', criteria: [{ name: 'a', pattern: 'x', expected: true, weight: -1 }] }), /"weight".*non-negative/],
    ['every weight zero', JSON.stringify({ name: 'r', criteria: [{ name: 'a', pattern: 'x', expected: true, weight: 0 }] }), /at least one criterion with a weight greater than 0/],
    ['duplicate criterion names', JSON.stringify({ name: 'r', criteria: [
      { name: 'dup', pattern: 'x', expected: true }, { name: 'dup', pattern: 'y', expected: true }] }), /two criteria named "dup"/],
    ['an uncompilable pattern', JSON.stringify({ name: 'r', criteria: [{ name: 'a', pattern: '(unclosed', expected: true }] }), /could not be used/],
    ['a backtracking-risk pattern', JSON.stringify({ name: 'r', criteria: [{ name: 'a', pattern: '(a|aa)+', expected: true }] }), /backtracking risk/],
  ])('refuses %s', async (_label, body, pattern) => {
    if (body === null) {
      await runEvalCommand(id, { rubric: join(dir, 'nope.json'), dir });
    } else {
      await evalRubric(body);
    }
    // Exit 2, never 1: a CI job must be able to tell "your rubric is broken"
    // from "the agent regressed".
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(pattern);
  });

  it('refuses an empty YAML file by naming the shape, not the JavaScript', async () => {
    // An empty YAML file parses to `null`, which then failed on `parsed.name`
    // with "Cannot read properties of null" — naming JavaScript rather than the
    // file the user wrote. (An empty .json file fails earlier, at JSON.parse.)
    await evalRubric('', 'yaml');
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/object with "name" and "criteria"/);
    expect(stderr()).not.toMatch(/Cannot read properties/);
  });

  it('names the YAML parse error rather than blaming a missing package', async () => {
    // This claimed a missing `yaml` dependency for ANY throw, discarding the one
    // thing a YAML author needs: where the file is malformed.
    await evalRubric('name: quality\ncriteria:\n  - [unclosed\n', 'yaml');
    expect(process.exitCode).toBe(2);
    expect(stderr()).toMatch(/Failed to parse YAML rubric/);
    expect(stderr()).not.toMatch(/npm install/);
  });

  it('answers a rubric error as JSON when --json was asked for', async () => {
    await evalRubric('{oops', 'json', { json: true });
    const doc = JSON.parse(noAnsi(out.join('\n')));
    expect(doc.ok).toBe(false);
    expect(doc.error).toMatch(/Rubric error/);
    expect(process.exitCode).toBe(2);
  });
});
