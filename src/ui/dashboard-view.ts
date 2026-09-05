import blessed from 'blessed';
import type Database from 'better-sqlite3';
import type { Trace, EvalResult } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { formatDuration, formatRelativeTime, parseInstant } from '../utils/time.js';
import { truncateToWidth } from './width.js';
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
      // Without this, blessed substitutes `?` for every wide or astral
      // character in its draw path — so a Japanese agent name rendered as
      // `??????????` in the Recent Traces panel while `list` showed the same
      // name correctly. The dashboard is the one surface that reads a trace's
      // text through blessed rather than straight to stdout, so it is the one
      // surface that needs to be told the terminal is UTF-8.
      fullUnicode: true,
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
        // Same widget class, same markup rule — an error message can carry a
        // producer's text (a tool name, a trace id) straight into the log.
        const msg = blessed.escape(safeText(err instanceof Error ? err.message : String(err)));
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
    // `blessed.escape` on top of `safeText`: this widget is created with
    // `tags: true`, so blessed CONSUMES `{...}` markup in cell text. An agent
    // name containing `{red-fg}` therefore displayed as something other than
    // what is stored — wrong output, and a producer setting colours in the TUI.
    // safeText handles control characters; only blessed knows its own markup.
    const cell = (v: string): string => blessed.escape(safeText(v));
    const data = rows.map((r) => [
      cell(r.id.slice(0, 12)),
      cell(truncateToWidth(r.agent_name, 18)),
      r.status,
      formatRelativeTime(r.started_at),
    ]);

    // listtable takes headers as the first row. `setData` ends with an
    // unconditional `select(0)`, unlike the `setItems` the previous widget used
    // (which restores the prior selection) — so every auto-refresh yanked the
    // cursor back to the top row and arrow-key navigation was unusable on any
    // live store. Restore the row the user was on.
    const selected = (this.traceTable as unknown as { selected?: number }).selected ?? 0;
    this.traceTable.setData([headers, ...data]);
    if (selected > 0 && data.length > 0) {
      this.traceTable.select(Math.min(selected, data.length));
    }
  }

  private updateEvalChart(): void {
    const rows = recentEvalScores(this.db);
    // recentEvalScores already returns oldest-first, so time reads left→right.
    const points = rows.map((r) => {
      // Read the way the SQL side reads it — see parseInstant. A zone-less
      // stored timestamp is UTC there and local here, which shifted these
      // sparkline labels by the machine's offset.
      const d = new Date(parseInstant(r.evaluated_at));
      return {
        label: `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
        // NOT rounded: `formatScorePct` exists so a sub-threshold score never
        // reads as the threshold, and rounding here reintroduced exactly that —
        // 0.695 showed as 69.5% in `show`/`eval` and 70% on this panel, for the
        // same stored value.
        value: r.score * 100,
      };
    });
    this.lineChart.setContent(
      renderScoreSparkline(points, Math.max(10, (this.lineChart.width as number) - 8)),
    );
  }
}
