import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type Database from 'better-sqlite3';
import type { IngestTraceInput } from '../models/types.js';
import { validateTraceInput } from '../utils/validators.js';
import { ingestTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';

export interface IngestOptions {
  format?: 'json' | 'jsonl';
  tags?: string;
  dryRun?: boolean;
  dir?: string;
}

/**
 * `agent-replay ingest <file>` — read a JSON or JSONL file, validate each
 * trace against IngestTraceInput, and insert via the trace service.
 */
export function runIngest(filePath: string, opts: IngestOptions = {}): void {
  const absPath = resolve(filePath);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  const spinner = startSpinner(`Reading ${absPath}...`);

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (err) {
    failSpinner(spinner, `Failed to read file: ${absPath}`);
    console.error(chalk.red(errorMessage(err)));
    process.exitCode = 1;
    return;
  }

  // Reject an unknown --format rather than silently parsing as JSONL (which
  // surfaces as a confusing "validation failed" instead of naming the problem).
  if (opts.format && opts.format !== 'json' && opts.format !== 'jsonl') {
    failSpinner(spinner, `Invalid --format "${opts.format}". Valid: json, jsonl.`);
    process.exitCode = 2;
    return;
  }

  // Auto-detect format
  const format = opts.format ?? detectFormat(raw);
  spinner.text = `Parsing as ${format.toUpperCase()}...`;

  // Parse traces
  let traces: unknown[];
  const parseWarnings: string[] = [];
  try {
    traces = parseTraces(raw, format, parseWarnings);
  } catch (err) {
    failSpinner(spinner, `Parse error: ${errorMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  // A line that could not be parsed is a dropped record, so it fails the command
  // exactly like a record that failed validation — but the valid ones still load.
  for (const w of parseWarnings) {
    console.error(chalk.red(`  ${w}`));
    process.exitCode = 1;
  }

  if (traces.length === 0) {
    failSpinner(spinner, parseWarnings.length > 0 ? 'No traces could be parsed from file.' : 'No traces found in file.');
    process.exitCode = 1;
    return;
  }

  spinner.text = `Validating ${traces.length} trace(s)...`;

  // Validate
  const errors: string[] = [];
  const valid: IngestTraceInput[] = [];

  for (let i = 0; i < traces.length; i++) {
    const t = traces[i] as Record<string, unknown>;
    const errs = validateTrace(t, i);
    if (errs.length > 0) {
      errors.push(...errs);
    } else {
      const input = t as unknown as IngestTraceInput;
      // Apply extra tags if provided
      if (opts.tags) {
        const extraTags = opts.tags.split(',').map((s) => s.trim()).filter(Boolean);
        input.tags = [...(input.tags ?? []), ...extraTags];
      }
      valid.push(input);
    }
  }

  if (errors.length > 0) {
    failSpinner(spinner, `Validation failed with ${errors.length} error(s):`);
    for (const e of errors.slice(0, 10)) {
      console.error(chalk.red(`  • ${e}`));
    }
    if (errors.length > 10) {
      console.error(chalk.dim(`  ... and ${errors.length - 10} more`));
    }
    // Any validation error is a non-zero exit, even when we continue with the
    // valid subset. A partial failure silently drops input records, so it must
    // not read as success to a CI gate — matching the total-failure path below
    // and the documented exit-code contract. (--dry-run reaches this too, so a
    // "validate my file" gate fails when any record is invalid.)
    process.exitCode = 1;
    if (valid.length === 0) {
      return;
    }
    console.log(chalk.yellow(`  Continuing with ${valid.length} valid trace(s).`));
  }

  // Dry run
  if (opts.dryRun) {
    successSpinner(spinner, `Dry run: ${valid.length} trace(s) validated, 0 inserted.`);
    return;
  }

  // Insert
  spinner.text = `Ingesting ${valid.length} trace(s)...`;
  let inserted = 0;
  let totalSteps = 0;
  const failedIds: string[] = [];

  for (const input of valid) {
    try {
      ingestTrace(db, input);
      inserted++;
      totalSteps += input.steps?.length ?? 0;
    } catch (err) {
      failedIds.push(input.agent_name ?? '?');
      console.error(chalk.red(`  Error inserting trace "${input.agent_name}": ${errorMessage(err)}`));
    }
  }

  // `export --with-evals` writes an `evals` array that `ingest` has no field
  // for, so it is dropped — silently, on the documented backup/restore path,
  // for data the user opted in to keeping. Restoring it is a schema change and
  // a maintainer call; reporting the loss is not, and a restore that reads as
  // complete while it is not is exactly what the rest of this command refuses
  // to do. The traces themselves restore faithfully.
  const withEvals = valid.reduce(
    (n, t) => n + (Array.isArray((t as unknown as { evals?: unknown[] }).evals)
      ? (t as unknown as { evals: unknown[] }).evals.length
      : 0),
    0,
  );
  if (withEvals > 0) {
    // On stdout, like the sibling "Continuing with N valid trace(s)" note:
    // `ingest` has no --json mode, so stdout is the report.
    console.log(
      chalk.yellow(
        `  Note: ${withEvals} stored eval result(s) in this file were not restored — ` +
        'ingest has no evals field. Re-run `agent-replay eval` to regenerate them.',
      ),
    );
  }

  if (failedIds.length > 0) {
    failSpinner(
      spinner,
      `Ingested ${inserted}/${valid.length} traces (${failedIds.length} failed).`,
    );
    process.exitCode = 1;
  } else {
    successSpinner(spinner, `Ingested ${inserted} trace(s) successfully.`);
  }

  // Summary
  console.log('');
  console.log(
    summaryPanel('Ingest Summary', {
      'Traces inserted': inserted,
      'Total steps': totalSteps,
      'Validation errors': errors.length,
      'Insert failures': failedIds.length,
    }),
  );
  console.log('');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function detectFormat(raw: string): 'json' | 'jsonl' {
  // Content, not extension, decides. Anything whose entire contents parse as a
  // single JSON value is `json` — a pretty-printed array/object spans many lines
  // but is still one value. Only fall back to line-delimited when the whole-file
  // parse fails (real JSONL, where each line is its own object).
  //
  // The extension is deliberately NOT trusted: `export --format json` (the
  // default) into a `.jsonl`-named file writes a JSON array, and short-circuiting
  // on the extension made ingest line-split it and die with a misleading "Invalid
  // JSON on line 1" even though the JSON was valid. Probing content is strictly
  // safe — genuine multi-record JSONL still fails the whole-file parse and stays
  // `jsonl`, and a file that is one valid JSON value ingests identically either
  // way. `--format` still overrides detection for a deliberate mismatch.
  try {
    JSON.parse(raw);
    return 'json';
  } catch {
    return 'jsonl';
  }
}

function parseTraces(raw: string, format: 'json' | 'jsonl', parseWarnings: string[]): unknown[] {
  if (format === 'json') {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  // JSONL: one JSON object per line. Track the true file line number *before*
  // dropping blank/comment lines, so a parse error names the line the user sees
  // in their editor rather than a post-filter index.
  // Parse per line and keep going. Throwing on the first bad line discarded the
  // WHOLE file — three valid traces beside one truncated line ingested nothing —
  // which contradicts the policy the validation stage right below states: ingest
  // the valid subset, and exit 1 because something was dropped. The bad lines are
  // reported the same way invalid records are.
  const parsed: Record<string, unknown>[] = [];
  const badLines: number[] = [];
  for (const [idx, line] of raw.split('\n').entries()) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('//')) continue;
    try {
      parsed.push(JSON.parse(text));
    } catch {
      badLines.push(idx + 1);
    }
  }
  if (badLines.length > 0) {
    parseWarnings.push(
      `Invalid JSON on line${badLines.length > 1 ? 's' : ''} ${badLines.slice(0, 10).join(', ')}` +
        (badLines.length > 10 ? ` and ${badLines.length - 10} more` : ''),
    );
  }
  return parsed;
}

function validateTrace(t: Record<string, unknown>, index: number): string[] {
  // Delegate to the canonical validator, which additionally enforces
  // parent_step/caused_by_step references (must exist and point strictly
  // earlier — so cycles and self-parents are rejected), decision-record shape,
  // and session_id, on top of the basic identity/enum checks.
  const result = validateTraceInput(t);
  return result.errors.map((e) => `Trace[${index}].${e.field}: ${e.message}`);
}
