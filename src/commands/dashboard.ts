import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { DashboardView } from '../ui/dashboard-view.js';
import { safeParseInt } from '../utils/json.js';

export interface DashboardOptions {
  refresh?: string;
  dir?: string;
}

/**
 * `agent-replay dashboard` — launch a full-screen terminal dashboard
 * with trace stats, eval charts, and guardrail activity.
 */
export function runDashboard(opts: DashboardOptions = {}): void {
  // Reject a malformed --refresh up front (before launching the TUI) rather
  // than silently clamping a typo to the default.
  if (opts.refresh != null) {
    const r = Number(opts.refresh);
    if (!Number.isInteger(r) || r < 1) {
      console.error(chalk.red(`  Invalid --refresh: ${opts.refresh} (must be a positive integer number of seconds).`));
      process.exitCode = 2;
      return;
    }
  }

  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const refreshSeconds = safeParseInt(opts.refresh, 5);

  const dashboard = new DashboardView(db, {
    refreshIntervalMs: refreshSeconds * 1000,
  });

  dashboard.start();
}
