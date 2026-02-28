import { resolve } from 'node:path';
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
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const refreshSeconds = Math.max(1, safeParseInt(opts.refresh, 5));

  const dashboard = new DashboardView(db, {
    refreshIntervalMs: refreshSeconds * 1000,
  });

  dashboard.start();
}
