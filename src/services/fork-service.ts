import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { ForkResult } from '../models/types.js';

function generateId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

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
         started_at, tags, metadata, parent_trace_id, forked_from_step, created_at)
       VALUES (?, ?, ?, 'manual', 'running', ?, ?, ?, ?, ?, ?, ?)`,
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
           started_at, ended_at, duration_ms, tokens_used, model, error, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );

      // Copy snapshot if one exists for this step
      const snapshot = db
        .prepare('SELECT * FROM agent_trace_snapshots WHERE step_id = ?')
        .get(oldStepId) as Record<string, unknown> | undefined;

      if (snapshot) {
        const newSnapId = generateId('snp');
        // Apply modified context to the environment field if provided
        const environment =
          modifiedContext
            ? JSON.stringify(modifiedContext)
            : (snapshot.environment as string);

        db.prepare(
          `INSERT INTO agent_trace_snapshots
            (id, step_id, context_window, environment, tool_state, token_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          newSnapId,
          newStepId,
          snapshot.context_window,
          environment,
          snapshot.tool_state,
          snapshot.token_count,
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
