import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, createEval } from '../src/services/trace-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { checkGolden, inputHash, stableStringify } from '../src/services/check-service.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { runCheck } from '../src/commands/check.js';
import type { GoldenEntry } from '../src/services/export-service.js';
import type { IngestTraceInput, TraceWithDetails } from '../src/models/types.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

const baseline: IngestTraceInput = {
  agent_name: 'travel-bot',
  status: 'completed',
  input: { task: 'book a flight', dest: 'JFK' },
  steps: [
    { step_number: 1, step_type: 'thought', name: 'plan' },
    { step_number: 2, step_type: 'tool_call', name: 'search_flights', input: { origin: 'SFO', dest: 'JFK' } },
    { step_number: 3, step_type: 'output', name: 'confirm' },
  ],
};

/** Ingest the baseline and return the golden dataset built from it. */
function makeGolden(): GoldenEntry[] {
  ingestTrace(db, baseline);
  return JSON.parse(exportTraces(db, { agent_name: 'travel-bot' }, 'golden')) as GoldenEntry[];
}

function candidate(input: IngestTraceInput): TraceWithDetails {
  const t = ingestTrace(db, input);
  return getTrace(db, t.id)!;
}

// ── Hashing ────────────────────────────────────────────────────────────────

describe('input hashing', () => {
  it('is stable regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
  });
});

// ── Golden check ─────────────────────────────────────────────────────────

