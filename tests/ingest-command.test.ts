import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace, getTrace, createEval, listTraces } from '../src/services/trace-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { forkTrace } from '../src/services/fork-service.js';
import { runIngest } from '../src/commands/ingest.js';

/**
 * `ingest`'s command layer was untested, and the notes it prints are the whole
 * user-facing account of what a restore did and did not keep. One of them went
 * stale the moment ingest learned to restore evals -- it still said they could
 * not be restored and told the reader to re-run `agent-replay eval`, which is
 * work already done. A note that contradicts the tool is worse than no note.
 */
let dir: string;
let store: string;
let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-ingcmd-'));
  store = mkdtempSync(join(tmpdir(), 'ar-ingcmd-store-'));
  out = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  prevExit = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = prevExit;
  resetConnection();
  rmSync(dir, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
const stdout = () => noAnsi(out.join('\n'));

/** Write a document to a file and return its path. */
function docFile(name: string, doc: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(doc, null, 2));
  return p;
}

/** A source store holding one trace, plus whatever `build` adds to it. */
function sourceDoc(build: (db: ReturnType<typeof ensureDatabase>, id: string) => void, withEvals = false): unknown {
  const srcDir = mkdtempSync(join(tmpdir(), 'ar-ingcmd-src-'));
  try {
    const db = ensureDatabase(resolve(srcDir, 'traces.db'));
    const id = ingestTrace(db, {
      agent_name: 'src-bot',
      status: 'completed',
      input: { q: 'x' },
      steps: [
        { step_number: 1, step_type: 'tool_call', name: 'search' },
        { step_number: 2, step_type: 'output', name: 'done' },
      ],
    }).id;
    build(db, id);
    return JSON.parse(exportTraces(db, {}, 'json', { withEvals }));
  } finally {
    resetConnection();
    rmSync(srcDir, { recursive: true, force: true });
  }
}

describe('ingest names a --format mismatch instead of the symptom', () => {
  // A JSON array read as JSONL answered with an "Invalid JSON on line N"
  // warning for every line of the pretty-printed file (5,664 of them for one
  // ordinary export) plus a validation error per element, and never once said
  // that --format jsonl had been pointed at a --format json file.
  const traces = [
    { agent_name: 'a', status: 'completed', input: { q: 'x' }, steps: [{ step_number: 1, step_type: 'output', name: 'done' }] },
  ];

  it('says the file is a JSON array, and how to read it', () => {
    // The parse failure is reported through the spinner, which writes straight
    // to process.stderr rather than console.error.
    const written: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    try {
      runIngest(docFile('array.json', traces), { dir: store, format: 'jsonl' });
    } finally {
      writeSpy.mockRestore();
    }
    const text = noAnsi([...written, ...out].join('\n'));
    expect(text).toMatch(/JSON array, but --format jsonl was given/);
    // Both remedies it offers must actually resolve the case it names.
    expect(text).toMatch(/--format json/);
    expect(text).toMatch(/auto-detect/);
    // And the symptom-storm it replaced must be gone.
    expect(text).not.toMatch(/Invalid JSON on line/);
    // Nothing was stored from a file it could not read.
    const db = ensureDatabase(resolve(store, 'traces.db'));
    expect(listTraces(db, {}).total).toBe(0);
  });

  it('reads the same file when the format is right, and when it is omitted', () => {
    const file = docFile('array2.json', traces);
    runIngest(file, { dir: store, format: 'json' });
    const db = ensureDatabase(resolve(store, 'traces.db'));
    expect(listTraces(db, {}).total).toBe(1);
    runIngest(file, { dir: store });
    expect(listTraces(db, {}).total).toBe(2);
  });

  it('still reads a real JSONL file', () => {
    // The cry-wolf guard: the tell is a leading bracket, not the flag itself.
    const p = join(dir, 'real.jsonl');
    writeFileSync(p, traces.map((t) => JSON.stringify(t)).join('\n') + '\n');
    runIngest(p, { dir: store, format: 'jsonl' });
    const db = ensureDatabase(resolve(store, 'traces.db'));
    expect(listTraces(db, {}).total).toBe(1);
  });
});

