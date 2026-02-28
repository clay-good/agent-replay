import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type Database from 'better-sqlite3';
import type { Trace, EvalResult } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { TRACE_STATUSES } from '../models/enums.js';

/**
 * Full-screen blessed TUI dashboard.
 *
 * Layout (grid 12x12):
 *   ┌──────────────────┬──────────────────┐
 *   │  Status Bar Chart │  Aggregate Stats │
 *   ├──────────────────┼──────────────────┤
 *   │  Trace List       │  Eval Scores     │
 *   ├──────────────────┴──────────────────┤
 *   │  Guardrail / Activity Log           │
 *   └─────────────────────────────────────┘
 *
 * Keys: q = quit, r = refresh, ↑↓ = navigate trace list
 */

export interface DashboardOptions {
  refreshIntervalMs?: number;
}

export class DashboardView {
  private screen!: blessed.Widgets.Screen;
  private grid!: InstanceType<typeof contrib.grid>;
  private barChart!: ReturnType<typeof contrib.bar>;
  private traceTable!: ReturnType<typeof contrib.table>;
  private lineChart!: ReturnType<typeof contrib.line>;
  private activityLog!: ReturnType<typeof contrib.log>;
  private statsBox!: blessed.Widgets.BoxElement;
  private db: Database.Database;
  private refreshInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database.Database, options: DashboardOptions = {}) {
    this.db = db;
    this.refreshInterval = options.refreshIntervalMs ?? 5000;
  }

  /**
   * Launch the full-screen dashboard. Blocks until user presses 'q'.
   */
  start(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'agent-replay dashboard',
    });

    // 12x12 grid layout
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // ── Top-left: Trace Status Bar Chart (rows 0-5, cols 0-6) ────────
    this.barChart = this.grid.set(0, 0, 5, 6, contrib.bar, {
      label: ' Trace Statuses ',
      barWidth: 10,
      barSpacing: 4,
      maxHeight: 50,
      style: { fg: 'cyan' },
      border: { type: 'line', fg: 'cyan' },
    });

    // ── Top-right: Aggregate Stats (rows 0-5, cols 6-12) ─────────────
    this.statsBox = this.grid.set(0, 6, 5, 6, blessed.box, {
      label: ' Stats ',
      tags: true,
      padding: { left: 2, top: 1, right: 2, bottom: 1 },
      border: { type: 'line', fg: 'cyan' },
      style: { fg: 'white', border: { fg: 'cyan' } },
    });

    // ── Middle-left: Trace List (rows 5-9, cols 0-6) ─────────────────
    this.traceTable = this.grid.set(5, 0, 4, 6, contrib.table, {
      label: ' Recent Traces ',
      keys: true,
      interactive: true,
      columnSpacing: 2,
      columnWidth: [14, 20, 12, 10],
      style: {
        fg: 'white',
        header: { fg: 'cyan', bold: true },
        cell: { selected: { fg: 'black', bg: 'cyan' } },
        border: { fg: 'cyan' },
      },
      border: { type: 'line', fg: 'cyan' },
    });

    // ── Middle-right: Eval Score Line Chart (rows 5-9, cols 6-12) ────
    this.lineChart = this.grid.set(5, 6, 4, 6, contrib.line, {
      label: ' Eval Scores (recent) ',
      showLegend: true,
      style: { line: 'cyan', text: 'white', baseline: 'dim' },
      border: { type: 'line', fg: 'cyan' },
    });

    // ── Bottom: Activity / Guardrail Log (rows 9-12, cols 0-12) ──────
    this.activityLog = this.grid.set(9, 0, 3, 12, contrib.log, {
      label: ' Activity Log ',
      tags: true,
      style: { fg: 'white', border: { fg: 'cyan' } },
      border: { type: 'line', fg: 'cyan' },
      bufferLength: 50,
    });

    // ── Key bindings ─────────────────────────────────────────────────
    this.screen.key(['q', 'C-c', 'escape'], () => {
      this.stop();
    });

    this.screen.key(['r'], () => {
      this.refresh();
    });

    // Focus on trace table for arrow-key navigation
    this.traceTable.focus();

    // Initial data load + render
    this.refresh();
    this.activityLog.log('{cyan-fg}Dashboard started.{/cyan-fg} Press {bold}q{/bold} to quit, {bold}r{/bold} to refresh.');

    // Auto-refresh timer
    this.timer = setInterval(() => this.refresh(), this.refreshInterval);

    this.screen.render();
  }

  /**
   * Stop the dashboard and return to normal terminal.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.screen) {
      this.screen.destroy();
    }
  }

  /**
   * Refresh all dashboard panels with current data.
   */
  private refresh(): void {
    try {
      this.updateStatusBar();
      this.updateStats();
      this.updateTraceList();
      this.updateEvalChart();
      this.screen.render();
    } catch (err) {
      // Log to activity log instead of crashing
      try {
        const msg = err instanceof Error ? err.message : String(err);
        this.activityLog?.log(`Refresh error: ${msg}`);
        this.screen.render();
      } catch {
        // Last resort: ignore if even logging fails
      }
    }
  }

  // ── Data Queries ─────────────────────────────────────────────────────

  private updateStatusBar(): void {
    const counts: Record<string, number> = {};
    for (const status of TRACE_STATUSES) {
      const row = this.db
        .prepare('SELECT COUNT(*) as cnt FROM agent_traces WHERE status = ?')
        .get(status) as { cnt: number } | undefined;
      counts[status] = row?.cnt ?? 0;
    }

    const titles = Object.keys(counts);
    const data = Object.values(counts);

    this.barChart.setData({
      titles,
      data,
    });
  }

  private updateStats(): void {
    const totalRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM agent_traces')
      .get() as { cnt: number };
    const stepRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM agent_trace_steps')
      .get() as { cnt: number };
    const evalRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM agent_trace_evals')
      .get() as { cnt: number };
    const policyRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM guardrail_policies WHERE enabled = 1')
      .get() as { cnt: number };

    const avgDur = this.db
      .prepare(
        'SELECT AVG(total_duration_ms) as avg_dur FROM agent_traces WHERE total_duration_ms IS NOT NULL',
      )
      .get() as { avg_dur: number | null };

    const totalTokens = this.db
      .prepare(
        'SELECT SUM(total_tokens) as total FROM agent_traces WHERE total_tokens IS NOT NULL',
      )
      .get() as { total: number | null };

    const totalCost = this.db
      .prepare(
        'SELECT SUM(total_cost_usd) as total FROM agent_traces WHERE total_cost_usd IS NOT NULL',
      )
      .get() as { total: number | null };

    const lines = [
      `{cyan-fg}Traces:{/cyan-fg}       ${totalRow.cnt}`,
      `{cyan-fg}Steps:{/cyan-fg}        ${stepRow.cnt}`,
      `{cyan-fg}Evaluations:{/cyan-fg}  ${evalRow.cnt}`,
      `{cyan-fg}Policies:{/cyan-fg}     ${policyRow.cnt}`,
      '',
      `{cyan-fg}Avg Duration:{/cyan-fg} ${avgDur.avg_dur != null ? formatMs(avgDur.avg_dur) : '-'}`,
      `{cyan-fg}Total Tokens:{/cyan-fg} ${totalTokens.total != null ? totalTokens.total.toLocaleString() : '-'}`,
      `{cyan-fg}Total Cost:{/cyan-fg}   ${totalCost.total != null ? '$' + totalCost.total.toFixed(4) : '-'}`,
    ];

    this.statsBox.setContent(lines.join('\n'));
  }

  private updateTraceList(): void {
    const rows = this.db
      .prepare(
        `SELECT id, agent_name, status, started_at
         FROM agent_traces
         ORDER BY started_at DESC
         LIMIT 30`,
      )
      .all() as Array<{
      id: string;
      agent_name: string;
      status: string;
      started_at: string;
    }>;

    const headers = ['ID', 'Agent', 'Status', 'Started'];
    const data = rows.map((r) => [
      r.id.slice(0, 12),
      truncate(r.agent_name, 18),
      r.status,
      formatRelative(r.started_at),
    ]);

    this.traceTable.setData({
      headers,
      data,
    });
  }

  private updateEvalChart(): void {
    const rows = this.db
      .prepare(
        `SELECT e.score, e.evaluated_at
         FROM agent_trace_evals e
         ORDER BY e.evaluated_at DESC
         LIMIT 20`,
      )
      .all() as Array<{ score: number; evaluated_at: string }>;

    if (rows.length === 0) {
      this.lineChart.setData([
        {
          title: 'Eval Scores',
          x: ['(no data)'],
          y: [0],
          style: { line: 'cyan' },
        },
      ]);
      return;
    }

    // Reverse so oldest is on the left
    rows.reverse();

    const x = rows.map((r) => {
      const d = new Date(r.evaluated_at);
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
    const y = rows.map((r) => Math.round(r.score * 100));

    this.lineChart.setData([
      {
        title: 'Eval Scores',
        x,
        y,
        style: { line: 'cyan' },
      },
    ]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}
