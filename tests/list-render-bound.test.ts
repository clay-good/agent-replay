import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { ingestTrace } from '../src/services/trace-service.js';
import { runList } from '../src/commands/list.js';
import type { IngestTraceInput } from '../src/models/types.js';

/**
 * `list` draws a bounded number of rows.
 *
 * The query is flat — `--json --limit 10000` returns in about 0.13s — but
 * cli-table3's rendering is quadratic in row count (measured on a bare table
 * with no options and no styling: 1,000 rows 123ms, 8,000 rows 3.9s), so
 * `list --limit 10000` spent roughly 7 seconds building an 11 MB string for a
 * table nobody reads. The cap is on what is DRAWN; `--json` returns every row.
 */
const RENDER_MAX = 1000;

let dir: string;
let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let prevExit: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ar-listbound-'));
  const db = ensureDatabase(resolve(dir, 'traces.db'));
  // One more than the cap, so the boundary itself is exercised.
  for (let i = 0; i < RENDER_MAX + 5; i++) {
    ingestTrace(db, {
      agent_name: `bot_${i % 3}`, status: 'completed', input: { i },
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    } as IngestTraceInput);
  }
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
});

const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
const stdout = () => noAnsi(out.join('\n'));

describe('list bounds what it draws, and says so', () => {
  it('draws at most the cap and names the path with no cap', async () => {
    await runList({ dir, limit: String(RENDER_MAX + 5) });
    expect(process.exitCode).toBe(0);

    // The header still reports everything that MATCHED — the cap is on drawing,
    // not on the answer.
    expect(stdout()).toMatch(new RegExp(`${RENDER_MAX + 5} trace\\(s\\) found`));
    expect(stdout()).toMatch(new RegExp(`Drawing the first ${RENDER_MAX} of ${RENDER_MAX + 5} matching traces`));
    expect(stdout()).toMatch(/--json/);

    // Count the drawn rows: each trace id appears in its own row.
    const drawn = stdout().split('\n').filter((l) => /\btrc_/.test(l)).length;
    expect(drawn).toBe(RENDER_MAX);
  }, 60_000);

  it('says nothing extra when everything fits', async () => {
    await runList({ dir, limit: '10' });
    expect(stdout()).not.toMatch(/Drawing the first/);
    expect(stdout().split('\n').filter((l) => /\btrc_/.test(l)).length).toBe(10);
  });

  it('--json is not capped — it returns every row the query matched', async () => {
    await runList({ dir, json: true, limit: String(RENDER_MAX + 5) });
    const doc = JSON.parse(stdout()) as { items: unknown[]; total: number };
    expect(doc.items).toHaveLength(RENDER_MAX + 5);
    expect(doc.total).toBe(RENDER_MAX + 5);
  }, 60_000);
});
