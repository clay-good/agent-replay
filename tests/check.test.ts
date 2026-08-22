import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, getTrace, createEval, deleteTrace } from '../src/services/trace-service.js';
import { exportTraces } from '../src/services/export-service.js';
import { checkGolden, inputHash, stableStringify } from '../src/services/check-service.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { runCheck } from '../src/commands/check.js';
import { forkTrace } from '../src/services/fork-service.js';
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

  it('counts uncovered baseline ENTRIES, not the scenarios they group into', () => {
    // The golden index buckets entries by agent+input, so counting unmatched
    // KEYS reported "1 baseline not exercised" for a file holding a hundred
    // untouched entries — under-stating the very hole the message names.
    const shape = (name: string): IngestTraceInput => ({
      agent_name: 'twin-bot',
      status: 'completed',
      input: { task: 'same' },
      steps: [{ step_number: 1, step_type: 'output', name }],
    });
    ingestTrace(db, shape('a'));
    ingestTrace(db, shape('b'));
    ingestTrace(db, shape('c'));
    const golden = JSON.parse(exportTraces(db, { agent_name: 'twin-bot' }, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(3); // three entries, one bucket

    expect(checkGolden(golden, []).uncovered).toBe(3);
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

// ── check command: rendered producer text is escaped ─────────────────────────

describe('runCheck escapes producer text in its human-readable report', () => {
  it('does not echo raw control bytes from an agent name or a divergence value', () => {
    // `check` was the only human-readable renderer with no `safeText`. Both the
    // agent name and the divergence values are producer output — and the golden
    // side arrives from a baseline FILE that may have been shared or downloaded.
    // A lone CR there returns the cursor to column 0 and lets the next bytes
    // overwrite the `REGRESSED` line, so the gate can be made to misreport its
    // own verdict; an OSC sequence retitles the operator's terminal.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-esc-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      const evil = 'bot\u001b]0;pwned\u0007\rALL PASSED';
      // Baseline and candidate share the input (so they match) but differ in a
      // step name carrying the payload — that difference is what gets rendered.
      ingestTrace(cdb, {
        agent_name: evil,
        status: 'completed',
        input: { task: 'x' },
        steps: [{ step_number: 1, step_type: 'tool_call', name: 'good_name', input: { a: 1 } }],
      });
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: evil }, 'golden'));
      deleteTrace(cdb, (JSON.parse(exportTraces(cdb, { agent_name: evil }, 'golden')) as GoldenEntry[])[0].id);
      ingestTrace(cdb, {
        agent_name: evil,
        status: 'completed',
        input: { task: 'x' },
        steps: [{ step_number: 1, step_type: 'tool_call', name: evil, input: { a: 1 } }],
      });

      const out: string[] = [];
      const prevExit = process.exitCode;
      const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
        out.push(String(m));
      });
      try {
        runCheck({ golden: goldenPath, dir });
      } finally {
        spy.mockRestore();
      }
      const text = out.join('\n');
      // The payload is reported (this is a real regression) but never as raw bytes.
      expect(text).toContain('REGRESSED');
      expect(text).not.toContain('\u001b');
      expect(text).not.toContain('\u0007');
      expect(text).not.toMatch(/\r(?!\n)/);
      expect(text).toContain('\\x1b');
      process.exitCode = prevExit;
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

  it('answers in JSON when --json was asked for, on every refusal path', () => {
    // `check --json | jq -r .ok` is the documented CI form. Printing only a red
    // line on stderr turned "the gate could not run" into a jq parse error —
    // breaking the --json contract rather than reporting a verdict.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-jsonfail-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));

      const out: string[] = [];
      const prevExit = process.exitCode;
      process.exitCode = 0;
      const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void out.push(String(m)));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        runCheck({ golden: goldenPath, dir, agent: 'no-such-agent', json: true });
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
      const exit = process.exitCode;
      process.exitCode = prevExit;

      expect(exit).toBe(2);
      const parsed = JSON.parse(out.join('\n')) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/no traces matched/i);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an empty run under --allow-empty', () => {
    // A nightly window with no runs, or a matrix job where this agent did not
    // run, is legitimately empty — and the refusal has to have an escape hatch
    // that is not "stop running the gate".
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-allowempty-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));

      expect(checkWith({ golden: goldenPath, dir, agent: 'no-such-agent' }).exit).toBe(2);
      expect(checkWith({ golden: goldenPath, dir, agent: 'no-such-agent', allowEmpty: true }).exit).toBe(0);
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

      // Warned for EVERY golden export. It used to be file-only, on the
      // reasoning that a warning would be noise in a pipeline — but the
      // warning goes to stderr, so it could never reach a piped stdout, and
      // the condition only suppressed it for `export --format golden >
      // golden.json`. That is an ordinary idiom, and it produced a baseline
      // built from failed runs with no signal at all: the exact false green
      // this warning exists to prevent.
      const errs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void errs.push(String(m)));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        runExport(undefined, { format: 'golden', dir, output: join(dir, 'golden.json') });
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }
      expect(errs.join('\n')).toMatch(/1 of 2 baseline entry is not from a completed run/);

      // A baseline built only from completed runs says nothing.
      const clean: string[] = [];
      const cleanSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void clean.push(String(m)));
      const logSpy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        runExport(undefined, { format: 'golden', dir, status: 'completed', output: join(dir, 'clean.json') });
      } finally {
        cleanSpy.mockRestore();
        logSpy2.mockRestore();
      }
      expect(clean.join('\n')).not.toMatch(/not from a completed run/);

      // ...and the same baseline written to STDOUT warns identically.
      const piped: string[] = [];
      const pipedSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => void piped.push(String(m)));
      const logSpy3 = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        runExport(undefined, { format: 'golden', dir });
      } finally {
        pipedSpy.mockRestore();
        logSpy3.mockRestore();
      }
      expect(piped.join('\n')).toMatch(/1 of 2 baseline entry is not from a completed run/);
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

