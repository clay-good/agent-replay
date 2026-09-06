import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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

/**
 * Every path package.json advertises as a runtime entry point, loaded the way
 * the field that names it means it to be loaded.
 *
 * This file's own docstring claimed to cover "the package `exports` map", and
 * it did not: it imported `dist/index.js` by relative URL, which is true of the
 * file whatever package.json says about it. The gap shipped a real break —
 * `main` and the `require` condition both pointed at a `dist/index.cjs` that
 * threw on load (esbuild's CJS interop dereferences an ESM-only dependency's
 * namespace as if it were the default export), and nothing in the suite ever
 * loaded that file. `import` was fine, so every test stayed green.
 */
describe('package entry points', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    main?: string;
    module?: string;
    exports?: Record<string, Record<string, string>>;
  };
  const root = new URL('../', import.meta.url);
  // `types` is a compile-time target, not a module to load; everything else in
  // these fields is something a consumer's runtime will resolve.
  const advertised: { field: string; target: string }[] = [];
  if (pkg.main) advertised.push({ field: 'main', target: pkg.main });
  if (pkg.module) advertised.push({ field: 'module', target: pkg.module });
  for (const [key, value] of Object.entries(pkg.exports?.['.'] ?? {})) {
    if (key !== 'types') advertised.push({ field: `exports["."].${key}`, target: value });
  }

  it('advertises at least the library entry', () => {
    expect(advertised.length).toBeGreaterThan(0);
  });

  it.each(advertised)('$field ($target) exists', ({ target }) => {
    expect(existsSync(fileURLToPath(new URL(target, root)))).toBe(true);
  });

  it.each(advertised)('$field ($target) loads and exposes the API', async ({ target }) => {
    const api = (await import(new URL(target, root).href)) as Record<string, unknown>;
    expect(api.TraceRecorder).toBeDefined();
  });

  it.each(advertised)('$field ($target) is requirable, or fails the standard way', ({ target }) => {
    // A CommonJS consumer resolves `main` and the `require` condition with
    // `require()`. This package is ESM, so on Node >= 20.19/22.12 that succeeds
    // through require(ESM) and on an older Node it throws ERR_REQUIRE_ESM — a
    // documented, comprehensible failure a caller can act on. What it must
    // never do is what the shipped CJS bundle did: load far enough to throw a
    // TypeError out of a dependency's innards.
    const require_ = createRequire(new URL('../package.json', import.meta.url));
    try {
      const api = require_(fileURLToPath(new URL(target, root))) as Record<string, unknown>;
      expect(api.TraceRecorder).toBeDefined();
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code, `unexpected failure loading ${target}: ${(err as Error).message}`)
        .toBe('ERR_REQUIRE_ESM');
    }
  });
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
