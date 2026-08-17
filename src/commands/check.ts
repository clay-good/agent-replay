import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { getTrace, listTraces } from '../services/trace-service.js';
import { checkGolden } from '../services/check-service.js';
import type { GoldenEntry } from '../services/export-service.js';
import type { TraceWithDetails } from '../models/types.js';
import { heading } from '../ui/theme.js';
import { parseSinceToIso } from '../utils/time.js';
import { errorMessage } from '../utils/json.js';

export interface CheckOptions {
  golden?: string;
  trace?: string;
  agent?: string;
  since?: string;
  fields?: string;
  strict?: boolean;
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay check --golden <file>` — CI regression check comparing traces
 * against a golden dataset on a structural field allowlist. Exits non-zero when
 * any matched trace regresses.
 */
export function runCheck(opts: CheckOptions = {}): void {
  if (!opts.golden) {
    console.error(chalk.red('  --golden <file> is required.'));
    process.exitCode = 2;
    return;
  }

  let golden: GoldenEntry[];
  try {
    const parsed = JSON.parse(readFileSync(resolve(opts.golden), 'utf-8'));
    golden = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error(chalk.red(`  Failed to read golden file: ${errorMessage(err)}`));
    process.exitCode = 2;
    return;
  }

  // A baseline with no entries cannot gate anything: every candidate falls to
  // the `unmatched` branch, which passes unless --strict, so the run reports
  // "0 passed, 0 regressed" in green and exits 0 — forever. `export --format
  // golden` writes `[]` happily when its filter matches nothing (a mistyped
  // --tag is enough), so this is a mistake a user can make silently and never
  // hear about again. Refuse it, like an unreadable file.
  // `export --format json` and `export --format golden` differ by one flag and
  // produce files that look alike, so feeding the wrong one is an easy mistake.
  // Without this the run died inside the comparison on `steps_summary.length`
  // with a bare "Cannot read properties of undefined", naming neither the file
  // nor the problem — and one bad entry in a hand-edited baseline aborted the
  // whole check rather than being reported.
  const bad = golden.findIndex((g) => !g || !Array.isArray((g as GoldenEntry).steps_summary));
  if (bad !== -1) {
    console.error(chalk.red(`  Not a golden dataset: ${opts.golden} (entry ${bad + 1} has no steps_summary).`));
    console.error(chalk.dim('  Golden files come from "agent-replay export --format golden"; "--format json" exports full traces, which this gate cannot compare.'));
    process.exitCode = 2;
    return;
  }

  if (golden.length === 0) {
    console.error(
      chalk.red(`  Golden file has no entries: ${opts.golden}`),
    );
    console.error(
      chalk.dim('  An empty baseline can never detect a regression. Re-export it with a filter that matches.'),
    );
    process.exitCode = 2;
    return;
  }

  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // Gather candidate traces.
  const candidates: TraceWithDetails[] = [];
  if (opts.trace) {
    const t = getTrace(db, opts.trace);
    if (!t) {
      console.error(chalk.red(`  Trace not found: ${opts.trace}`));
      process.exitCode = 2;
      return;
    }
    candidates.push(t);
  } else {
    // Gather EVERY matching candidate — a regression gate that silently stops
    // at the newest N traces can pass green while a real regression sits in an
    // older trace it never fetched. `listTraces` always emits `LIMIT ? OFFSET ?`;
    // SQLite treats a negative LIMIT as unbounded, so -1 returns all matches.
    // Mirrors `exportTraces`, which was moved off a fixed 10000 cap for the same
    // reason (a truncated scan corrupts the very datasets built from it).
    const filter: Record<string, unknown> = { limit: -1 };
    if (opts.agent) filter.agent_name = opts.agent;
    if (opts.since) {
      try {
        filter.since = parseSinceToIso(opts.since);
      } catch (err) {
        console.error(chalk.red(`  ${errorMessage(err)}`));
        process.exitCode = 2;
        return;
      }
    }
    const { items } = listTraces(db, filter);
    for (const item of items) {
      const full = getTrace(db, item.id);
      if (full) candidates.push(full);
    }
  }

  // Zero candidates is the empty-baseline failure from the other side, and just
  // as silent: nothing to compare means `0 passed, 0 regressed`, `ok: true`,
  // exit 0 — even under --strict, which only counts candidates that were
  // actually fetched. A mistyped --agent, a --since window that outran the
  // recording step, or a --dir typo (ensureDatabase creates a fresh empty store
  // on the spot) all land here, and the gate then stays green forever.
  if (candidates.length === 0) {
    console.error(chalk.red('  No traces matched — nothing to check against the baseline.'));
    console.error(chalk.dim('  A check with no candidates cannot detect a regression. Widen --agent/--since, or confirm --dir points at the store the run recorded into.'));
    process.exitCode = 2;
    return;
  }

  const fields = opts.fields ? opts.fields.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  let report;
  try {
    report = checkGolden(golden, candidates, { fields, strict: opts.strict });
  } catch (err) {
    console.error(chalk.red(`  ${errorMessage(err)}`));
    process.exitCode = 2;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  console.log('');
  console.log(heading('  Golden regression check'));
  console.log('');

  for (const r of report.results) {
    if (!r.matched) {
      console.log(`  ${chalk.dim('○')} ${chalk.dim(r.trace_id.slice(0, 12))} ${r.agent_name} — ${chalk.yellow('unmatched')}${opts.strict ? chalk.red(' (strict: fail)') : ''}`);
      continue;
    }
    if (r.passed) {
      console.log(`  ${chalk.green('✔')} ${chalk.dim(r.trace_id.slice(0, 12))} ${r.agent_name} — ${chalk.green('pass')}`);
    } else {
      console.log(`  ${chalk.redBright('✘')} ${chalk.dim(r.trace_id.slice(0, 12))} ${r.agent_name} — ${chalk.redBright('REGRESSED')}`);
      for (const d of r.divergences) {
        const at = d.step_number != null ? chalk.dim(` @step ${d.step_number}`) : '';
        console.log(`      ${chalk.white(d.field)}${at}: golden ${chalk.green(short(d.golden))} → got ${chalk.redBright(short(d.candidate))}`);
      }
    }
  }

  console.log('');
  const summary = `${report.passed} passed, ${report.failed} regressed, ${report.unmatched} unmatched`;
  console.log(report.ok ? chalk.green(`  ${summary}`) : chalk.redBright(`  ${summary}`));
  console.log('');

  process.exitCode = report.ok ? 0 : 1;
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s != null && s.length > 60 ? `${s.slice(0, 57)}...` : String(s);
}