describe('checkGolden', () => {
  it('passes a structurally identical run', () => {
    const golden = makeGolden();
    const report = checkGolden(golden, [candidate(baseline)]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('flags a baseline tool call the candidate replaced with another step type', () => {
    // The tool_inputs guard used to skip whenever the CANDIDATE was not a
    // tool_call, so the disappearance of a baseline tool call — the thing this
    // field exists to catch — was invisible. Under the default allowlist
    // step_types happened to catch it; with --fields tool_inputs, nothing did.
    const golden = makeGolden();
    const swapped: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 2, step_type: 'llm_call', name: 'search_flights', input: { origin: 'SFO', dest: 'JFK' } },
        { step_number: 3, step_type: 'output', name: 'confirm' },
      ],
    };

    const report = checkGolden(golden, [candidate(swapped)], { fields: ['tool_inputs'] });
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.results[0].divergences[0].field).toBe('tool_inputs');
    // A faithful reproduction still passes on the same field.
    expect(checkGolden(golden, [candidate(baseline)], { fields: ['tool_inputs'] }).ok).toBe(true);
  });

  it('reports baselines no candidate exercised, and fails them under --strict', () => {
    // The verdict was candidate-driven only: a scenario whose run crashed, or
    // recorded under a different agent name, simply never appeared — the gate
    // reported "1 passed" and exited 0 while the rest of the baseline went
    // unchecked.
    const golden = makeGolden();
    ingestTrace(db, { ...baseline, agent_name: 'other-bot', input: { task: 'other' } });
    const extra = JSON.parse(exportTraces(db, { agent_name: 'other-bot' }, 'golden')) as GoldenEntry[];
    const both = [...golden, ...extra];

    const report = checkGolden(both, [candidate(baseline)]);
    expect(report.passed).toBe(1);
    expect(report.uncovered).toBe(1);
    expect(report.ok).toBe(true); // reported, but not a failure by default

    // --strict, which already fails on an unmatched candidate, fails here too.
    expect(checkGolden(both, [candidate(baseline)], { strict: true }).ok).toBe(false);
    // Exercising every baseline leaves nothing uncovered.
    const full = checkGolden(both, [candidate(baseline), candidate({ ...baseline, agent_name: 'other-bot', input: { task: 'other' } })], { strict: true });
    expect(full.uncovered).toBe(0);
    expect(full.ok).toBe(true);
  });

  it('pairs distinct candidates that share an agent+input key without false regressions', () => {
    // Two runs of the same agent with the same input but different shapes — an
    // original and its fork, say. A plain golden index kept only the last, so
    // the other candidate matched the wrong entry and "regressed".
    const shapeA: IngestTraceInput = { agent_name: 'dup', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'output', name: 'a' }] };
    const shapeB: IngestTraceInput = { agent_name: 'dup', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'thought', name: 'x' }, { step_number: 2, step_type: 'output', name: 'b' }] };
    ingestTrace(db, shapeA);
    ingestTrace(db, shapeB);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'dup' }, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(2);

    const report = checkGolden(golden, [candidate(shapeA), candidate(shapeB)]);
    expect(report.ok).toBe(true); // each candidate matched its own counterpart
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
  });

  it('passes every candidate that reproduces one baseline when the bucket holds other shapes', () => {
    // A golden bucket holds two known-good shapes (A and B) for one agent+input.
    // Two candidates that both reproduce shape A must BOTH pass: a candidate is
    // good if it matches ANY baseline. The greedy version consumed A's entry for
    // the first candidate and forced the second onto B, falsely "regressing" a
    // trace that exactly reproduces a known-good run.
    const shapeA: IngestTraceInput = { agent_name: 'dup2', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'output', name: 'a' }] };
    const shapeB: IngestTraceInput = { agent_name: 'dup2', status: 'completed', input: { task: 't' }, steps: [{ step_number: 1, step_type: 'thought', name: 'x' }, { step_number: 2, step_type: 'output', name: 'b' }] };
    ingestTrace(db, shapeA);
    ingestTrace(db, shapeB);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'dup2' }, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(2);

    const report = checkGolden(golden, [candidate(shapeA), candidate(shapeA)]);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('fails and names the divergent field when a tool input changes', () => {
    const golden = makeGolden();
    const altered: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 2, step_type: 'tool_call', name: 'search_flights', input: { origin: 'SFO', dest: 'LAX' } },
        { step_number: 3, step_type: 'output', name: 'confirm' },
      ],
    };
    const report = checkGolden(golden, [candidate(altered)]);
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    const div = report.results[0].divergences.find((d) => d.field === 'tool_inputs')!;
    expect(div).toBeTruthy();
    expect(div.step_number).toBe(2);
  });

  it('catches a tool-input regression even when the candidate renumbers its steps', () => {
    // step_types/step_names align positionally, so tool_inputs must too. A valid
    // candidate can number its steps differently from the golden (step_number
    // need only be >= 1 and may be gapped — e.g. an OTLP-assembled or imported
    // trace). Aligning tool_inputs by absolute step_number made the candidate's
    // tool_call miss its golden counterpart, so a real regression slipped through
    // while the positional checks reported a perfect match.
    const golden = makeGolden(); // baseline: tool_call at step 2, input dest: JFK
    const renumbered: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 3, step_type: 'tool_call', name: 'search_flights', input: { origin: 'SFO', dest: 'LAX' } },
        { step_number: 5, step_type: 'output', name: 'confirm' },
      ],
    };
    const report = checkGolden(golden, [candidate(renumbered)]);
    expect(report.ok).toBe(false);
    expect(report.results[0].divergences.some((d) => d.field === 'tool_inputs')).toBe(true);
  });

  it('detects a changed step sequence', () => {
    const golden = makeGolden();
    const altered: IngestTraceInput = {
      ...baseline,
      steps: [
        { step_number: 1, step_type: 'thought', name: 'plan' },
        { step_number: 2, step_type: 'tool_call', name: 'search_hotels', input: { origin: 'SFO', dest: 'JFK' } },
        { step_number: 3, step_type: 'output', name: 'confirm' },
      ],
    };
    const report = checkGolden(golden, [candidate(altered)]);
    expect(report.results[0].divergences.some((d) => d.field === 'step_names')).toBe(true);
  });

  it('flags a final-status regression', () => {
    const golden = makeGolden();
    const failed: IngestTraceInput = { ...baseline, status: 'failed' };
    const report = checkGolden(golden, [candidate(failed)]);
    expect(report.results[0].divergences.some((d) => d.field === 'status')).toBe(true);
  });

  it('reports unmatched candidates as pass unless --strict', () => {
    const golden = makeGolden();
    const other = candidate({ ...baseline, input: { task: 'totally different' } });
    expect(checkGolden(golden, [other]).ok).toBe(true);
    expect(checkGolden(golden, [other]).unmatched).toBe(1);
    expect(checkGolden(golden, [other], { strict: true }).ok).toBe(false);
  });

  it('honors a --fields allowlist (ignoring status when excluded)', () => {
    const golden = makeGolden();
    const failed = candidate({ ...baseline, status: 'failed' });
    const report = checkGolden(golden, [failed], { fields: ['step_count', 'step_names'] });
    expect(report.ok).toBe(true);
  });

  it('catches a model change only when model is opted into via --fields', () => {
    const withModel: IngestTraceInput = {
      agent_name: 'travel-bot',
      status: 'completed',
      input: { task: 'book a flight', dest: 'JFK' },
      steps: [{ step_number: 1, step_type: 'llm_call', name: 'gen', model: 'gpt-4' }],
    };
    ingestTrace(db, withModel);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'travel-bot' }, 'golden')) as GoldenEntry[];
    const swapped = candidate({ ...withModel, steps: [{ ...withModel.steps![0], model: 'gpt-5.4-nano' }] });

    // Default fields ignore model → passes despite the swap.
    expect(checkGolden(golden, [swapped]).ok).toBe(true);
    // Opt in → the swap is a divergence.
    const report = checkGolden(golden, [swapped], { fields: ['model'] });
    expect(report.ok).toBe(false);
    expect(report.results[0].divergences[0].field).toBe('model');
  });

  it('rejects an unknown --fields value instead of silently passing', () => {
    const golden = makeGolden();
    expect(() => checkGolden(golden, [candidate(baseline)], { fields: ['bogus'] })).toThrow(/Unknown --fields/);
  });
});

