import { resolve } from 'node:path';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { importClaudeTranscript } from '../services/importers/claude-transcript.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { errorMessage } from '../utils/json.js';

export interface ImportOptions {
  format?: string;
  tags?: string;
  dir?: string;
}

const SUPPORTED = ['claude-transcript'];

/**
 * `agent-replay import <path> --format <fmt>` — best-effort conversion of an
 * on-disk session log into a trace. Unrecognized records are skipped and
 * counted; the imported/skipped tally is reported.
 */
export function runImport(filePath: string, opts: ImportOptions = {}): void {
  const format = opts.format ?? 'claude-transcript';
  if (!SUPPORTED.includes(format)) {
    console.error(chalk.red(`  Unsupported --format "${format}". Supported: ${SUPPORTED.join(', ')}.`));
    process.exitCode = 2;
    return;
  }

  const absPath = resolve(filePath);
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const tags = (opts.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let report;
  try {
    report = importClaudeTranscript(db, absPath, { tags: tags.length ? tags : undefined });
  } catch (err) {
    console.error(chalk.red(`  Import failed: ${errorMessage(err)}`));
    process.exitCode = 1;
    return;
  }

  if (!report.trace) {
    console.error(chalk.yellow(`  Nothing importable found in ${absPath} (${report.skipped} record(s) skipped).`));
    return;
  }

  console.log('');
  console.log(
    summaryPanel('Import Summary', {
      'Trace ID': report.trace.id,
      'Session': report.trace.session_id ?? '(none)',
      'Steps': report.steps,
      'Records imported': report.imported,
      'Records skipped': report.skipped,
    }),
  );
  console.log('');
}
