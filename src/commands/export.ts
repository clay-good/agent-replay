import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type { ListTracesFilter } from '../models/types.js';
import { TRACE_STATUSES } from '../models/enums.js';
import { exportTraces, type ExportFormat } from '../services/export-service.js';
import { getTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { parseSinceToIso } from '../utils/time.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';

export interface ExportOptions {
  format?: string;
  status?: string;
  tag?: string;
  agent?: string;
  since?: string;
  withEvals?: boolean;
  withSnapshots?: boolean;
  output?: string;
  dir?: string;
}

/**
 * `agent-replay export` — export traces in JSON, JSONL, or golden dataset format.
 * Writes to --output file or stdout.
 *
 * With a `traceId`, exports exactly that one trace (parity with show/why/replay/
 * fork/eval); without one, exports every trace matching the filter flags. The two
 * are mutually exclusive — passing both is a usage error rather than silently
 * ignoring the filters.
 */
export function runExport(traceId: string | undefined, opts: ExportOptions = {}): void {
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  const filter: ListTracesFilter = {};

  if (traceId) {
    const conflicting = ['status', 'agent', 'tag', 'since'] as const;
    const used = conflicting.filter((k) => opts[k] != null);
    if (used.length > 0) {
      console.error(
        chalk.red(`  A trace id can't be combined with filter flags (${used.map((k) => `--${k}`).join(', ')}).`),
      );
      console.error(chalk.dim('  Pass a trace id to export one trace, or filters to export a set — not both.'));
      process.exitCode = 2;
      return;
    }
    const full = getTrace(db, traceId);
    if (!full) {
      console.error(chalk.red(`  Trace not found: ${traceId}`));
      process.exitCode = 1;
      return;
    }
    // Resolve to the canonical id so a prefix exports exactly the one match.
    filter.id = full.id;
  }

  if (opts.status) {
    // Validate here rather than letting listTraces throw inside the export
    // block below, whose blanket catch reports every failure as exit 1. A bad
    // argument value is a usage error (exit 2) — what `list` returns for this
    // exact error, what the README documents, and what the --since / --format
    // checks around it already do. A CI script branching on 1 vs 2 otherwise
    // reads a typo as a runtime failure.
    if (!(TRACE_STATUSES as readonly string[]).includes(opts.status)) {
      console.error(chalk.red(`  Invalid status: ${opts.status}`));
      console.error(chalk.dim(`  Valid statuses: ${TRACE_STATUSES.join(', ')}`));
      process.exitCode = 2;
      return;
    }
    filter.status = opts.status;
  }
  if (opts.agent) filter.agent_name = opts.agent;
  if (opts.tag) filter.tag = opts.tag;
  if (opts.since) {
    try {
      filter.since = parseSinceToIso(opts.since);
    } catch (err) {
      console.error(chalk.red(`  ${errorMessage(err)}`));
      process.exitCode = 2;
      return;
    }
  }

  const format = (opts.format ?? 'json') as ExportFormat;
  const validFormats: ExportFormat[] = ['json', 'jsonl', 'golden'];
  if (!validFormats.includes(format)) {
    console.error(chalk.red(`  Invalid format: ${format}`));
    console.error(chalk.dim(`  Valid formats: ${validFormats.join(', ')}`));
    process.exitCode = 2;
    return;
  }

  // The golden format has a fixed shape: it always carries eval criteria and
  // never carries snapshots, and `exportGolden` takes no options at all. Both
  // flags were accepted and then silently did nothing, so a user asking for
  // snapshots got a success message and a file without them.
  if (format === 'golden' && (opts.withEvals || opts.withSnapshots)) {
    const ignored = [opts.withEvals && '--with-evals', opts.withSnapshots && '--with-snapshots']
      .filter(Boolean)
      .join(' and ');
    console.error(chalk.yellow(`  ⚠ ${ignored} has no effect with --format golden.`));
    console.error(chalk.dim('    A golden entry always includes eval criteria, and never includes snapshots.'));
  }

  const spinner = startSpinner(`Exporting as ${format.toUpperCase()}...`);

  try {
    const output = exportTraces(db, filter, format, {
      withEvals: opts.withEvals,
      withSnapshots: opts.withSnapshots,
    });

    if (opts.output) {
      const outPath = resolve(opts.output);
      writeFileSync(outPath, output);
      successSpinner(spinner, `Exported to ${outPath}`);
    } else {
      spinner.stop();
      process.stdout.write(output);
    }
    // Only for a file export: a warning on stdout-piped output is noise in the
    // middle of someone's pipeline, and the empty/partial baseline it warns
    // about is a thing you fix by re-running the export that wrote the file.
    if (format === 'golden' && opts.output) warnAboutBaseline(output);
  } catch (err) {
    failSpinner(spinner, `Export failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}

/**
 * Warn when a golden baseline can't do the job it will be used for. Both cases
 * are silent otherwise, and both survive into CI as a green gate.
 *
 * A baseline is meant to be built from known-good runs, but nothing filters by
 * status: a `running` trace bakes in a truncated prefix of a run still in
 * flight, so the next correct, completed run "regresses" against it; a `failed`
 * or `timeout` trace asserts the failure as the expected shape, so a candidate
 * that faithfully reproduces the break passes green. Say so here, where
 * re-exporting with `--tag known-good` still costs nothing.
 */
function warnAboutBaseline(output: string): void {
  if (output.trim() === '[]') {
    console.error(chalk.yellow('  ⚠ No traces matched — this golden baseline is empty and cannot detect a regression.'));
    return;
  }
  let entries: { metadata?: { status?: unknown } }[];
  try {
    entries = JSON.parse(output);
  } catch {
    return; // the export we just produced; unparseable is not something to report on
  }
  const other = entries.filter((e) => e?.metadata?.status !== 'completed').length;
  if (other > 0) {
    console.error(
      chalk.yellow(`  ⚠ ${other} of ${entries.length} baseline entr${other === 1 ? 'y is' : 'ies are'} not from a completed run.`),
    );
    console.error(
      chalk.dim('    An in-flight run bakes in a partial shape (later correct runs then "regress"); a failed one makes reproducing the failure pass. Filter with --tag known-good, or --status completed.'),
    );
  }
}
