import type Database from 'better-sqlite3';
import type {
  Trace,
  TraceStep,
  TraceSnapshot,
  EvalResult,
  ListTracesFilter,
} from '../models/types.js';
import { listTraces, getTrace } from './trace-service.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type ExportFormat = 'json' | 'jsonl' | 'golden';

export interface ExportOptions {
  withEvals?: boolean;
  withSnapshots?: boolean;
}

export interface GoldenEntry {
  id: string;
  agent_name: string;
  input: Record<string, unknown>;
  expected_output: Record<string, unknown> | null;
  steps_summary: Array<{ step_number: number; step_type: string; name: string }>;
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
  // Fetch all matching traces (remove limit for export)
  const exportFilter = { ...filter, limit: 10000, offset: 0 };
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
      })),
      eval_criteria: evals.map((e) => ({
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

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
