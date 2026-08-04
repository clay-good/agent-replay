import type Database from 'better-sqlite3';
import type { ForkResult } from '../models/types.js';
import { generateId } from '../utils/id.js';

/**
 * Fork a trace at a specific step, creating a new trace that copies steps
 * 1 through fromStep. Optionally modify the input and/or context at the
 * fork point.
 *
 * Adapted from proxilion-managed-main/crates/agent-replay/src/services.rs
 * fork_trace (lines 303-390).
 */
export function forkTrace(
  db: Database.Database,
  traceId: string,
  fromStep: number,
  modifiedInput?: Record<string, unknown>,
  modifiedContext?: Record<string, unknown>,
): ForkResult {
  if (!Number.isFinite(fromStep) || fromStep < 1) {
    throw new Error(`Invalid fromStep: ${fromStep} (must be >= 1)`);
  }

  const fork = db.transaction(() => {
    // Get the original trace
    const original = db
      .prepare('SELECT * FROM agent_traces WHERE id = ?')
      .get(traceId) as Record<string, unknown> | undefined;

    if (!original) {
      throw new Error(`Trace ${traceId} not found`);
    }

    // Verify fromStep doesn't exceed actual steps
    const maxStep = db
      .prepare('SELECT MAX(step_number) as max_step FROM agent_trace_steps WHERE trace_id = ?')
      .get(traceId) as { max_step: number | null };

    if (maxStep.max_step == null) {
      throw new Error(`Trace ${traceId} has no steps to fork`);
    }
    if (fromStep > maxStep.max_step) {
      throw new Error(
        `fromStep ${fromStep} exceeds max step ${maxStep.max_step} in trace ${traceId}`,
      );
    }
    // step_number may have gaps (a valid ingested/merged trace can be numbered
    // [1, 3]), so `fromStep <= maxStep` is not enough — the fork point must be a
    // real step. Otherwise forking [1, 3] at step 2 copies only step 1 and the
    // `applyContext` guard below (`step_number === fromStep`) never fires, so
    // --modify-context is silently dropped at a fork point that doesn't exist.
    const forkPointExists = db
      .prepare('SELECT 1 FROM agent_trace_steps WHERE trace_id = ? AND step_number = ?')
      .get(traceId, fromStep);
    if (!forkPointExists) {
      throw new Error(`Trace ${traceId} has no step ${fromStep} to fork at`);
    }

    // Create the forked trace
    const forkedId = generateId('trc');
    const now = new Date().toISOString();
    const input = modifiedInput
      ? JSON.stringify(modifiedInput)
      : (original.input as string);

    const metadata = JSON.stringify({
      forked_from: traceId,
      forked_at_step: fromStep,
    });

    db.prepare(
      `INSERT INTO agent_traces
        (id, agent_name, agent_version, trigger, status, input,
         started_at, tags, metadata, parent_trace_id, forked_from_step, session_id, created_at)
       VALUES (?, ?, ?, 'manual', 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      forkedId,
      original.agent_name,
      original.agent_version,
      input,
      now,
      original.tags,
      metadata,
      traceId,
      fromStep,
      original.session_id ?? null,
      now,
    );

    // Get original steps up to fromStep
    const originalSteps = db
      .prepare(
        `SELECT * FROM agent_trace_steps
         WHERE trace_id = ? AND step_number <= ?
         ORDER BY step_number`,
      )
      .all(traceId, fromStep) as Record<string, unknown>[];

    // Copy each step with new IDs
    for (const step of originalSteps) {
      const newStepId = generateId('stp');
      const oldStepId = step.id as string;

      db.prepare(
        `INSERT INTO agent_trace_steps
          (id, trace_id, step_number, step_type, name, input, output,
           started_at, ended_at, duration_ms, tokens_used, model, error, metadata,
           parent_step_number, caused_by_step_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newStepId,
        forkedId,
        step.step_number,
        step.step_type,
        step.name,
        step.input,
        step.output,
        step.started_at,
        step.ended_at,
        step.duration_ms,
        step.tokens_used,
        step.model,
        step.error,
        step.metadata,
        step.parent_step_number ?? null,
        step.caused_by_step_number ?? null,
      );

      // Copy the decision record for this step, if any (step numbers are
      // preserved across the fork, so causal/parent references stay valid).
      const decision = db
        .prepare('SELECT * FROM agent_trace_decisions WHERE step_id = ?')
        .get(oldStepId) as Record<string, unknown> | undefined;

      if (decision) {
        db.prepare(
          `INSERT INTO agent_trace_decisions
            (id, step_id, options, chosen, rationale, confidence, decided_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          generateId('dec'),
          newStepId,
          decision.options,
          decision.chosen,
          decision.rationale,
          decision.confidence,
          decision.decided_by,
        );
      }

      // Copy the step's snapshot if it has one, and apply --modify-context at
      // the fork point. Snapshots are optional, so the fork-point step often
      // has none — in that case still create a snapshot to hold the modified
      // context, otherwise the modification is silently dropped (the whole
      // point of --modify-context is to change the fork-point context). The
      // modified context lands in `context_window`, the field the flag names
      // and that `show --snapshots` renders.
      const snapshot = db
        .prepare('SELECT * FROM agent_trace_snapshots WHERE step_id = ?')
        .get(oldStepId) as Record<string, unknown> | undefined;
      const applyContext = modifiedContext != null && (step.step_number as number) === fromStep;

      if (snapshot || applyContext) {
        const newSnapId = generateId('snp');
        db.prepare(
          `INSERT INTO agent_trace_snapshots
            (id, step_id, context_window, environment, tool_state, token_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          newSnapId,
          newStepId,
          // The columns are NOT NULL with these defaults; a fresh fork-point
          // snapshot (no original to copy) uses them, keeping only the modified
          // context window.
          applyContext ? JSON.stringify(modifiedContext) : (snapshot?.context_window ?? '[]'),
          snapshot?.environment ?? '{}',
          snapshot?.tool_state ?? '{}',
          snapshot?.token_count ?? 0,
        );
      }
    }

    return {
      original_trace_id: traceId,
      forked_trace_id: forkedId,
      forked_from_step: fromStep,
      steps_copied: originalSteps.length,
    } satisfies ForkResult;
  });

  return fork();
}
