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

function exportGolden(db: Database.Database, items: Trace[]): string {
  const entries: GoldenEntry[] = items.map((trace) => {
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
      })),
      // A skipped evaluator is stored with score 1.0 so it can't fail a gate,
      // but it measured nothing — baking that into a baseline asserts a result
      // no evaluator ever produced.
      eval_criteria: evals.filter((e) => (e.details as { skipped?: unknown } | null)?.skipped !== true).map((e) => ({
        evaluator_name: e.evaluator_name,
        score: e.score,
        passed: e.passed,
      })),
      metadata: {
        ...trace.metadata,
        status: trace.status,
        total_duration_ms: trace.total_duration_ms,
        total_tokens: trace.total_tokens,
        tags: trace.tags,
      },
    };
  });

  return JSON.stringify(entries, null, 2) + '\n';
}
