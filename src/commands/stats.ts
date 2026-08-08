import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { dashboardStats, statusCounts, agentStats } from '../ui/dashboard-data.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { heading, label } from '../ui/theme.js';
import { formatDuration, parseSinceToIso } from '../utils/time.js';
import { errorMessage } from '../utils/json.js';

export interface StatsOptions {
  json?: boolean;
  since?: string;
  dir?: string;
}

/**
 * `agent-replay stats` — a non-interactive, scriptable summary of the trace
 * store (the same aggregates the dashboard TUI shows, but printable to a log or
 * consumable as `--json` in CI, where the full-screen dashboard can't run).
 */
export function runStats(opts: StatsOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // A malformed --since is a usage error, not a silent store-wide fallback
  // (which would hide a typo behind plausible-looking numbers). Mirrors `list`.
  let filter: { since?: string } = {};
  if (opts.since != null) {
    try {
      filter = { since: parseSinceToIso(opts.since) };
    } catch (err) {
      console.error(chalk.red(`  Invalid --since: ${errorMessage(err)}`));
      process.exitCode = 2;
      return;
    }
  }

  const overall = dashboardStats(db, filter);
  const byStatus = statusCounts(db, filter);
  const byAgent = agentStats(db, filter);

  if (opts.json) {
    const status: Record<string, number> = {};
    byStatus.titles.forEach((t, i) => (status[t] = byStatus.data[i]));
    console.log(
      JSON.stringify(
        { since: filter.since ?? null, overall, by_status: status, by_agent: byAgent },
        null,
        2,
      ),
    );
    return;
  }

  console.log('');
  console.log(
    summaryPanel(filter.since ? `Store Summary — since ${opts.since}` : 'Store Summary', {
      Traces: overall.traces,
      Steps: overall.steps,
      Evals: overall.evals,
      'Active policies': overall.policies,
      'Avg duration': overall.avgDurationMs != null ? formatDuration(Math.round(overall.avgDurationMs)) : '-',
      'Total tokens': overall.totalTokens != null ? overall.totalTokens.toLocaleString() : '-',
      'Total cost': overall.totalCost != null ? '$' + overall.totalCost.toFixed(4) : '-',
    }),
  );

  // Per-status breakdown — only the statuses that actually occur.
  const seenStatuses = byStatus.titles
    .map((t, i) => [t, byStatus.data[i]] as const)
    .filter(([, n]) => n > 0);
  if (seenStatuses.length > 0) {
    console.log('');
    console.log(heading('  By status:'));
    for (const [t, n] of seenStatuses) {
      console.log(`    ${label(t)} ${chalk.white(String(n))}`);
    }
  }

  if (byAgent.length > 0) {
    console.log('');
    console.log(heading('  By agent:'));
    for (const a of byAgent) {
      const failed = a.failed > 0 ? chalk.red(` (${a.failed} failed)`) : '';
      console.log(`    ${label(a.agent_name)} ${chalk.white(String(a.count))}${failed}`);
    }
  }

  console.log('');
}
