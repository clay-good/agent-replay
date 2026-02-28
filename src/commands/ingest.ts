import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type Database from 'better-sqlite3';
import type { IngestTraceInput } from '../models/types.js';
import { TRACE_STATUSES, STEP_TYPES, TRIGGER_TYPES } from '../models/enums.js';
import { ingestTrace } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { summaryPanel } from '../ui/boxen-panels.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';

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
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const spinner = startSpinner(`Reading ${absPath}...`);

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (err) {
    failSpinner(spinner, `Failed to read file: ${absPath}`);
    console.error(chalk.red(errorMessage(err)));
    return;
  }

  // Auto-detect format
  const format = opts.format ?? detectFormat(raw, absPath);
  spinner.text = `Parsing as ${format.toUpperCase()}...`;

  // Parse traces
  let traces: unknown[];
  try {
    traces = parseTraces(raw, format);
  } catch (err) {
    failSpinner(spinner, `Parse error: ${errorMessage(err)}`);
    return;
  }

  if (traces.length === 0) {
    failSpinner(spinner, 'No traces found in file.');
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
    if (valid.length === 0) return;
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

  if (failedIds.length > 0) {
    successSpinner(
      spinner,
      `Ingested ${inserted}/${valid.length} traces (${failedIds.length} failed).`,
    );
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

function detectFormat(raw: string, path: string): 'json' | 'jsonl' {
  if (path.endsWith('.jsonl') || path.endsWith('.ndjson')) return 'jsonl';
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[')) return 'json';
  return 'jsonl';
}

function parseTraces(raw: string, format: 'json' | 'jsonl'): unknown[] {
  if (format === 'json') {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  // JSONL: one JSON object per line
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON on line ${i + 1}`);
      }
    });
}

function validateTrace(t: Record<string, unknown>, index: number): string[] {
  const errors: string[] = [];
  const prefix = `Trace[${index}]`;

  if (!t.agent_name || typeof t.agent_name !== 'string') {
    errors.push(`${prefix}: missing or invalid 'agent_name' (string required)`);
  }

  if (t.status && !TRACE_STATUSES.includes(t.status as typeof TRACE_STATUSES[number])) {
    errors.push(`${prefix}: invalid status '${t.status}'`);
  }

  if (t.trigger && !TRIGGER_TYPES.includes(t.trigger as typeof TRIGGER_TYPES[number])) {
    errors.push(`${prefix}: invalid trigger '${t.trigger}'`);
  }

  if (t.steps != null) {
    if (!Array.isArray(t.steps)) {
      errors.push(`${prefix}: 'steps' must be an array`);
    } else {
      for (let j = 0; j < t.steps.length; j++) {
        const s = t.steps[j] as Record<string, unknown>;
        if (!s.step_type || !STEP_TYPES.includes(s.step_type as typeof STEP_TYPES[number])) {
          errors.push(`${prefix}.steps[${j}]: invalid step_type '${s.step_type}'`);
        }
        if (!s.name || typeof s.name !== 'string') {
          errors.push(`${prefix}.steps[${j}]: missing or invalid 'name'`);
        }
        if (s.step_number == null || typeof s.step_number !== 'number') {
          errors.push(`${prefix}.steps[${j}]: missing or invalid 'step_number'`);
        }
      }
    }
  }

  return errors;
}
