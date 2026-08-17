import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
