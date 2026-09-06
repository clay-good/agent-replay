import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { dashboardStats, statusCounts, agentStats } from '../ui/dashboard-data.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { heading, label, formatCostUsd, safeText, safeLine} from '../ui/theme.js';
import { formatDuration, parseSinceToIso } from '../utils/time.js';
import { errorMessage, truncate} from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse, openStoreOr } from '../utils/refuse.js';

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
/** " (over N of M)" when a figure covers fewer traces than the store holds. */
function scopeNote(sample: number, total: number): string {
  return sample < total ? ` (over ${sample} of ${total})` : '';
}

export function runStats(opts: StatsOptions = {}): void {
  const refuse = makeRefuse(opts.json);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath, opts.dir);
  if (!db) return;

  // A malformed --since is a usage error, not a silent store-wide fallback
  // (which would hide a typo behind plausible-looking numbers). Mirrors `list`.
  let filter: { since?: string } = {};
  if (opts.since != null) {
    try {
      filter = { since: parseSinceToIso(opts.since) };
    } catch (err) {
      refuse(2, `Invalid --since: ${errorMessage(err)}`);
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
      // Say what the average measured whenever that is not every trace. A
      // duration is unmeasurable for a trace still running, one with a
      // clock-skewed ended_at, or one whose timestamps no format parses — so
      // "Avg duration: 5.0s" could describe a single trace while "Traces: 100"
      // sat directly above it. The scope is now stated rather than assumed.
      'Avg duration': overall.avgDurationMs != null
        ? formatDuration(Math.round(overall.avgDurationMs)) +
          scopeNote(overall.avgDurationSample, overall.traces)
        : '-',
      // ...and the same for the two sums beside it. Both are taken over
      // whatever subset records the value, so "Total cost: $0.19" over a store
      // of 100 traces where 3 carry a cost is not the store's spend — while the
      // average one row up already states its scope. Say it here too.
      'Total tokens': overall.totalTokens != null
        ? overall.totalTokens.toLocaleString() + scopeNote(overall.totalTokensSample, overall.traces)
        : '-',
      'Total cost': overall.totalCost != null
        ? formatCostUsd(overall.totalCost) + scopeNote(overall.totalCostSample, overall.traces)
        : '-',
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
      // The tally deliberately counts timeouts alongside failures (see
      // agentStats), but the label said only "failed" — so a store with one
      // timeout and no failures printed "1 failed" three lines below a status
      // breakdown showing `timeout 1` and no failed row.
      const failed = a.failed_or_timeout > 0 ? chalk.red(` (${a.failed_or_timeout} failed or timed out)`) : '';
      console.log(`    ${label(safeLine(truncate(a.agent_name, 40)))} ${chalk.white(String(a.count))}${failed}`);
    }
  }

  console.log('');
}