// ── check command: a gate that compares nothing is not a passing gate ────────

/** Run `check` in-process, capturing stdout/stderr and the exit code it sets. */
function runCheckCapturing(opts: Parameters<typeof runCheck>[0]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
  try {
    runCheck(opts);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = prevExit;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('runCheck refuses when no candidate matched the baseline', () => {
  // A candidate that matches NO baseline compares exactly as much as no
  // candidate at all — nothing — yet unmatched was a pass by default while zero
  // candidates was already refused. Any change that alters every goldenKey
  // (`hook --no-input` blanking the input, an agent rename, an input-template
  // edit) left the gate green forever on runs it had stopped comparing.
  it('exits 2 in both output modes, with --allow-empty as the opt-out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-nomatch-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      const source = ingestTrace(cdb, baseline);
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));
      // The baseline run itself is not a candidate of the next CI run.
      deleteTrace(cdb, source.id);

      // The same run, captured without its input — so its goldenKey differs and
      // it can never match, however badly it regressed.
      ingestTrace(cdb, {
        ...baseline,
        input: {},
        steps: [{ step_number: 1, step_type: 'tool_call', name: 'Bash', input: { command: 'rm -rf /' } }],
      });

      const human = runCheckCapturing({ golden: goldenPath, dir });
      expect(human.code).toBe(2);
      expect(human.err).toMatch(/No candidate matched/);

      // --strict and --trace already have DEFINED verdicts for an unmatched
      // candidate (a regression at exit 1, and a documented unmatched report at
      // exit 0). Preempting either with exit 2 would break the same
      // regression-vs-broken-gate split this refusal exists to serve.
      expect(runCheckCapturing({ golden: goldenPath, dir, strict: true }).code).toBe(1);

      const asJson = runCheckCapturing({ golden: goldenPath, dir, json: true });
      expect(asJson.code).toBe(2);
      expect(JSON.parse(asJson.out).ok).toBe(false);

      expect(runCheckCapturing({ golden: goldenPath, dir, allowEmpty: true }).code).toBe(0);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers a store it cannot open in the requested shape, with the gate-broken code', () => {
    // This escaped to the top-level catch: a bare stderr line and exit 1, so
    // `check --json | jq -r .ok` died on a parse error, and a CI script that
    // separates regression (1) from gate-broken (2) misread an unopenable store.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-nodb-'));
    try {
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, JSON.stringify([{
        id: 'g1', agent_name: 'travel-bot', input: {}, expected_output: null,
        steps_summary: [], eval_criteria: [], metadata: { status: 'completed' },
      }]));
      const notADir = join(dir, 'a-file');
      writeFileSync(notADir, 'not a directory');

      const r = runCheckCapturing({ golden: goldenPath, dir: notADir, json: true });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.out).ok).toBe(false);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── step failure is part of the baseline ─────────────────────────────────────

describe('a step that now fails is a regression', () => {
  // The baseline could not carry step failure at all, so identical step shape
  // with every tool call now FAILING passed green — and `status` does not cover
  // it, because a hook-captured session finalizes `completed` from its Stop
  // event however many tool calls failed inside it.
  const withTool = (error?: string): IngestTraceInput => ({
    agent_name: 'errbot',
    status: 'completed',
    input: { prompt: 'go' },
    steps: [{ step_number: 1, step_type: 'tool_call', name: 'Bash', input: { command: 'ls' }, ...(error ? { error } : {}) }],
  });

  it('catches a tool call that fails where the baseline succeeded', () => {
    ingestTrace(db, withTool());
    const golden = JSON.parse(exportTraces(db, { agent_name: 'errbot' }, 'golden')) as GoldenEntry[];
    expect(golden[0].steps_summary[0].failed).toBe(false); // recorded explicitly, so absence means "predates the field"

    const report = checkGolden(golden, [candidate(withTool('permission denied'))]);
    expect(report.ok).toBe(false);
    expect(report.results[0].divergences.map((d) => d.field)).toContain('step_errors');
  });

  it('does NOT flag a step that stopped failing — a fix is not a regression', () => {
    // A symmetric comparison sounds more principled and is worse in practice: a
    // baseline captured from a run containing one flaky timeout would report
    // REGRESSED on every subsequent green run until someone re-exported it,
    // reporting a FIX as a failure — the false-positive class this format avoids.
    ingestTrace(db, withTool('permission denied'));
    const golden = JSON.parse(exportTraces(db, { agent_name: 'errbot' }, 'golden')) as GoldenEntry[];
    expect(golden[0].steps_summary[0].failed).toBe(true);

    expect(checkGolden(golden, [candidate(withTool())]).ok).toBe(true);
  });

  it('passes an identical failing step', () => {
    ingestTrace(db, withTool('permission denied'));
    const golden = JSON.parse(exportTraces(db, { agent_name: 'errbot' }, 'golden')) as GoldenEntry[];
    expect(checkGolden(golden, [candidate(withTool('permission denied'))]).ok).toBe(true);
  });

  it('does not flag a failure against a baseline exported before the field existed', () => {
    // An entry with no failure information anywhere is skipped, not guessed at —
    // otherwise every pre-existing baseline would report a false regression.
    const legacy: GoldenEntry[] = [{
      id: 'g1', agent_name: 'errbot', input: { prompt: 'go' }, expected_output: null,
      steps_summary: [{ step_number: 1, step_type: 'tool_call', name: 'Bash', input: { command: 'ls' } }],
      eval_criteria: [], metadata: {},
    }];
    expect(checkGolden(legacy, [candidate(withTool('boom'))]).ok).toBe(true);
  });
});

describe('a fork is not a candidate run and not a baseline', () => {
  it('does not let a fork turn the gate red', () => {
    // `fork` duplicates a step prefix under the same agent name and input, so a
    // fork matches its own baseline's key and then diverges on step_count and
    // status — reported REGRESSED at exit 1, the code reserved for a real
    // regression. One fork on a shared store turned a CI gate permanently red,
    // indistinguishably from a genuine failure. Every other consumer already
    // excludes forks by lineage.
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-fork-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      const traceId = ingestTrace(cdb, baseline).id;
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));

      const before = runCheckReport(goldenPath, dir);
      expect(before.ok).toBe(true);

      forkTrace(cdb, traceId, 2);

      const after = runCheckReport(goldenPath, dir);
      expect(after.ok).toBe(true); // the real run is unchanged; nothing regressed
      expect(after.failed).toBe(0);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not bake a fork into a golden baseline', () => {
    // A golden dataset is a set of known-good RUNS. A fork is a never-executed
    // copy, so baking one in gives `check` a SHORTER shape to match: a real run
    // that crashed part way then reproduces the fork and is certified green.
    const traceId = ingestTrace(db, baseline).id;
    forkTrace(db, traceId, 2);
    const entries = JSON.parse(exportTraces(db, { agent_name: 'travel-bot' }, 'golden')) as GoldenEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0].steps_summary).toHaveLength(3);
    // A json export is a backup and must still carry the fork.
    expect(JSON.parse(exportTraces(db, { agent_name: 'travel-bot' }, 'json'))).toHaveLength(2);
  });
});

