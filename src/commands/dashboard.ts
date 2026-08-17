import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { DashboardView } from '../ui/dashboard-view.js';
import { resolveDataDir } from '../utils/paths.js';

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
  let refreshSeconds = 5;
  if (opts.refresh != null) {
    const r = Number(opts.refresh);
    if (!Number.isInteger(r) || r < 1) {
      console.error(chalk.red(`  Invalid --refresh: ${opts.refresh} (must be a positive integer number of seconds).`));
      process.exitCode = 2;
      return;
    }
    // Use the value we validated. A second parse (parseInt) would disagree on
    // strings like "0x20" (Number → 32 but parseInt → 0, a zero-second refresh)
    // or "1e2" (100 vs 1).
    refreshSeconds = r;
  }

  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  const dashboard = new DashboardView(db, {
    refreshIntervalMs: refreshSeconds * 1000,
  });

  dashboard.start();
}