describe('exportTraces formats', () => {
  it('exports JSONL with one JSON object per line', () => {
    ingestTrace(db, { agent_name: 'e1', status: 'completed', input: { a: 1 }, steps: [{ step_number: 1, step_type: 'output', name: 'x' }] });
    ingestTrace(db, { agent_name: 'e2', status: 'completed', input: { b: 2 }, steps: [{ step_number: 1, step_type: 'output', name: 'y' }] });
    const lines = exportTraces(db, {}, 'jsonl').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.map((l) => JSON.parse(l).agent_name).sort()).toEqual(['e1', 'e2']);
  });

  it('carries a trace\'s eval_criteria into the golden export', () => {
    const t = ingestTrace(db, { agent_name: 'g', status: 'completed', input: { a: 1 }, steps: [{ step_number: 1, step_type: 'output', name: 'x' }] });
    createEval(db, t.id, { evaluator_type: 'rubric', evaluator_name: 'quality', score: 0.9, passed: true, details: {} });
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];
    expect(golden[0].eval_criteria).toEqual([{ evaluator_name: 'quality', score: 0.9, passed: true }]);
  });

  it('exports every matching trace, past the old 10000 fixed cap', () => {
    // Regression: `exportTraces` used to pass a hard `limit: 10000` to
    // `listTraces` (despite a comment claiming it removed the limit), silently
    // truncating any larger export and corrupting datasets built from it. It now
    // passes an unbounded limit. Insert rows straight into the table (fast; no
    // per-trace step machinery needed) and assert the full set comes back.
    const N = 10001;
    const insert = db.prepare(
      `INSERT INTO agent_traces (id, agent_name, trigger, status, input, started_at, tags, metadata, created_at)
       VALUES (?, 'bulk', 'manual', 'completed', '{}', ?, '[]', '{}', ?)`,
    );
    const now = new Date().toISOString();
    const many = db.transaction(() => {
      for (let i = 0; i < N; i++) {
        // Distinct started_at so the sort is stable; zero-padded so ids/order don't collide.
        const ts = new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString();
        insert.run(`trc_bulk_${String(i).padStart(6, '0')}`, ts, now);
      }
    });
    many();

    const jsonl = exportTraces(db, { agent_name: 'bulk' }, 'jsonl').trim();
    const lines = jsonl.length ? jsonl.split('\n') : [];
    expect(lines).toHaveLength(N);
    // Exporting 10k+ traces means a getTrace per row, so give this real headroom
    // over the default 5s — the point is correctness (nothing dropped), not speed.
  }, 120_000);
});

// ── check command: candidate gathering has no fixed cap ──────────────────────