/** Run `check --golden` in `dir` and return the parsed --json report. */
function runCheckReport(goldenPath: string, dir: string): { ok: boolean; failed: number } {
  const out: string[] = [];
  const prevExit = process.exitCode;
  const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    out.push(String(m));
  });
  try {
    runCheck({ golden: goldenPath, dir, json: true });
  } finally {
    spy.mockRestore();
    process.exitCode = prevExit;
  }
  return JSON.parse(out.join('\n')) as { ok: boolean; failed: number };
}


describe('a requested field the baseline cannot exercise is a broken gate, not a pass', () => {
  // Every field loop skips a step whose golden side lacks the data it reads —
  // correct per step, but when EVERY step is skipped the field compared nothing
  // and the run still reported a green pass. `--fields model` against a baseline
  // captured without per-step models is the everyday case: a CI job that added
  // the flag precisely to catch model swaps became an unconditional pass. The
  // unknown-field rejection was added against this exact false green; a VALID
  // field with no data behind it reached it by a subtler route.
  it('refuses --fields model when no baseline entry records a model', () => {
    const golden = makeGolden();
    expect(golden[0].steps_summary.every((s) => s.model == null)).toBe(true);

    const c = candidate(baseline);
    const report = checkGolden(golden, [c], { fields: ['model'] });

    expect(report.uncompared).toEqual(['model']);
    expect(report.ok).toBe(false);
    // The candidate itself is not a regression — nothing was compared at all.
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(1);
  });

  it('exits 2 (gate broken), not 1 (regression), and says so in both output modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-nofield-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, baseline);
      const goldenPath = join(dir, 'golden.json');
      writeFileSync(goldenPath, exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden'));

      const human = runCheckCapturing({ golden: goldenPath, dir, fields: 'model' });
      expect(human.code).toBe(2);
      expect(human.err).toMatch(/Nothing to compare for --fields model/);

      const asJson = runCheckCapturing({ golden: goldenPath, dir, fields: 'model', json: true });
      expect(asJson.code).toBe(2);
      expect(JSON.parse(asJson.out).ok).toBe(false);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The refusal must never preempt a REAL regression. `uncompared` was derived
  // from comparisons actually performed, and the comparison loops run over
  // min(golden steps, candidate steps) — so a candidate that CRASHED to zero
  // steps marked every per-step field "uncompared", and the gate answered
  // "nothing to compare" (exit 2, gate broken) for the most severe regression it
  // could possibly see. The worse the regression, the more reliably it was
  // swallowed. Exercisability is a property of the BASELINE alone.
  // Exercisability must be read from the baselines actually COMPARED, not from
  // every entry in the file: an unrelated baseline that no candidate matched
  // otherwise makes a field look exercisable and restores the false green.
  it('ignores a baseline no candidate matched when deciding what was exercisable', () => {
    // The baseline the candidate WILL match carries no tool call...
    const noToolsRun: IngestTraceInput = {
      agent_name: 'quiet-bot',
      status: 'completed',
      input: { task: 'just think' },
      steps: [{ step_number: 1, step_type: 'thought', name: 'plan' }],
    };
    ingestTrace(db, noToolsRun);
    // ...while an unrelated agent's baseline, which nothing will match, does.
    ingestTrace(db, {
      agent_name: 'other-bot',
      status: 'completed',
      input: { task: 'something else' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'grep', input: { q: 'x' } }],
    });
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];
    expect(golden.length).toBe(2);

    // `tool_inputs` compares nothing against the matched baseline, so the run
    // must refuse — the other agent's entry is irrelevant to this comparison.
    const report = checkGolden(golden, [candidate(noToolsRun)], { fields: ['tool_inputs'] });
    expect(report.uncompared).toEqual(['tool_inputs']);
    expect(report.ok).toBe(false);
  });

  // One agent that HAS tool calls must not re-arm the vacuous pass for an agent
  // that does not. Exercisability belongs to each candidate's own baselines, not
  // to the run as a whole.
  it('refuses when any matched candidate cannot exercise the field', () => {
    const quiet: IngestTraceInput = {
      agent_name: 'quiet-bot',
      status: 'completed',
      input: { task: 'just think' },
      steps: [{ step_number: 1, step_type: 'thought', name: 'plan' }],
    };
    const busy: IngestTraceInput = {
      agent_name: 'busy-bot',
      status: 'completed',
      input: { task: 'do work' },
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'grep', input: { q: 'x' } }],
    };
    ingestTrace(db, quiet);
    ingestTrace(db, busy);
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];

    // Both candidates in one run: busy-bot exercises tool_inputs, quiet-bot
    // cannot — so the run must still refuse rather than pass on busy-bot's
    // behalf.
    const report = checkGolden(golden, [candidate(quiet), candidate(busy)], { fields: ['tool_inputs'] });
    expect(report.uncompared).toEqual(['tool_inputs']);
    expect(report.ok).toBe(false);

    // busy-bot alone is a genuine comparison and passes.
    const busyOnly = checkGolden(golden, [candidate(busy)], { fields: ['tool_inputs'] });
    expect(busyOnly.uncompared).toEqual([]);
    expect(busyOnly.ok).toBe(true);
  });

  it('reports the regression when the candidate produced no steps at all', () => {
    const golden = makeGolden();
    const crashed = candidate({ ...baseline, steps: [] });
    const report = checkGolden(golden, [crashed], { fields: ['step_count', 'tool_inputs'] });

    // `uncompared` is empty because a failure always wins — asserted alongside
    // the failure itself so this cannot pass merely by short-circuiting.
    expect(report.uncompared).toEqual([]);
    expect(report.failed).toBe(1);
    expect(report.results[0].divergences.map((d) => d.field)).toContain('step_count');
    expect(report.ok).toBe(false);
  });

  it('still compares a field the baseline DOES carry', () => {
    const golden = makeGolden();
    golden[0].steps_summary[1].model = 'claude-sonnet-4';
    const report = checkGolden(golden, [candidate(baseline)], { fields: ['model'] });
    expect(report.uncompared).toEqual([]);
    // The candidate records no model, so the recorded one is a real divergence.
    expect(report.failed).toBe(1);
  });

  // The DEFAULT set deliberately spans fields that not every trace shape has —
  // a trace with no tool calls has nothing for `tool_inputs`, and an old
  // baseline has no recorded step outcomes. Refusing there would break every
  // ordinary check, so the rule applies only to fields the caller NAMED.
  it('does not refuse for the default field set', () => {
    const golden = makeGolden();
    const noTools: IngestTraceInput = {
      ...baseline,
      steps: [{ step_number: 1, step_type: 'thought', name: 'plan' }],
    };
    const g2 = JSON.parse(
      (() => { ingestTrace(db, noTools); return exportTraces(db, { agent_name: 'travel-bot' }, 'golden'); })(),
    ) as GoldenEntry[];
    expect(checkGolden(golden, [candidate(baseline)], {}).uncompared).toEqual([]);
    expect(checkGolden(g2, [], {}).uncompared).toEqual([]);
  });
});

