import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { DashboardView } from '../ui/dashboard-view.js';
import { resolveDataDir, storeExists, storeAboveNote } from '../utils/paths.js';

export interface DashboardOptions {
  refresh?: string;
  dir?: string;
}

/**
 * `agent-replay dashboard` — launch a full-screen terminal dashboard
 * with trace stats, eval charts, and guardrail activity.
 */
/**
 * The largest `--refresh` that survives `setInterval`.
 *
 * Node stores a timer delay in a 32-bit signed int. Anything above
 * 2,147,483,647 ms does not overflow into a long wait — it is CLAMPED TO 1 ms,
 * so `--refresh 999999999999`, which plainly asks for "refresh almost never",
 * re-ran every dashboard aggregate about a thousand times a second and pinned
 * a core. The failure is the exact inverse of the request, which is why this
 * is refused rather than clamped: the same reasoning already stated above for
 * a malformed value applies with more force to one that silently inverts.
 */
const MAX_REFRESH_SECONDS = Math.floor(2_147_483_647 / 1000);

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
    if (r > MAX_REFRESH_SECONDS) {
      console.error(chalk.red(`  Invalid --refresh: ${opts.refresh} (maximum is ${MAX_REFRESH_SECONDS} seconds).`));
      console.error(chalk.dim('  A larger value overflows the timer and refreshes every millisecond instead.'));
      process.exitCode = 2;
      return;
    }
    // Use the value we validated. A second parse (parseInt) would disagree on
    // strings like "0x20" (Number → 32 but parseInt → 0, a zero-second refresh)
    // or "1e2" (100 vs 1).
    refreshSeconds = r;
  }

  // Argument validation ran first, deliberately: a typo in --refresh should be
  // reported to the script that made it, not masked by the environment check.
  //
  // The dashboard is a full-screen TUI: it takes over the alternate screen,
  // enables mouse tracking, and exits only on a keypress. With no terminal
  // there is no keypress to wait for, so it hung forever — and it had already
  // written the alt-screen and mouse-tracking escapes into whatever the output
  // was redirected to. A CI job that ran it never finished, and its log filled
  // with control codes. Refuse the way the other interactive paths do (`guard`
  // checks isTTY before prompting; `replay --pause` skips its wait), before
  // opening the store or drawing anything.
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    console.error(chalk.red('  dashboard needs an interactive terminal.'));
    console.error(chalk.dim('  Its output is a live full-screen view, and it exits on a keypress.'));
    console.error(chalk.dim('  For a scriptable summary, use: agent-replay stats --json'));
    process.exitCode = 2;
    return;
  }

  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  // Refused, not created — same rule as the other read paths and as
  // `guard check`: `ensureDatabase` CREATES what it does not find, so this
  // wrote an empty store nobody asked for and then drew an empty dashboard
  // over it, which looks exactly like a project that has recorded nothing. Creating a store is `init`.
  if (!storeExists(resolveDataDir(opts.dir))) {
    console.error(chalk.red(`  No trace store at ${dbPath}.`));
    console.error(chalk.dim('  Run "agent-replay init" in the project directory, or pass --dir <path>.'));
    // ...and, if the caller is simply standing in a subdirectory of a project
    // that HAS a store, name it: the advice above would otherwise have them
    // create a second one beside their source.
    const above = storeAboveNote(opts.dir);
    if (above) console.error(chalk.dim(`  ${above}`));
    process.exitCode = 2;
    return;
  }
  const db = ensureDatabase(dbPath);

  const dashboard = new DashboardView(db, {
    refreshIntervalMs: refreshSeconds * 1000,
  });

  dashboard.start();
}
