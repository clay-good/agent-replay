import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Smoke test for the built LIBRARY entry point (`dist/index.js`) — the artifact
 * npm actually ships and SDK users `import` per the README. The rest of the suite
 * imports from `src/`, and the CLI tests spawn `dist/cli.js`, so nothing else
 * exercises the bundled library export or the package `exports` map. A broken
 * build, a dropped re-export, or a bad `exports` field would ship a broken
 * published API with every src-level test still green; this catches that.
 *
 * Depends on the build having run (like the CLI integration tests). `npm run
 * verify` builds before testing; a bare `npm test` against a stale tree is
 * reported with a clear message rather than a cryptic import failure.
 */

const DIST = new URL('../dist/index.js', import.meta.url);

beforeAll(() => {
  if (!existsSync(fileURLToPath(DIST)))
    throw new Error(`built library not found at ${fileURLToPath(DIST)}; run "npm run build" first`);
});

describe('published library entry (dist/index.js)', () => {
  it('exposes the documented public API surface', async () => {
    const api = await import(DIST.href);
    // The names the README's Programmatic API section and SDK docs promise.
    for (const name of [
      'TraceRecorder',
      'runMigrations',
      'SCHEMA_VERSION',
      'getSchemaVersion',
      'ensureDatabase',
      'DatabaseConnection',
    ]) {
      expect(api[name], `missing export: ${name}`).toBeDefined();
    }
  });

  it('runs the README TraceRecorder example against a fresh schema', async () => {
    const { TraceRecorder, runMigrations } = await import(DIST.href);
    const db = new Database(':memory:');
    runMigrations(db);

    const rec = new TraceRecorder(db);
    rec.startTrace({ agent_name: 'smoke-bot', session_id: 's1', input: { task: 't' } });
    rec.startStep({ step_number: 1, step_type: 'tool_call', name: 'search' });
    rec.endStep(1, { output: { hits: 3 }, tokens_used: 120 });
    rec.endTrace({ status: 'completed', output: 'done', total_tokens: 120 });

    const trace = db.prepare('SELECT agent_name, status, total_tokens FROM agent_traces').get() as {
      agent_name: string;
      status: string;
      total_tokens: number;
    };
    const steps = db.prepare('SELECT COUNT(*) c FROM agent_trace_steps').get() as { c: number };
    db.close();

    expect(trace.agent_name).toBe('smoke-bot');
    expect(trace.status).toBe('completed');
    expect(trace.total_tokens).toBe(120);
    expect(steps.c).toBe(1);
  });
});
