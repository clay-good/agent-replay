import { resolve } from 'node:path';
import chalk from 'chalk';
import type Database from 'better-sqlite3';
import type { TraceWithDetails, TraceSnapshot } from '../models/types.js';
import type { StepType } from '../models/enums.js';
import { getTrace, getStepSnapshot, isPossiblyAbandoned } from '../services/trace-service.js';
import { ensureDatabase } from '../db/index.js';
import { traceHeaderPanel } from '../ui/boxen-panels.js';
import { truncate } from '../utils/json.js';
import { effectiveDurationMs } from '../utils/time.js';
import { effectiveTokens } from '../utils/totals.js';
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
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath, opts.dir);
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
    // `--steps-only` and `--tree` shape the HUMAN view only — the JSON document
    // is the whole trace, in document order, either way — so passing them with
    // `--json` got a payload identical to one without them, silently. Unlike
    // `--evals` and `--snapshots`, which name DATA the payload can carry (and
    // now does), there is nothing a JSON document could do to honour these two,
    // so the honest answer is to say the flag did nothing rather than let the
    // caller believe the output was narrowed or re-ordered on their behalf.
    // On stderr, so a `--json` stdout stays a clean document.
    const inertFlags = [opts.stepsOnly && '--steps-only', opts.tree && '--tree'].filter(Boolean) as string[];
    if (inertFlags.length > 0) {
      const inert = inertFlags.join(' and ');
      console.error(chalk.yellow(`  ⚠ ${inert} ${inertFlags.length === 1 ? 'has' : 'have'} no effect with --json.`));
      console.error(chalk.dim('    --json prints the whole trace; `steps` carries parent_step_number and caused_by_step_number to rebuild the tree.'));
    }
    // The two numbers the human panel prints and the document did not carry.
    //
    // `show` renders Duration and Tokens through `effectiveDurationMs` /
    // `effectiveTokens`, which fall back to the trace's own timestamps and to
    // the steps' `tokens_used` when the trace-level columns were never set —
    // and those columns are set only when a producer reports a total, so a
    // hook-captured or ingested trace shows "30.0s / 700" on screen while
    // `show --json` answered `total_duration_ms: null, total_tokens: null`.
    // There was no machine-readable way to read the number the tool itself was
    // displaying. `list --json` had already solved half of this by carrying
    // `effective_tokens`; duration was the twin left behind, on both commands.
    //
    // Computed with the SAME helpers the panel uses, so the document and the
    // rendering cannot disagree. Additive: the stored columns are passed
    // through exactly as written, so `show --json | ingest` still restores the
    // trace unchanged (`ingest` reads `total_*` and ignores unknown keys).
    const derived = {
      effective_duration_ms: effectiveDurationMs(trace),
      effective_tokens: effectiveTokens(trace as Parameters<typeof effectiveTokens>[0]),
      // The `⚠ abandoned?` marker `list` and the header panel show, as a value a
      // script can read. Derived from status + started_at + now, exactly like
      // the two above, and for the same reason: a number (or a warning) the
      // human view prints and the payload cannot report is a gap for anyone
      // automating against it.
      possibly_abandoned: isPossiblyAbandoned(trace),
    };
    const base = omitted > 0
      ? { ...trace, ...derived, steps: windowed, step_window: { from: fromStep ?? null, to: toStep ?? null, shown: windowed.length, omitted } }
      : { ...trace, ...derived };
    // `--snapshots` reached the human path only, so `show --json --snapshots`
    // answered with a document that had no snapshot data at all: exit 0, no
    // warning, and nothing to read — while the very same trace printed
    // snapshots without `--json`. That left NO machine-readable way to get a
    // snapshot out of this tool, though `evals` (the sibling section right
    // above it) has always been in the payload. It is the defect
    // `diff --ai --json` already had and already fixed, in the same shape: a
    // flag whose data the JSON path could carry, dropped by an early return.
    //
    // Attached PER STEP as `snapshot`, which is `export --with-snapshots`'s
    // shape and the one `ingest` reads — not a top-level array, which is what
    // this first shipped as and which does not round-trip: `show --json
    // --snapshots | ingest` reported "Ingested 1 trace(s) successfully" and
    // silently kept none of them, since ingest looks for `steps[].snapshot`.
    // A success message for data that was dropped is the exact failure this
    // tool exists to catch. `null` on a step with no snapshot, as export
    // writes it, so the key's absence is never ambiguous.
    //
    // Keyed off the flag rather than emitted always, exactly as `ai_analysis`
    // is, so a `show --json` without it stays byte-for-byte unchanged. Built
    // from `windowed`, so the window applies here as it does on the human path.
    const payload = opts.snapshots
      ? { ...base, steps: attachSnapshots(db, trace.id, windowed) }
      : base;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  /** Steps beyond which an unwindowed `show` says how to window it. */
  const LARGE_TRACE_STEPS = 200;

  const windowNote = () => {
    if (omitted > 0) {
      console.log(chalk.dim(`  Showing ${windowed.length} of ${windowed.length + omitted} steps (${omitted} outside the --from-step/--to-step window).`));
      console.log('');
      return;
    }
    // Nothing was omitted — but on a REAL trace that can mean thousands of
    // steps about to be printed. A 20,000-step trace filled 80,013 lines with
    // no hint that the windowing flags exist; imported sessions reach 3,000
    // steps routinely and a 647 MB transcript imports 672,000. The flags are in
    // `--help` and the README, which is no use to someone whose terminal is
    // already scrolling. Say it BEFORE the timeline, and only when the size
    // warrants it, so an ordinary trace prints nothing extra.
    if (windowed.length > LARGE_TRACE_STEPS) {
      console.log(
        chalk.dim(`  ${windowed.length.toLocaleString()} steps — window a large trace with --from-step/--to-step.`),
      );
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
  // An empty window is not an empty trace. Without this the renderer's default
  // ("No steps recorded.") contradicted the line printed just above it, which
  // correctly said how many steps the window had excluded.
  const timelineOpts = windowed.length === 0 && trace.steps.length > 0
    ? { emptyMessage: `No steps in this window — the trace has ${trace.steps.length.toLocaleString()}. Widen or drop --from-step/--to-step.` }
    : {};
  const renderSteps = () => (opts.tree ? renderTree(windowed, timelineOpts) : renderTimeline(windowed, timelineOpts));

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

/**
 * The snapshots for `steps`, skipping any step that has none, tagged with the
 * `step_number` they belong to — the snapshot row itself carries only a
 * `step_id`, and every other step reference in the payload is by number.
 * Shared by the JSON and human paths so the two cannot drift on which steps
 * they cover or which they silently skip.
 */
function collectSnapshots(
  db: Database.Database,
  traceId: string,
  steps: TraceWithDetails['steps'],
): Array<{ step_number: number; step_name: string } & TraceSnapshot> {
  const out: Array<{ step_number: number; step_name: string } & TraceSnapshot> = [];
  for (const step of steps) {
    const snapshot = getStepSnapshot(db, traceId, step.step_number);
    if (!snapshot) continue;
    out.push({ step_number: step.step_number, step_name: step.name, ...snapshot });
  }
  return out;
}

/**
 * `windowed` with each step's snapshot attached as `snapshot`, mirroring
 * `export --with-snapshots` field for field — the shape `ingest` reads, so a
 * `show --json --snapshots` document re-ingests with its snapshots intact.
 * `null` where a step has none, as export writes it.
 */
function attachSnapshots(
  db: Database.Database,
  traceId: string,
  steps: TraceWithDetails['steps'],
): Array<Record<string, unknown>> {
  return steps.map((step) => {
    const snap = getStepSnapshot(db, traceId, step.step_number);
    return {
      ...step,
      snapshot: snap
        ? {
            context_window: snap.context_window,
            environment: snap.environment,
            tool_state: snap.tool_state,
            token_count: snap.token_count,
          }
        : null,
    };
  });
}

function renderSnapshots(
  db: Database.Database,
  traceId: string,
  steps: TraceWithDetails['steps'],
): void {
  for (const snapshot of collectSnapshots(db, traceId, steps)) {
    const step = { step_number: snapshot.step_number, name: snapshot.step_name };

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

