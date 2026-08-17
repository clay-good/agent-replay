import type Database from 'better-sqlite3';
import type {
  Trace,
  TraceStep,
  TraceSnapshot,
  EvalResult,
  ListTracesFilter,
} from '../models/types.js';
import { listTraces, getTrace } from './trace-service.js';
import { safeParseJson } from '../utils/json.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type ExportFormat = 'json' | 'jsonl' | 'golden';

export interface ExportOptions {
  withEvals?: boolean;
  withSnapshots?: boolean;
}

export interface GoldenStepSummary {
  step_number: number;
  step_type: string;
  name: string;
  /** Present for tool_call steps so regression checks can diff tool inputs. */
  input?: Record<string, unknown>;
  /** Present when the step recorded a model, so checks can opt into diffing it. */
  model?: string | null;
  /**
   * Whether this step recorded an error; written for every step of a baseline
   * exported by this version, so an ABSENT key means the baseline predates the
   * field and that step's outcome is unknown.
   *
   * A baseline could not carry step failure
   * at all, so the gate was structurally blind to the regression class it most
   * needs to catch: identical step shape where every tool call now FAILS. The
   * trace status does not cover it — a hook-captured session finalizes
   * `completed` from its Stop event however many tool calls failed inside it.
   *
   * Only the flag is stored, never the message: error text carries model output,
   * paths and ids that differ run to run, and a gate that fails on wording is
   * the false-positive problem this format exists to avoid.
   */
  failed?: boolean;
}

export interface GoldenEntry {
  id: string;
  agent_name: string;
  input: Record<string, unknown>;
  expected_output: Record<string, unknown> | null;
  steps_summary: GoldenStepSummary[];
  eval_criteria: Array<{ evaluator_name: string; score: number; passed: boolean }>;
  metadata: Record<string, unknown>;
}

// ── Export ─────────────────────────────────────────────────────────────────

/**
 * Export traces matching the filter in the given format.
 * Returns the formatted string.
 */
export function exportTraces(
  db: Database.Database,
  filter: ListTracesFilter,
  format: ExportFormat,
  options: ExportOptions = {},
): string {
  // Fetch every matching trace — export must not silently drop rows. A fixed
  // cap (previously 10000) truncated large exports with no warning, which
  // corrupts a golden/JSONL dataset built from them. `listTraces` always emits
  // `LIMIT ? OFFSET ?`; SQLite treats a negative LIMIT as unbounded, so -1
  // returns all matches (OFFSET 0 keeps them all) without a special-case path.
  const exportFilter = { ...filter, limit: -1, offset: 0 };
  const { items } = listTraces(db, exportFilter);

  if (format === 'golden') {
    return exportGolden(db, items);
  }

  // Build full trace objects
  const traces = items.map((trace) => {
    const full = getTrace(db, trace.id);
    if (!full) return null;

    const obj: Record<string, unknown> = { ...full };

    if (!options.withEvals) {
      delete obj.evals;
    }

    if (options.withSnapshots) {
      // Attach snapshots to each step
      const stepsWithSnaps = full.steps.map((step) => {
        const snap = db
          .prepare('SELECT * FROM agent_trace_snapshots WHERE step_id = ?')
          .get(step.id) as Record<string, unknown> | undefined;
        return {
          ...step,
          snapshot: snap
            ? {
                context_window: safeParseJson(snap.context_window as string),
                environment: safeParseJson(snap.environment as string),
                tool_state: safeParseJson(snap.tool_state as string),
                token_count: snap.token_count,
              }
            : null,
        };
      });
      obj.steps = stepsWithSnaps;
    }

    return obj;
  }).filter(Boolean);

  if (format === 'jsonl') {
    // A zero-match export must be an EMPTY file, not one blank line. `[].join()`
    // is '', so the unconditional trailing newline made the output exactly "\n":
    // a strict streaming consumer doing `line => JSON.parse(line)` threw
    // "Unexpected end of JSON input" on it, and `wc -l` reported one record. The
    // repo's own test worked around this rather than relying on it.
    if (traces.length === 0) return '';
    return traces.map((t) => JSON.stringify(t)).join('\n') + '\n';
  }

  // json
  return JSON.stringify(traces, null, 2) + '\n';
}

/**
 * A golden entry's metadata: the trace's own keys, plus the four the gate reads.
 *
 * The reserved keys must win — `check` compares `metadata.status`, so letting a
 * trace's own `status` key displace it would be a gate bypass, not just data
 * loss. But they were overwriting silently: a trace recorded with, say,
 * `metadata: { status: 'approved', tags: ['v2'] }` exported with both values
 * replaced and no trace of the originals, so the baseline was a lossy record of
 * the run. Keep the reserved value authoritative and preserve the displaced one
 * under a prefixed key, which nothing reads and every consumer can ignore.
 */
function goldenMetadata(trace: Trace): Record<string, unknown> {
  const reserved = {
    status: trace.status,
    total_duration_ms: trace.total_duration_ms,
    total_tokens: trace.total_tokens,
    tags: trace.tags,
  };
  const shadowed: Record<string, unknown> = {};
  for (const key of Object.keys(reserved)) {
    if (Object.hasOwn(trace.metadata, key)) shadowed[`trace_metadata_${key}`] = trace.metadata[key];
  }
  return { ...trace.metadata, ...shadowed, ...reserved };
}

function exportGolden(db: Database.Database, items: Trace[]): string {
  // A golden dataset is a set of known-good RUNS. A fork is a never-executed
  // copy — `fork` duplicates a step prefix and leaves it `running` — so baking
  // one in gives `check` a shorter shape to match: a real run that crashed part
  // way then reproduces the fork and the gate certifies it green. Excluded here
  // only; a json/jsonl export is a backup and must still carry the forks.
  const entries: GoldenEntry[] = items.filter((t) => t.parent_trace_id == null).map((trace) => {
    const full = getTrace(db, trace.id);
    const evals = full?.evals ?? [];

    return {
      id: trace.id,
      agent_name: trace.agent_name,
      input: trace.input,
      expected_output: trace.output,
      steps_summary: (full?.steps ?? []).map((s) => ({
        step_number: s.step_number,
        step_type: s.step_type,
        name: s.name,
        ...(s.step_type === 'tool_call' ? { input: s.input } : {}),
        ...(s.model != null ? { model: s.model } : {}),
        // Written for every step, true or false. Emitting it only for failures
        // made "no key" ambiguous between "this step succeeded" and "this
        // baseline predates the field", and the check then skipped the entry —
        // silently disabling the comparison for exactly the clean baselines it
        // exists to protect.
        failed: s.error != null,
      })),
      // A skipped evaluator is stored with score 1.0 so it can't fail a gate,
      // but it measured nothing — baking that into a baseline asserts a result
      // no evaluator ever produced.
      eval_criteria: evals.filter((e) => (e.details as { skipped?: unknown } | null)?.skipped !== true).map((e) => ({
        evaluator_name: e.evaluator_name,
        score: e.score,
        passed: e.passed,
      })),
      metadata: goldenMetadata(trace),
    };
  });

  return JSON.stringify(entries, null, 2) + '\n';
}
