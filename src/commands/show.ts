import { resolve } from 'node:path';
import chalk from 'chalk';
import type Database from 'better-sqlite3';
import type { TraceWithDetails } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { getTrace, getStepSnapshot } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceHeaderPanel } from '../ui/boxen-panels.js';
import { renderTimeline } from '../ui/timeline.js';
import { evalTable } from '../ui/table.js';
import { heading, separator } from '../ui/theme.js';

export interface ShowOptions {
  json?: boolean;
  stepsOnly?: boolean;
  evals?: boolean;
  snapshots?: boolean;
  dir?: string;
}

/**
 * `agent-replay show <trace-id>` — detailed view of a single trace
 * with header panel, step timeline, evaluations, and optional snapshots.
 */
export function runShow(traceId: string, opts: ShowOptions = {}): void {
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    console.error(chalk.dim('  Use "agent-replay list" to see available traces.'));
    return;
  }

  // Raw JSON output
  if (opts.json) {
    console.log(JSON.stringify(trace, null, 2));
    return;
  }

  // Steps-only mode
  if (opts.stepsOnly) {
    console.log('');
    console.log(heading('  Steps'));
    console.log('');
    console.log(renderTimeline(trace.steps));
    console.log('');
    return;
  }

  // Full view
  console.log('');
  console.log(traceHeaderPanel(trace));
  console.log('');

  // Timeline
  console.log(heading('  Steps'));
  console.log('');
  console.log(renderTimeline(trace.steps));
  console.log('');

  // Evaluations
  if (opts.evals || trace.evals.length > 0) {
    console.log(separator());
    console.log('');
    console.log(heading('  Evaluations'));
    console.log('');
    console.log(evalTable(trace.evals));
    console.log('');
  }

  // Snapshots
  if (opts.snapshots) {
    console.log(separator());
    console.log('');
    console.log(heading('  Snapshots'));
    console.log('');
    renderSnapshots(db, trace);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function renderSnapshots(db: Database.Database, trace: TraceWithDetails): void {
  for (const step of trace.steps) {
    const snapshot = getStepSnapshot(db, trace.id, step.step_number);
    if (!snapshot) continue;

    console.log(
      chalk.dim(`  Step ${step.step_number}`) +
        chalk.white(` "${step.name}"`) +
        chalk.dim(` — token_count: ${snapshot.token_count}`),
    );

    if (snapshot.context_window) {
      const ctx = typeof snapshot.context_window === 'string'
        ? snapshot.context_window
        : JSON.stringify(snapshot.context_window, null, 2);
      console.log(chalk.dim('    context_window: ') + chalk.dim(truncate(ctx, 200)));
    }

    if (snapshot.environment && Object.keys(snapshot.environment).length > 0) {
      console.log(
        chalk.dim('    environment: ') +
          chalk.dim(truncate(JSON.stringify(snapshot.environment), 200)),
      );
    }

    if (snapshot.tool_state && Object.keys(snapshot.tool_state).length > 0) {
      console.log(
        chalk.dim('    tool_state: ') +
          chalk.dim(truncate(JSON.stringify(snapshot.tool_state), 200)),
      );
    }

    console.log('');
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
