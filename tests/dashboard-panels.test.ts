import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrations.js';
import { ingestTrace, createEval } from '../src/services/trace-service.js';
import { renderStatusBars, renderScoreSparkline } from '../src/ui/dashboard-panels.js';
import { DashboardView } from '../src/ui/dashboard-view.js';

describe('renderStatusBars', () => {
  it('scales bars to the largest count and labels each row', () => {
    const out = renderStatusBars({ titles: ['completed', 'failed'], data: [10, 5] }, 40);
    const [first, second] = out.split('\n');
    expect(first).toContain('completed');
    expect(first).toContain('10');
    expect(second).toContain('failed');
    // The smaller count gets a visibly shorter bar.
    const bars = (s: string) => (s.match(/█/g) ?? []).length;
    expect(bars(first)).toBeGreaterThan(bars(second));
  });

  it('always draws at least one cell for a non-zero count', () => {
    // A status that is PRESENT must not render as an empty row, which would be
    // indistinguishable from absent.
    const out = renderStatusBars({ titles: ['completed', 'failed'], data: [1000, 1] }, 40);
    expect((out.split('\n')[1].match(/█/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('draws nothing for a zero count, and says so when there is no data', () => {
    const out = renderStatusBars({ titles: ['failed'], data: [0] }, 40);
    expect(out).not.toContain('█');
    expect(renderStatusBars({ titles: [], data: [] }, 40)).toContain('no traces');
  });
});

describe('renderStatusBars edge inputs', () => {
  it('bounds a status name longer than the panel', () => {
    // An unbounded label pushed the row past the box edge, where blessed wraps
    // it and the bars stop lining up.
    const out = renderStatusBars({ titles: ['x'.repeat(60)], data: [5] }, 40);
    for (const line of out.replace(/\{[^}]*\}/g, '').split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('renderScoreSparkline', () => {
  const pts = (values: number[]) => values.map((value, i) => ({ label: `1${i}:00`, value }));
  /** Blessed markup tags are layout, not content — compare the text under them. */
  const plain = (s: string) => s.replace(/\{[^}]*\}/g, '');

  it('reports the range and the latest value', () => {
    const out = renderScoreSparkline(pts([10, 90, 50]), 40);
    expect(plain(out)).toContain('min 10%');
    expect(plain(out)).toContain('max 90%');
    expect(plain(out)).toContain('last 50%');
    expect(plain(out)).toContain('10:00 → 12:00'); // oldest → newest, left to right
  });

  it('does not draw a flat series at the floor', () => {
    // Every point is both the min and the max, so a naive scale puts them all at
    // the lowest glyph — which reads as a collapse to zero.
    const out = renderScoreSparkline(pts([80, 80, 80]), 40).split('\n')[0];
    expect(out).not.toContain('▁');
  });

  it('keeps the most recent points when the series is wider than the panel', () => {
    const out = renderScoreSparkline(pts(Array.from({ length: 100 }, (_, i) => i)), 10);
    expect(plain(out)).toContain('last 99%');
  });

  it('ignores a non-finite score instead of reporting min NaN%', () => {
    const out = renderScoreSparkline(
      [{ label: '1:00', value: Number.NaN }, { label: '2:00', value: 40 }],
      40,
    );
    expect(plain(out)).not.toContain('NaN');
    expect(plain(out)).toContain('last 40%');
  });

  it('says there is no data rather than drawing a zero line', () => {
    expect(renderScoreSparkline([], 40)).toContain('no evaluations');
  });
});

describe('DashboardView', () => {
  it('builds and refreshes every panel against a real store', () => {
    // A smoke test for the widget wiring, which nothing covered while the view
    // was built on blessed-contrib. It catches a mistyped widget option or a
    // changed setData shape — the failure modes of moving off that package.
    const db = new Database(':memory:');
    runMigrations(db);
    const t = ingestTrace(db, {
      agent_name: 'dash', status: 'completed', input: { q: 'x' },
      steps: [{ step_number: 1, step_type: 'output', name: 'answer' }],
    });
    createEval(db, t.id, {
      evaluator_type: 'rubric', evaluator_name: 'r', score: 0.8, passed: true, details: {},
    });

    const view = new DashboardView(db, { refreshIntervalMs: 60_000 });
    expect(() => {
      view.start();
      view.stop();
    }).not.toThrow();
    db.close();
  });
});

describe('the dashboard shows what is stored', () => {
  // Its widgets run with blessed markup enabled, so blessed CONSUMES `{...}` in
  // cell text: an agent name containing `{red-fg}` displayed as something other
  // than what is stored — wrong output, and a producer setting colours in the
  // TUI. `safeText` handles control characters; only blessed knows its own
  // markup, so both are needed. The fix shipped without a test; this is it.
  it('renders a name containing blessed markup literally', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    ingestTrace(db, {
      agent_name: '{red-fg}pwn{/red-fg}',
      status: 'completed',
      input: {},
      steps: [{ step_number: 1, step_type: 'output', name: 'a' }],
    });

    const view = new DashboardView(db, { refreshIntervalMs: 60_000 });
    view.start();
    try {
      // Capture what the widget is actually handed, rather than guessing at an
      // internal: blessed interprets the cell text, so the escaping has to be
      // present at THIS boundary to matter.
      const table = (view as unknown as { traceTable: { setData: (rows: string[][]) => void } }).traceTable;
      let handed: string[][] = [];
      const original = table.setData.bind(table);
      table.setData = (rows: string[][]): void => { handed = rows; original(rows); };
      (view as unknown as { refresh: () => void }).refresh();

      const flat = handed.flat().join(' ');
      expect(flat).not.toContain('{red-fg}');
      // The text itself survives — this escapes markup, it does not drop content.
      expect(flat).toContain('pwn');
    } finally {
      view.stop();
      db.close();
    }
  });
});

describe('the stats panel never presents a partial sum as a total', () => {
  // `Avg duration` already said "(over N of M)"; `Total tokens` and `Total
  // cost` sat directly beneath it saying nothing, though both are sums over
  // whatever subset records the value.
  let dir: string;
  let out: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let prevExit: typeof process.exitCode;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-statspanel-'));
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

  it('names the scope of the token and cost totals when they cover only some traces', async () => {
    const db = ensureDatabase(join(dir, 'traces.db'));
    ingestTrace(db, {
      agent_name: 'priced', status: 'completed', input: {},
      total_tokens: 100, total_cost_usd: 0.5,
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    } as Parameters<typeof ingestTrace>[1]);
    ingestTrace(db, {
      agent_name: 'unpriced', status: 'completed', input: {},
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    } as Parameters<typeof ingestTrace>[1]);

    const { runStats } = await import('../src/commands/stats.js');
    runStats({ dir });
    const text = noAnsi(out.join('\n'));
    expect(text).toMatch(/Total tokens:\s+100 \(over 1 of 2\)/);
    expect(text).toMatch(/Total cost:.*\(over 1 of 2\)/);
  });

  it('says nothing extra when the totals cover every trace', async () => {
    const db = ensureDatabase(join(dir, 'traces.db'));
    for (const n of ['a', 'b']) {
      ingestTrace(db, {
        agent_name: n, status: 'completed', input: {},
        total_tokens: 10, total_cost_usd: 0.1,
        steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
      } as Parameters<typeof ingestTrace>[1]);
    }
    const { runStats } = await import('../src/commands/stats.js');
    runStats({ dir });
    const text = noAnsi(out.join('\n'));
    expect(text).toMatch(/Total tokens:\s+20/);
    expect(text).not.toMatch(/over \d+ of \d+/);
  });

  it('exposes both denominators in --json, so a script can check the scope too', async () => {
    const db = ensureDatabase(join(dir, 'traces.db'));
    ingestTrace(db, {
      agent_name: 'priced', status: 'completed', input: {},
      total_tokens: 7, total_cost_usd: 0.25,
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    } as Parameters<typeof ingestTrace>[1]);
    ingestTrace(db, {
      agent_name: 'unpriced', status: 'completed', input: {},
      steps: [{ step_number: 1, step_type: 'output', name: 'done' }],
    } as Parameters<typeof ingestTrace>[1]);

    const { runStats } = await import('../src/commands/stats.js');
    runStats({ dir, json: true });
    const d = JSON.parse(noAnsi(out.join('\n')));
    expect(d.overall).toMatchObject({
      traces: 2, totalTokens: 7, totalTokensSample: 1, totalCostSample: 1,
    });
  });
});
