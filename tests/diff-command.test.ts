import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { runDiff } from '../src/commands/diff.js';
import type { IngestTraceInput } from '../src/models/types.js';

/**
 * `diff` is a headline feature whose command layer was almost entirely
 * untested — the service had coverage, the argument and output handling did
 * not, which is where the scope defect below lived.
 */
const left: IngestTraceInput = {
  agent_name: 'diff-bot', status: 'completed', input: { q: 'a' },
  steps: [
    { step_number: 1, step_type: 'tool_call', name: 'search', model: 'm1' },
    { step_number: 2, step_type: 'llm_call', name: 'answer', model: 'm1' },
  ],
};
const right: IngestTraceInput = {
  ...left, status: 'failed', error: 'broke', input: { q: 'b' },
  steps: [
    { step_number: 1, step_type: 'tool_call', name: 'search', model: 'm2' },
    { step_number: 2, step_type: 'llm_call', name: 'answer_v2', model: 'm2' },
  ],
};

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;
let a: string;
let b: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-diffcmd-'));
  const db = ensureDatabase(resolve(dir, 'traces.db'));
  a = ingestTrace(db, left).id;
  b = ingestTrace(db, right).id;
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
const doc = () => JSON.parse(noAnsi(out.join('\n')));

describe('the --json document says what it compared', () => {
  it('records the narrowed scope, so a filtered count is not read as a full one', async () => {
    // Regression: the document carried `diffs` and nothing about scope, so
    // `--fields model --json` reporting N differences was byte-for-byte the
    // shape of an unfiltered comparison that genuinely found N — and a filter
    // leaving nothing produced `"diffs": []`, which reads as "the traces are
    // identical", the one claim the human path is careful never to make.
    await runDiff(a, b, { json: true, dir });
    const full = doc();
    expect(full.compared_fields).toBeNull();
    const fullCount = full.diffs.length;

    out.length = 0;
    await runDiff(a, b, { json: true, fields: 'model', dir });
    const narrowed = doc();
    expect(narrowed.compared_fields).toEqual(['model']);
    expect(narrowed.diffs.length).toBeLessThan(fullCount);
    expect(narrowed.diffs.every((d: { field: string }) => d.field === 'model')).toBe(true);
  });

  it('records the scope even when the filter leaves no differences at all', async () => {
    // The case the README says must never read as "identical".
    await runDiff(a, b, { json: true, fields: 'trace_output', dir });
    const d = doc();
    expect(d.diffs).toEqual([]);
    expect(d.compared_fields).toEqual(['trace_output']);
  });
});

describe('diff refuses what it cannot compare', () => {
  it.each([
    ['a missing left trace', ['trc_nope', 'B'], 1, /Left trace not found/],
    ['a missing right trace', ['A', 'trc_nope'], 1, /Right trace not found/],
  ])('%s', async (_label, [l, r], code, pattern) => {
    await runDiff(l === 'A' ? a : l, r === 'B' ? b : r, { json: true, dir });
    expect(process.exitCode).toBe(code);
    expect(doc()).toMatchObject({ ok: false });
    expect(doc().error).toMatch(pattern);
  });

  it.each([
    ['--fields with no names', ',', /listed no field names/],
    ['--fields empty', '', /listed no field names/],
    ['an unknown field', 'stpe_type', /Unknown --fields value\(s\): stpe_type/],
  ])('%s is a usage error', async (_label, fields, pattern) => {
    await runDiff(a, b, { json: true, fields, dir });
    expect(process.exitCode).toBe(2);
    expect(doc().error).toMatch(pattern);
  });
});

describe('diff renders for a human', () => {
  it('shows the differences and the divergence point', async () => {
    await runDiff(a, b, { dir });
    const text = noAnsi(out.join('\n'));
    expect(process.exitCode).toBe(0);
    expect(text).toMatch(/model/);
    expect(text).toMatch(/answer_v2/);
  });

  it('summarizes in compact mode, naming the scope when narrowed', async () => {
    await runDiff(a, b, { compact: true, fields: 'model', dir });
    const text = noAnsi(out.join('\n'));
    expect(text).toMatch(/Trace Diff Summary/);
    expect(text).toMatch(/Left steps/);
    // The count must not claim a scope wider than the one it measured.
    expect(text).toMatch(/model/);
  });

  it('reports two identical traces as identical', async () => {
    await runDiff(a, a, { dir });
    expect(noAnsi(out.join('\n'))).toMatch(/identical/i);
    expect(process.exitCode).toBe(0);
  });
});

describe('diff says when --compact does nothing under --json', () => {
  // `--compact` selects a summary panel over the full rendered comparison: it
  // shapes the human view alone, and the JSON document is the same either way.
  // Passing both was silently identical to passing neither, so a caller asking
  // for a smaller payload got the full one with no word of it.
  it('warns that --compact has no effect with --json', async () => {
    await runDiff(a, b, { dir, json: true, compact: true });
    expect(noAnsi(err.join('\n'))).toMatch(/--compact has no effect with --json/);
  });

  it('says nothing for --json or --compact on their own', async () => {
    // The cry-wolf guard, on both sides: --compact is the whole point of the
    // human summary view, and must not warn there.
    await runDiff(a, b, { dir, json: true });
    expect(noAnsi(err.join('\n'))).not.toMatch(/no effect/);
    err.length = 0;
    await runDiff(a, b, { dir, compact: true });
    expect(noAnsi(err.join('\n'))).not.toMatch(/no effect/);
  });

  it('keeps the warning off stdout and the document intact', async () => {
    await runDiff(a, b, { dir, json: true, compact: true });
    expect(noAnsi(out.join('\n'))).not.toMatch(/no effect/);
        // The document is the full one, unchanged by --compact -- which is exactly
    // why the warning is warranted.
    expect(doc()).toHaveProperty('diffs');
    expect(doc()).toHaveProperty('left_step_count', 2);
  });
});
