import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { runEvalCommand } from '../src/commands/eval.js';
import type { IngestTraceInput } from '../src/models/types.js';

const failedTrace: IngestTraceInput = {
  agent_name: 'budget-bot',
  status: 'failed',
  input: { task: 'do the thing' },
  error: 'it broke',
  steps: [{ step_number: 1, step_type: 'tool_call', name: 'run', error: 'boom' }],
};

/** An LLM response whose *reported* usage is far larger than the pre-run estimate. */
function expensiveResponse(): Response {
  return {
    status: 200,
    json: async () => ({
      content: [{ text: JSON.stringify({ root_cause: 'x', failing_step: 1, confidence: 0.9, severity: 'high' }) }],
      usage: { input_tokens: 5_000_000, output_tokens: 5_000_000 },
    }),
  } as unknown as Response;
}

describe('eval --ai --max-cost', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetConnection();
  });

  it('exits non-zero when the budget stops the run with evaluators unrun', async () => {
    // Regression: the mid-run budget `break` left the remaining presets out of
    // `results`, and the pass/fail gate can only reason about evaluators that
    // ran — so a run that stopped early printed "Budget limit reached" and
    // exited 0. CI read a gate that never finished as green. The pre-run
    // estimate check already exits 1 for exactly this reason.
    const dir = mkdtempSync(join(tmpdir(), 'ar-eval-budget-'));
    const prevExit = process.exitCode;
    try {
      const db = ensureDatabase(resolve(dir, 'traces.db'));
      const trace = ingestTrace(db, failedTrace);

      vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(expensiveResponse()));

      process.exitCode = 0;
      const errs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // Large enough that the pre-run estimate passes, small enough that the
        // first call's actual reported cost blows through it.
        await runEvalCommand(trace.id, { ai: true, maxCost: '1', dir });
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }

      expect(errs.join('\n')).toMatch(/Budget limit reached/);
      expect(errs.join('\n')).toMatch(/unrun/);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the budget gate fails closed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetConnection();
  });

  /** Run the command quietly and return its exit code. */
  async function evalQuietly(traceId: string, opts: Parameters<typeof runEvalCommand>[1]): Promise<number> {
    const prev = process.exitCode;
    process.exitCode = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runEvalCommand(traceId, opts);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
    const code = Number(process.exitCode ?? 0);
    process.exitCode = prev;
    return code;
  }

  // The guard in isolation: force a non-finite estimate directly, so this fails
  // if the `Number.isFinite` check is removed even when the config sanitizer is
  // intact. (Written after review pointed out that the config-path test below
  // passes with EITHER fix in place, so neither was pinned on its own.)
  it('refuses a non-finite estimate even when the config is clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-eval-nan2-'));
    try {
      const db = ensureDatabase(resolve(dir, 'traces.db'));
      const trace = ingestTrace(db, failedTrace);
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
      const fetchSpy = vi.fn().mockResolvedValue(expensiveResponse());
      vi.stubGlobal('fetch', fetchSpy);

      const evalService = await import('../src/services/eval-service.js');
      const spy = vi
        .spyOn(evalService, 'estimateAiEvalCost')
        .mockReturnValue({ total_estimated_usd: NaN } as ReturnType<typeof evalService.estimateAiEvalCost>);
      try {
        const code = await evalQuietly(trace.id, { ai: true, maxCost: '5', dir });
        expect(code).toBe(2);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A cost that cannot be computed used to sail straight past the cap, because
  // `NaN > maxCost` is false — so `--max-cost 0`, the strictest possible
  // budget, ran the whole evaluation and billed for it. A config file holding a
  // non-numeric `ai.max_tokens` was enough to produce that NaN.
  it('refuses when the estimate is not a finite number', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-eval-nan-'));
    try {
      const db = ensureDatabase(resolve(dir, 'traces.db'));
      const trace = ingestTrace(db, failedTrace);
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
      const fetchSpy = vi.fn().mockResolvedValue(expensiveResponse());
      vi.stubGlobal('fetch', fetchSpy);

      // A config whose max_tokens is unusable. The loader drops it, so the
      // estimate stays finite and the cap holds — this asserts the whole path,
      // not just the guard in isolation.
      writeFileSync(
        resolve(dir, 'config.json'),
        JSON.stringify({ version: '0.1.0', database: 'x', created_at: 'now', ai: { provider: 'anthropic', max_tokens: 'abc' } }),
      );

      const code = await evalQuietly(trace.id, { ai: true, maxCost: '0', dir });
      // Refused, and — the point — no paid call was made.
      expect(code).not.toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The guard sat inside the `--ai` branch, so a CI job whose --max-cost is a
  // typo'd or empty shell variable passed silently until the first run that
  // happened to enable AI — the run where the cap was already load-bearing.
  it('rejects a malformed --max-cost even on a deterministic run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-eval-badcost-'));
    try {
      const db = ensureDatabase(resolve(dir, 'traces.db'));
      const trace = ingestTrace(db, failedTrace);
      expect(await evalQuietly(trace.id, { all: true, maxCost: 'garbage', dir })).toBe(2);
      expect(await evalQuietly(trace.id, { all: true, maxCost: '-1', dir })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
