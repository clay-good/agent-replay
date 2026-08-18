import blessed from 'blessed';
import type Database from 'better-sqlite3';
import type { Trace, EvalResult } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { formatDuration, formatRelativeTime } from '../utils/time.js';
import { truncate } from '../utils/json.js';
import { formatCostUsd, safeText } from './theme.js';
import { dashboardStats, statusCounts, recentTraces, recentEvalScores } from './dashboard-data.js';
import { renderStatusBars, renderScoreSparkline } from './dashboard-panels.js';

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
  private barChart!: blessed.Widgets.BoxElement;
  private traceTable!: blessed.Widgets.ListTableElement;
  private lineChart!: blessed.Widgets.BoxElement;
  private activityLog!: blessed.Widgets.Log;
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

    // Laid out in percentages rather than a grid widget: the grid came from
    // `blessed-contrib`, which is no longer a dependency (see dashboard-panels).
    // The proportions are the ones the 12x12 grid produced.
    const panel = {
      tags: true,
      border: { type: 'line' as const },
      style: { fg: 'white', border: { fg: 'cyan' } },
    };

    // ── Top-left: Trace Statuses ─────────────────────────────────────
    this.barChart = blessed.box({
      parent: this.screen,
      label: ' Trace Statuses ',
      top: 0, left: 0, width: '50%', height: '42%',
      padding: { left: 2, top: 1, right: 2, bottom: 1 },
      ...panel,
    });

    // ── Top-right: Aggregate Stats ───────────────────────────────────
    this.statsBox = blessed.box({
      parent: this.screen,
      label: ' Stats ',
      top: 0, left: '50%', width: '50%', height: '42%',
      padding: { left: 2, top: 1, right: 2, bottom: 1 },
      ...panel,
    });

    // ── Middle-left: Recent Traces ───────────────────────────────────
    this.traceTable = blessed.listtable({
      parent: this.screen,
      label: ' Recent Traces ',
      top: '42%', left: 0, width: '50%', height: '33%',
      keys: true,
      mouse: true,
      align: 'left',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'cyan' },
        header: { fg: 'cyan', bold: true },
        cell: { selected: { fg: 'black', bg: 'cyan' } },
      },
    });

    // ── Middle-right: Eval Scores ────────────────────────────────────
    this.lineChart = blessed.box({
      parent: this.screen,
      label: ' Eval Scores (recent) ',
      top: '42%', left: '50%', width: '50%', height: '33%',
      padding: { left: 2, top: 1, right: 2, bottom: 1 },
      ...panel,
    });

    // ── Bottom: Activity Log ─────────────────────────────────────────
    this.activityLog = blessed.log({
      parent: this.screen,
      label: ' Activity Log ',
      top: '75%', left: 0, width: '100%', height: '25%',
      scrollback: 50,
      ...panel,
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
    this.barChart.setContent(
      renderStatusBars(statusCounts(this.db), Math.max(10, (this.barChart.width as number) - 8)),
    );
  }

  private updateStats(): void {
    const s = dashboardStats(this.db);
    const lines = [
      `{cyan-fg}Traces:{/cyan-fg}       ${s.traces}`,
      `{cyan-fg}Steps:{/cyan-fg}        ${s.steps}`,
      `{cyan-fg}Evaluations:{/cyan-fg}  ${s.evals}`,
      `{cyan-fg}Policies:{/cyan-fg}     ${s.policies}`,
      '',
      `{cyan-fg}Avg Duration:{/cyan-fg} ${s.avgDurationMs != null ? formatDuration(s.avgDurationMs) : '-'}`,
      `{cyan-fg}Total Tokens:{/cyan-fg} ${s.totalTokens != null ? s.totalTokens.toLocaleString() : '-'}`,
      // formatCostUsd, not a flat toFixed(4): sub-cent runs are the normal case,
      // and four decimals rendered a store's whole real spend as "$0.0000" while
      // `stats` (which already uses it) reported the same number correctly.
      `{cyan-fg}Total Cost:{/cyan-fg}   ${s.totalCost != null ? formatCostUsd(s.totalCost) : '-'}`,
    ];

    this.statsBox.setContent(lines.join('\n'));
  }

  private updateTraceList(): void {
    const rows = recentTraces(this.db);

    const headers = ['ID', 'Agent', 'Status', 'Started'];
    const data = rows.map((r) => [
      safeText(r.id.slice(0, 12)),
      safeText(truncate(r.agent_name, 18)),
      r.status,
      formatRelativeTime(r.started_at),
    ]);

    // listtable takes headers as the first row.
    this.traceTable.setData([headers, ...data]);
  }

  private updateEvalChart(): void {
    const rows = recentEvalScores(this.db);
    // recentEvalScores already returns oldest-first, so time reads left→right.
    const points = rows.map((r) => {
      const d = new Date(r.evaluated_at);
      return {
        label: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
        value: Math.round(r.score * 100),
      };
    });
    this.lineChart.setContent(
      renderScoreSparkline(points, Math.max(10, (this.lineChart.width as number) - 8)),
    );
  }
}