describe('runCheck gathers every candidate trace', () => {
  it('scans past the newest 10000 so a regression in an older trace cannot slip through green', () => {
    // Regression: the bulk `check --golden` path passed `listTraces` a hard
    // `limit: 10000` (the same defect already fixed in `exportTraces`). On a
    // store with >10000 traces, every candidate older than the newest 10000 was
    // never fetched or diffed — a real regression there produced 0 failures and a
    // green exit, defeating the gate's core contract. It now scans unbounded.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-cap-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db')); // the singleton runCheck reopens

      // One real baseline candidate (matches the golden); build golden from it.
      ingestTrace(cdb, baseline);
      const golden = exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden');
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, golden);

      // 10001 older traces (raw insert — fast, no step machinery). Their 2020
      // timestamps sort them *below* the just-ingested baseline, so a 10000 cap
      // (newest-first) would drop the oldest — exactly where a regression hides.
      const N = 10001;
      const insert = cdb.prepare(
        `INSERT INTO agent_traces (id, agent_name, trigger, status, input, started_at, tags, metadata, created_at)
         VALUES (?, 'bulk', 'manual', 'completed', '{}', ?, '[]', '{}', ?)`,
      );
      const now = new Date().toISOString();
      cdb.transaction(() => {
        for (let i = 0; i < N; i++) {
          const ts = new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString();
          insert.run(`trc_bulk_${String(i).padStart(6, '0')}`, ts, now);
        }
      })();

      // Capture the --json report (one result per candidate scanned).
      const out: string[] = [];
      const prevExit = process.exitCode;
      const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
        out.push(String(m));
      });
      try {
        runCheck({ golden: goldenPath, dir, json: true });
      } finally {
        spy.mockRestore();
      }
      const report = JSON.parse(out.join('\n')) as { results: unknown[] };
      // Every one of the 10002 candidates (baseline + 10001 bulk) must be scanned.
      // Under the old cap this capped at 10000 and silently dropped the oldest.
      expect(report.results).toHaveLength(N + 1);
      process.exitCode = prevExit; // runCheck sets exitCode; don't leak it to the runner
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ── check command: an empty golden baseline is not a passing gate ────────────

describe('runCheck refuses an empty golden baseline', () => {
  it('exits 2 instead of reporting a vacuous green gate', () => {
    // Regression: `export --format golden` writes `[]` when its filter matches
    // nothing (a mistyped --tag is enough) and exits 0. `check --golden` then
    // accepted that file: with no entries every candidate fell to the
    // `unmatched` branch, which passes unless --strict, so the run printed
    // "0 passed, 0 regressed" in green and exited 0 — forever. The CI gate was
    // entirely vacuous and nothing told the user.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-empty-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);

      const emptyPath = join(dir, 'empty-golden.json');
      writeFileSync(emptyPath, '[]\n');

      const prevExit = process.exitCode;
      process.exitCode = 0;
      const errs: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
        errs.push(String(m));
      });
      try {
        runCheck({ golden: emptyPath, dir });
      } finally {
        spy.mockRestore();
      }
      expect(process.exitCode).toBe(2);
      expect(errs.join('\n')).toMatch(/no entries/i);
      process.exitCode = prevExit;

      // A non-empty baseline still runs normally.
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));
      const prev2 = process.exitCode;
      process.exitCode = 0;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        runCheck({ golden: goldenPath, dir });
      } finally {
        logSpy.mockRestore();
      }
      expect(process.exitCode).toBe(0);
      process.exitCode = prev2;
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCheck refuses a gate with nothing to check', () => {
  function checkWith(opts: Record<string, unknown>): { exit: number | undefined; errs: string } {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runCheck(opts);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
    const exit = process.exitCode;
    process.exitCode = prevExit;
    return { exit, errs: errs.join('\n') };
  }

  it('exits 2 when no candidate trace matches the filters', () => {
    // The empty-baseline failure from the other side: with zero candidates the
    // report is "0 passed, 0 regressed", ok, exit 0 — and --strict doesn't help,
    // since `unmatched` only counts candidates that were fetched. A mistyped
    // --agent or a --since window that outran the run leaves the gate green.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-nocand-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));

      const typo = checkWith({ golden: goldenPath, dir, agent: 'no-such-agent' });
      expect(typo.exit).toBe(2);
      expect(typo.errs).toMatch(/no traces matched/i);
      // Even with --strict, which was the flag users reached for to harden this.
      expect(checkWith({ golden: goldenPath, dir, agent: 'no-such-agent', strict: true }).exit).toBe(2);
      // The same gate with a matching filter still passes.
      expect(checkWith({ golden: goldenPath, dir, agent: 'travel-bot' }).exit).toBe(0);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with a diagnosis when handed a full JSON export instead of a golden one', () => {
    // `--format json` and `--format golden` are one flag apart. The full export
    // has no steps_summary, so the comparison died on `.length` with a bare
    // "Cannot read properties of undefined", naming neither file nor cause.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-wrongfmt-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);
      const wrongPath = join(dir, 'traces.json');
      writeFileSync(wrongPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'json'));

      const r = checkWith({ golden: wrongPath, dir });
      expect(r.exit).toBe(2);
      expect(r.errs).toMatch(/not a golden dataset/i);
      expect(r.errs).toMatch(/steps_summary/);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('export --format golden warns about a baseline it cannot trust', () => {
  it('names entries that did not come from a completed run', async () => {
    // A baseline is meant to hold known-good runs, but nothing filters by
    // status: a `running` entry bakes in a partial shape, so the next correct
    // run "regresses" against it, and a `failed` entry makes reproducing the
    // failure pass green.
    const { runExport } = await import('../src/commands/export.js');
    const dir = mkdtempSync(join(tmpdir(), 'ar-export-warn-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);
      ingestTrace(cdb, { ...baseline, agent_name: 'flaky-bot', status: 'failed' });

      const errs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
      const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        runExport(undefined, { format: 'golden', dir });
      } finally {
        errSpy.mockRestore();
        outSpy.mockRestore();
      }
      expect(errs.join('\n')).toMatch(/1 of 2 baseline entry is not from a completed run/);

      // A baseline built only from completed runs says nothing.
      const clean: string[] = [];
      const cleanSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void clean.push(String(m)));
      const outSpy2 = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        runExport(undefined, { format: 'golden', dir, status: 'completed' });
      } finally {
        cleanSpy.mockRestore();
        outSpy2.mockRestore();
      }
      expect(clean.join('\n')).not.toMatch(/not from a completed run/);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── export: an empty jsonl export is an empty file ──────────────────────────

describe('exportTraces jsonl with no matches', () => {
  it('emits an empty file, not one blank line', () => {
    // Regression: `[].map(...).join('\n') + '\n'` is exactly "\n", so a
    // zero-match export produced a one-line file. A strict streaming consumer
    // (`line => JSON.parse(line)`) threw "Unexpected end of JSON input" on it,
    // and `wc -l` reported one record where there were none. The json format
    // correctly emits "[]".
    ingestTrace(db, baseline);
    expect(exportTraces(db, { agent_name: 'no-such-agent' }, 'jsonl')).toBe('');
    expect(exportTraces(db, { agent_name: 'no-such-agent' }, 'json').trim()).toBe('[]');
    // A non-empty export is unchanged: one JSON object per line, trailing NL.
    const some = exportTraces(db, { agent_name: 'travel-bot' }, 'jsonl');
    expect(some.endsWith('\n')).toBe(true);
    expect(some.trim().split('\n')).toHaveLength(1);
  });
});


describe('golden metadata keeps a trace own keys', () => {
  it('preserves a value displaced by a reserved key', () => {
    // The four reserved keys must win — `check` compares metadata.status, so a
    // trace's own `status` key displacing it would be a gate bypass, not just
    // data loss. But they overwrote silently, making the baseline a lossy
    // record of the run.
    ingestTrace(db, {
      ...baseline,
      agent_name: 'meta-bot',
      tags: ['real-tag'],
      metadata: { status: 'approved', tags: ['v2'], owner: 'team-a' },
    });
    const [entry] = JSON.parse(exportTraces(db, { agent_name: 'meta-bot' }, 'golden')) as GoldenEntry[];
    const meta = entry.metadata as Record<string, unknown>;

    // The gate still reads the trace's real status and tags.
    expect(meta.status).toBe('completed');
    expect(meta.tags).toEqual(['real-tag']);
    // The user's own values survive alongside, rather than vanishing.
    expect(meta.trace_metadata_status).toBe('approved');
    expect(meta.trace_metadata_tags).toEqual(['v2']);
    // A non-colliding key is untouched, and no spurious keys appear.
    expect(meta.owner).toBe('team-a');
    expect(meta.trace_metadata_total_tokens).toBeUndefined();
  });
});