describe('a golden entry with no metadata.status is a damaged baseline', () => {
  // `status` is the field that catches "this run now fails", and the comparison
  // reads it from metadata.status — skipping silently when absent. So a
  // baseline whose metadata block was pruned (the block a human trims first
  // when hand-editing one for review) turned that comparison OFF and reported a
  // green pass over a run that had started failing.
  it('refuses the file instead of silently disabling the status comparison', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-nometa-'));
    try {
      const cdb = ensureDatabase(resolve(dir, 'traces.db'));
      ingestTrace(cdb, { ...baseline, status: 'failed', error: 'boom' });
      const entries = JSON.parse(exportTraces(cdb, { agent_name: 'travel-bot' }, 'golden')) as GoldenEntry[];

      // Intact baseline: the candidate's status regression is caught.
      const intact = join(dir, 'intact.json');
      const good = structuredClone(entries);
      good[0].metadata = { ...good[0].metadata, status: 'completed' };
      writeFileSync(intact, JSON.stringify(good));
      expect(runCheckCapturing({ golden: intact, dir }).code).toBe(1);

      // Same baseline with metadata pruned: used to pass green at exit 0.
      const pruned = join(dir, 'pruned.json');
      const bad = structuredClone(entries) as unknown as Array<Record<string, unknown>>;
      delete bad[0].metadata;
      writeFileSync(pruned, JSON.stringify(bad));
      const r = runCheckCapturing({ golden: pruned, dir });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/no metadata\.status/);
    } finally {
      resetConnection();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an empty input is not an identity', () => {
  // Every capture with no recorded input hashed to the SAME golden key, so
  // unrelated runs matched each other. Two `record --format codex-exec`
  // captures of completely different sessions (that translator records no
  // input) compared as the same scenario — producing a fabricated tool_inputs
  // regression between them — and a `--strict` run reported `uncovered: 0` at
  // exit 0 while a baseline it never exercised sat unused, which is the exact
  // hole `uncovered` exists to report.
  it('does not match two different runs that both lack an input', () => {
    const a: IngestTraceInput = {
      agent_name: 'codex', status: 'completed', input: {},
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'search', input: { q: 'tokyo' } }],
    };
    const b: IngestTraceInput = {
      agent_name: 'codex', status: 'completed', input: {},
      steps: [{ step_number: 1, step_type: 'tool_call', name: 'deploy', input: { cmd: 'rm -rf /tmp/x' } }],
    };
    ingestTrace(db, a);
    ingestTrace(db, b);
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(2);

    // Re-running only scenario A must NOT report a clean, fully-covered gate.
    const report = checkGolden(golden, [candidate(a)], { strict: true });
    expect(report.passed).toBe(0);
    expect(report.unmatched).toBe(1);
    // Neither baseline was exercised — both are reported, not quietly excluded.
    expect(report.uncovered).toBe(2);
    expect(report.ok).toBe(false);
  });

  it('still matches normally when the input is present', () => {
    const withInput: IngestTraceInput = {
      agent_name: 'codex', status: 'completed', input: { prompt: 'book a flight' },
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    };
    ingestTrace(db, withInput);
    const golden = JSON.parse(exportTraces(db, { agent_name: 'codex' }, 'golden')) as GoldenEntry[];
    const report = checkGolden(golden, [candidate(withInput)], { strict: true });
    expect(report.passed).toBe(1);
    expect(report.ok).toBe(true);
  });
});

