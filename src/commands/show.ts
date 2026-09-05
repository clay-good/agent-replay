import { resolve } from 'node:path';
import chalk from 'chalk';
import type Database from 'better-sqlite3';
import type { TraceWithDetails } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { getTrace, getStepSnapshot } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceHeaderPanel } from '../ui/boxen-panels.js';
import { truncate } from '../utils/json.js';
import { renderTimeline, renderTree } from '../ui/timeline.js';
import { evalTable } from '../ui/table.js';
import { heading, separator, safeText, safeLine } from '../ui/theme.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse, openStoreOr } from '../utils/refuse.js';
import { errorMessage } from '../utils/json.js';

export interface ShowOptions {
  json?: boolean;
  stepsOnly?: boolean;
  tree?: boolean;
  evals?: boolean;
  snapshots?: boolean;
  fromStep?: string;
  toStep?: string;
  dir?: string;
}

/**
 * `agent-replay show <trace-id>` — detailed view of a single trace
 * with header panel, step timeline, evaluations, and optional snapshots.
 */
export function runShow(traceId: string, opts: ShowOptions = {}): void {
  const refuse = makeRefuse(opts.json);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath);
  if (!db) return;

  // An ambiguous prefix is a usage error answered in the requested shape — it
  // must not escape as a bare stack line, which would break the --json contract
  // and report exit 1 (a runtime failure) for what the caller can simply retype.
  let trace;
  try {
    trace = getTrace(db, traceId);
  } catch (err) {
    refuse(2, errorMessage(err));
    return;
  }
  if (!trace) {
    refuse(1, `Trace not found: ${traceId}`, ['Use "agent-replay list" to see available traces.']);
    return;
  }

  // Optional step window (--from-step/--to-step), so large traces — real
  // sessions can run to thousands of steps — stay inspectable. Matches replay.
  // Validate the bounds so a typo (non-numeric, or an inverted range) is a
  // clear usage error rather than silently falling back to "no steps in window".
  // Parse with Number, not parseInt: `--to-step 1e2` must mean 100 (or be a
  // usage error), not a silently-truncated 1, and `2.9`/`3abc` must not slip
  // through as 2/3 — the same validate/consume divergence `list --limit` and
  // `config set` already guard against. A non-integer or < 1 is a usage error.
  let fromStep: number | undefined;
  if (opts.fromStep != null) {
    const n = Number(opts.fromStep);
    if (!Number.isInteger(n) || n < 1) {
      refuse(2, `Invalid --from-step: ${opts.fromStep} (must be a positive integer).`);
      return;
    }
    fromStep = n;
  }
  let toStep: number | undefined;
  if (opts.toStep != null) {
    const n = Number(opts.toStep);
    if (!Number.isInteger(n) || n < 1) {
      refuse(2, `Invalid --to-step: ${opts.toStep} (must be a positive integer).`);
      return;
    }
    toStep = n;
  }
  if (fromStep != null && toStep != null && fromStep > toStep) {
    refuse(2, `--from-step (${fromStep}) cannot be greater than --to-step (${toStep}).`);
    return;
  }
  const windowed = fromStep == null && toStep == null
    ? trace.steps
    : trace.steps.filter((s) => (fromStep == null || s.step_number >= fromStep) && (toStep == null || s.step_number <= toStep));
  const omitted = trace.steps.length - windowed.length;

  // Raw JSON output (respects the window). The human path prints what it left
  // out; the JSON path said nothing, so a consumer received a complete-looking
  // trace — trace-level totals intact, evals unwindowed — whose `steps` was
  // silently a subset, indistinguishable from a trace that really has that many
  // steps. Additive: an unwindowed `show --json` is byte-for-byte unchanged.
  if (opts.json) {
    const payload = omitted > 0
      ? { ...trace, steps: windowed, step_window: { from: fromStep ?? null, to: toStep ?? null, shown: windowed.length, omitted } }
      : trace;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const windowNote = () => {
    if (omitted > 0) {
      console.log(chalk.dim(`  Showing ${windowed.length} of ${windowed.length + omitted} steps (${omitted} outside the --from-step/--to-step window).`));
      console.log('');
    }
  };
  // Render from `windowed`, never by narrowing `trace.steps` itself: the header
  // panel's Tokens line falls back to summing the steps when the trace-level
  // column is null (every hook/record/OTel/imported trace), so a narrowed
  // `trace.steps` made `show --from-step` print a WINDOW SUBTOTAL on the
  // trace-level `Tokens:` line — beside a trace-level `Duration:`, and differing
  // from what `list`/`stats` report for the same trace. `replay` already keeps
  // the two separate.
  const renderSteps = () => (opts.tree ? renderTree(windowed) : renderTimeline(windowed));

  // Steps-only mode
  if (opts.stepsOnly) {
    // `--steps-only` returns before the evaluations and snapshots sections, so
    // asking for either alongside it gets you neither — silently, and the
    // output looks exactly like a trace that has none. Same inert-flag idiom
    // the export path already uses for `--with-evals --format golden`: say the
    // flag did nothing rather than let the reader infer an absence from it.
    // On stderr, so `show --steps-only` stays pipeable.
    const ignoredFlags = [opts.evals && '--evals', opts.snapshots && '--snapshots'].filter(Boolean) as string[];
    if (ignoredFlags.length > 0) {
      const ignored = ignoredFlags.join(' and ');
      console.error(chalk.yellow(`  ⚠ ${ignored} ${ignoredFlags.length === 1 ? 'has' : 'have'} no effect with --steps-only.`));
      console.error(chalk.dim('    --steps-only prints the step timeline alone; drop it to see those sections.'));
    }
    console.log('');
    console.log(heading('  Steps'));
    console.log('');
    windowNote();
    console.log(renderSteps());
    console.log('');
    return;
  }

  // Full view
  console.log('');
  console.log(traceHeaderPanel(trace));
  console.log('');

  // Timeline
  console.log(heading(opts.tree ? '  Step tree' : '  Steps'));
  console.log('');
  windowNote();
  console.log(renderSteps());
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
    renderSnapshots(db, trace.id, windowed);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function renderSnapshots(
  db: Database.Database,
  traceId: string,
  steps: TraceWithDetails['steps'],
): void {
  for (const step of steps) {
    const snapshot = getStepSnapshot(db, traceId, step.step_number);
    if (!snapshot) continue;

    console.log(
      chalk.dim(`  Step ${step.step_number}`) +
        chalk.white(` "${safeLine(truncate(step.name, 80))}"`) +
        chalk.dim(` — token_count: ${snapshot.token_count}`),
    );

    if (snapshot.context_window) {
      const ctx = typeof snapshot.context_window === 'string'
        ? snapshot.context_window
        : JSON.stringify(snapshot.context_window, null, 2);
      console.log(chalk.dim('    context_window: ') + chalk.dim(safeText(truncate(ctx, 200))));
    }

    if (snapshot.environment && Object.keys(snapshot.environment).length > 0) {
      console.log(
        chalk.dim('    environment: ') +
          // Escaped like the context_window above it. Snapshot KEYS are
          // producer-controlled here too, not just values.
          chalk.dim(safeText(truncate(JSON.stringify(snapshot.environment), 200))),
      );
    }

    if (snapshot.tool_state && Object.keys(snapshot.tool_state).length > 0) {
      console.log(
        chalk.dim('    tool_state: ') +
          chalk.dim(safeText(truncate(JSON.stringify(snapshot.tool_state), 200))),
      );
    }

    console.log('');
  }
}

