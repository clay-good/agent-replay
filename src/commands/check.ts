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
    const filter: Record<string, unknown> = { limit: 10000 };
    if (opts.agent) filter.agent_name = opts.agent;
    if (opts.since) filter.since = parseSinceToIso(opts.since);
    const { items } = listTraces(db, filter);
    for (const item of items) {
      const full = getTrace(db, item.id);
      if (full) candidates.push(full);
    }
  }

  const fields = opts.fields ? opts.fields.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const report = checkGolden(golden, candidates, { fields, strict: opts.strict });

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