describe('naming exactly one agent for a gate', () => {
  // `--agent` is a SUBSTRING match, which is right for browsing and wrong for a
  // gate: `--agent assistant` also selects `travel-assistant` and
  // `research-assistant`, and under --strict those unrelated candidates decide
  // the verdict. A gate needs to name one agent.
  const mk = (name: string, task: string): IngestTraceInput => ({
    agent_name: name,
    status: 'completed',
    input: { task },
    steps: [{ step_number: 1, step_type: 'tool_call', name: 'go', input: { q: task } }],
  });

  it('selects only the named agent, where the substring form selects three', () => {
    const runs = [mk('travel-assistant', 'trip'), mk('research-assistant', 'paper'), mk('assistant', 'plain')];
    for (const r of runs) ingestTrace(db, r);
    const golden = JSON.parse(exportTraces(db, {}, 'golden')) as GoldenEntry[];
    expect(golden).toHaveLength(3);

    const candidates = runs.map((r) => candidate(r));
    // Substring: every agent whose name contains "assistant" is compared.
    expect(checkGolden(golden, candidates, {}).passed).toBe(3);

    // Exact: only the one named. The other two baselines are then unexercised,
    // which --strict correctly reports — a gate naming one agent wants a
    // baseline for that agent.
    const exact = candidates.filter((c) => c.agent_name === 'assistant');
    const report = checkGolden(golden, exact, { strict: true });
    expect(report.passed).toBe(1);
    expect(report.uncovered).toBe(2);
    expect(report.ok).toBe(false);

    // With a matching single-agent baseline, the exact gate is green.
    const oneGolden = golden.filter((g) => g.agent_name === 'assistant');
    const scoped = checkGolden(oneGolden, exact, { strict: true });
    expect(scoped.passed).toBe(1);
    expect(scoped.uncovered).toBe(0);
    expect(scoped.ok).toBe(true);
  });
});


