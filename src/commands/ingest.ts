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
import { resolveDataDir, storeSplitNote } from '../utils/paths.js';
import { escapeForMessage } from '../utils/json.js';

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
  // Record, but say where: creating a store here while a project above has
  // one splits the capture in two, and the half written here is invisible to a
  // command run from the project root. Never a refusal — losing the run is
  // worse than recording it somewhere unexpected.
  const splitNote = storeSplitNote(opts.dir, dbPath);
  if (splitNote) console.error(chalk.yellow(`  ⚠ ${splitNote}`));
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
  //
  // `!= null`, not truthiness: `""` is not a format, but a bare truthiness test
  // let it skip this check AND the `??` auto-detection below (which catches
  // only null/undefined), so `--format ""` did the exact silent parse-as-JSONL
  // this refusal exists to prevent. `ingest traces.json --format ""` — what
  // `--format "$FMT"` produces with FMT unset — then failed with "No traces
  // could be parsed from file", naming the file rather than the flag, while the
  // same file with the flag omitted ingested fine. The sibling commands get
  // this right already: `record` and `import` test membership with no
  // truthiness guard in front, so "" reaches their refusal. `ingest` needs the
  // guard at all only because an OMITTED format means auto-detect here.
  if (opts.format != null && opts.format !== 'json' && opts.format !== 'jsonl') {
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

  // A GOLDEN dataset handed to `ingest` validated cleanly and produced garbage:
  // a golden entry carries `agent_name` and `input`, so nothing here objected,
  // but its steps live in `steps_summary` — a key a trace export never writes
  // and this command never reads. The result was "Ingested 20 trace(s)
  // successfully" and a store holding 20 stepless traces that look like real
  // runs: they widen `list` and `stats`, and a golden dataset exported later
  // includes them, so a baseline made of empty runs gates CI on nothing.
  //
  // `check` already refuses the mirror mistake — a `--format json` export
  // handed to the gate — and names the command that produces the right file.
  // This is that guard at the twin site, worded the same way.
  const goldenLike = traces.filter(
    (t) => t != null && typeof t === 'object'
      && Array.isArray((t as Record<string, unknown>).steps_summary)
      && (t as Record<string, unknown>).steps === undefined,
  ).length;
  if (goldenLike > 0) {
    failSpinner(
      spinner,
      `Not a trace export: ${absPath} (${goldenLike} of ${traces.length} entries have steps_summary, not steps).`,
    );
    console.error(
      chalk.dim('  That is a golden dataset from "agent-replay export --format golden". Its steps are a summary this command cannot read,'),
    );
    console.error(
      chalk.dim('  so ingesting it would store traces with no steps. Use it with "agent-replay check --golden", or re-export the traces with "--format json".'),
    );
    process.exitCode = 2;
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

  // Fork lineage is dropped: `insertTraceRow` hard-codes parent_trace_id to null
  // (and ingest regenerates ids, so a parent reference in the file would not
  // point anywhere), while `export` writes both fields. Restoring the link needs
  // an in-file id remap and a decision about a fork whose parent is not in the
  // file — a schema/semantics call. Saying so is not: a restored fork silently
  // becomes an ordinary trace, and the guards that exclude forks (golden export,
  // `check`, `watch`) then treat it as a real run.
  const forks = valid.filter((t) => (t as unknown as { parent_trace_id?: unknown }).parent_trace_id != null).length;
  if (forks > 0) {
    console.log(
      chalk.yellow(
        `  Note: ${forks} trace(s) in this file are forks; they are restored as ordinary traces — ` +
        'ingest cannot rebuild fork lineage, so `check` and `watch` will treat them as real runs, ' +
        'and `export --format golden` will INCLUDE them in a baseline it would otherwise exclude.',
      ),
    );
  }

  // NOTE: there was a note here saying stored evals could not be restored and
  // advising the reader to re-run `agent-replay eval` to regenerate them. Ingest
  // now restores them (with their original `evaluated_at`), so the note was
  // false and sent people to redo work that had already been done. A stale
  // warning is worse than none: it is a statement about the tool's behaviour
  // that the tool contradicts.

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
      console.error(chalk.red(`  Error inserting trace "${escapeForMessage(String(input.agent_name))}": ${errorMessage(err)}`));
    }
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

  // A JSON ARRAY read as JSONL answered with thousands of "Invalid JSON on
  // line N" warnings and a validation error per element — 5,664 bad lines and
  // 56 "Input must be an object" for one ordinary `--format json` export —
  // without once naming the cause, which is simply that `--format jsonl` was
  // pointed at a `--format json` file. Every line of a pretty-printed array is
  // a fragment, so the report describes the symptom thousands of times over.
  // A JSONL record is an object, so a file whose first meaningful line opens a
  // bracket is an array, not JSONL. Say so, the way the golden-dataset guard
  // above does, instead of burying it.
  const firstMeaningful = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('//'));
  if (firstMeaningful?.startsWith('[')) {
    throw new Error(
      'file is a JSON array, but --format jsonl was given. Drop --format to auto-detect, or pass --format json.',
    );
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
