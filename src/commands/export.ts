import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type { ListTracesFilter } from '../models/types.js';
import { exportTraces, type ExportFormat } from '../services/export-service.js';
import { ensureDatabase } from '../db/index.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { parseSinceToIso } from '../utils/time.js';
import { errorMessage } from '../utils/json.js';

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
 */
export function runExport(opts: ExportOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const filter: ListTracesFilter = {};
  if (opts.status) filter.status = opts.status;
  if (opts.agent) filter.agent_name = opts.agent;
  if (opts.tag) filter.tag = opts.tag;
  if (opts.since) filter.since = parseSinceToIso(opts.since);

  const format = (opts.format ?? 'json') as ExportFormat;
  const validFormats: ExportFormat[] = ['json', 'jsonl', 'golden'];
  if (!validFormats.includes(format)) {
    console.error(chalk.red(`  Invalid format: ${format}`));
    console.error(chalk.dim(`  Valid formats: ${validFormats.join(', ')}`));
    return;
  }

  const spinner = startSpinner(`Exporting as ${format.toUpperCase()}...`);

  try {
    const output = exportTraces(db, filter, format, {
      withEvals: opts.withEvals,
      withSnapshots: opts.withSnapshots,
    });

    if (opts.output) {
      const outPath = resolve(opts.output);
      writeFileSync(outPath, output + '\n');
      successSpinner(spinner, `Exported to ${outPath}`);
    } else {
      spinner.stop();
      process.stdout.write(output + '\n');
    }
  } catch (err) {
    failSpinner(spinner, `Export failed: ${errorMessage(err)}`);
  }
}