describe('check refuses and reports in the documented shapes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-check-shapes-'));
    const cdb = ensureDatabase(resolve(dir, 'traces.db'));
    ingestTrace(cdb, baseline);
  });
  afterEach(() => {
    resetConnection();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run `check` quietly, returning what it wrote to stdout and its exit code. */
  function check(opts: Record<string, unknown>): { out: string; code: number } {
    const outs: string[] = [];
    const prev = process.exitCode;
    process.exitCode = 0;
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void outs.push(String(m)));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      runCheck({ dir, json: true, ...opts } as never);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    const code = (process.exitCode as number) ?? 0;
    process.exitCode = prev;
    return { out: outs.join('\n'), code };
  }

  it('names an unusable steps_summary ENTRY, not just a missing array', () => {
    // The shape guard checked one level down, so a hand-edited or merged
    // baseline holding a null in `steps_summary` reached the comparison and
    // died there on `.step_type` — "Cannot read properties of null", naming
    // neither the file nor the entry. That is the diagnostic failure the guard
    // exists to prevent, one level deeper.
    const golden = join(dir, 'nullstep.json');
    writeFileSync(golden, JSON.stringify([{
      id: 'g1', agent_name: 'a', input: {}, expected_output: null,
      steps_summary: [null], eval_criteria: [], metadata: { status: 'completed' },
    }]));

    const { out, code } = check({ golden });
    expect(code).toBe(2);
    const parsed = JSON.parse(out) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not a golden dataset/i);
    expect(parsed.error).not.toMatch(/Cannot read properties/);
  });

  it('answers a missing trace with exit 1, as the documented table says', () => {
    // `diff` already answers 1 for the same condition. A CI script that splits
    // 1 (a regression) from 2 (the gate itself is broken) read a typo'd
    // --trace id as a broken gate.
    const golden = join(dir, 'g.json');
    writeFileSync(golden, JSON.stringify([{
      id: 'g1', agent_name: 'a', input: {}, expected_output: null,
      steps_summary: [], eval_criteria: [], metadata: { status: 'completed' },
    }]));
    const { code } = check({ golden, trace: 'trc_nope' });
    expect(code).toBe(1);
  });
});