describe('ingest refuses a golden dataset', () => {
  // A golden entry carries `agent_name` and `input`, so validation passed and
  // ingest reported "Ingested 20 trace(s) successfully" -- while storing 20
  // traces with NO steps, because a golden file's steps live in
  // `steps_summary`. Those stepless traces look like real runs: they widen
  // `list` and `stats`, and a golden dataset exported later includes them, so a
  // baseline made of empty runs gates CI on nothing. `check` already refuses
  // the mirror mistake (a --format json export handed to the gate).
  const golden = [
    { id: 'trc_a', agent_name: 'g', input: { q: 'x' }, expected_output: {}, steps_summary: [{ step_number: 1, step_type: 'output', name: 'done', failed: false }], eval_criteria: [], metadata: { status: 'completed' } },
  ];

  it('refuses with exit 2 and stores nothing', () => {
    runIngest(docFile('golden.json', golden), { dir: store });
    expect(process.exitCode).toBe(2);
    const db = ensureDatabase(resolve(store, 'traces.db'));
    expect(listTraces(db, {}).total).toBe(0);
  });

  it('names the right command for the file, and for the traces', () => {
    // Following a refusal's own advice must resolve the case it names: the file
    // belongs to `check --golden`, and traces come from a --format json export.
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
    try {
      runIngest(docFile('golden2.json', golden), { dir: store });
      const text = noAnsi(errs.join('\n'));
      expect(text).toMatch(/check --golden/);
      expect(text).toMatch(/--format json/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('still ingests a trace export whose trace has no steps', () => {
    // The cry-wolf guard: `steps: []` is a legitimate trace, not a golden file.
    // The tell is `steps_summary`, a key a trace export never writes.
    runIngest(docFile('empty.json', [{ agent_name: 'empty-bot', status: 'completed', input: { q: 'x' }, steps: [] }]), { dir: store });
    expect(process.exitCode).toBe(0);
    const db = ensureDatabase(resolve(store, 'traces.db'));
    expect(listTraces(db, {}).total).toBe(1);
  });
});

describe('ingest reports what it actually restored', () => {
  it('restores stored evals without claiming it cannot', () => {
    const doc = sourceDoc((db, id) => {
      createEval(db, id, { evaluator_type: 'rubric', evaluator_name: 'accuracy', score: 0.5, passed: true });
    }, true);
    runIngest(docFile('evals.json', doc), { dir: store });

    // The note this replaced said the evals "cannot be restored" and told the
    // reader to re-run `agent-replay eval` -- work already done by the restore.
    expect(stdout()).not.toMatch(/cannot be restored/);
    expect(stdout()).not.toMatch(/Re-run `agent-replay eval`/);

    const db = ensureDatabase(resolve(store, 'traces.db'));
    const restored = listTraces(db, {}).items[0];
    expect(getTrace(db, restored.id)!.evals).toHaveLength(1);
  });

  it('says a fork is restored as an ordinary trace, and what that costs', () => {
    const doc = sourceDoc((db, id) => {
      forkTrace(db, id, 1);
    });
    runIngest(docFile('fork.json', doc), { dir: store });

    const text = stdout();
    expect(text).toMatch(/1 trace\(s\) in this file are forks/);
    // The golden consequence is the damaging one and was missing from the note
    // while its own code comment listed it first: a restored fork is no longer
    // identifiable as one, so a baseline built afterwards includes a
    // never-executed copy of a step prefix, which a real run that stopped early
    // then reproduces and passes against.
    expect(text).toMatch(/golden/);
    expect(text).toMatch(/check.*watch|watch.*check/);
  });

  it('stays quiet about forks when the file has none', () => {
    // The cry-wolf guard: the note must key off the file's contents.
    const doc = sourceDoc(() => {});
    runIngest(docFile('plain.json', doc), { dir: store });
    expect(stdout()).not.toMatch(/are forks/);
  });

  it('shows the fork note under --dry-run, which previews the real run', () => {
    // A preview that omits the one thing the real run warns about is exactly
    // the surprise it exists to prevent.
    const doc = sourceDoc((db, id) => {
      forkTrace(db, id, 1);
    });
    runIngest(docFile('fork2.json', doc), { dir: store, dryRun: true });
    expect(stdout()).toMatch(/are forks/);
    // And it really was a preview: nothing was inserted.
    const db = ensureDatabase(resolve(store, 'traces.db'));
    expect(listTraces(db, {}).total).toBe(0);
  });
});
