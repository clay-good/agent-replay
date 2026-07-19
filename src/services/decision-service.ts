import type Database from 'better-sqlite3';
import type { TraceStep, DecisionRecord, TraceWithDetails } from '../models/types.js';
import { getTrace } from './trace-service.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** A decision step paired with its record (record may be absent). */
export interface DecisionPoint {
  step: TraceStep;
  decision: DecisionRecord | null;
}

/** How the walk arrived at a step from its successor. */
export type CausalLink = 'origin' | 'caused_by' | 'parent' | 'prior_decision';

/** One hop in a causal chain, ordered from the queried step back to the root. */
export interface CausalHop {
  step: TraceStep;
  link: CausalLink;
  decision: DecisionRecord | null;
}

// ── List decisions ─────────────────────────────────────────────────────────

/**
 * List every decision point in a trace, in step order. Returns `decision`
 * steps together with their structured record (null if the step carries none).
 */
export function listDecisions(
  db: Database.Database,
  traceId: string,
): { trace: TraceWithDetails; decisions: DecisionPoint[] } | null {
  const trace = getTrace(db, traceId);
  if (!trace) return null;

  const decisions: DecisionPoint[] = trace.steps
    .filter((s) => s.step_type === 'decision')
    .map((step) => ({ step, decision: step.decision ?? null }));

  return { trace, decisions };
}

// ── Causal walk ─────────────────────────────────────────────────────────────

/**
 * Walk the causal chain backward from `stepNumber`, following
 * `caused_by_step` when present, then `parent_step`, then falling back to the
 * nearest earlier decision step. Terminates at step 1 or a step with no
 * antecedent. References are validated to point strictly earlier, so the walk
 * is acyclic; a visited-set guard is kept as a defensive backstop.
 */
export function causalWalk(
  db: Database.Database,
  traceId: string,
  stepNumber: number,
): { trace: TraceWithDetails; chain: CausalHop[] } | null {
  const trace = getTrace(db, traceId);
  if (!trace) return null;

  const byNumber = new Map<number, TraceStep>();
  for (const step of trace.steps) byNumber.set(step.step_number, step);

  const start = byNumber.get(stepNumber);
  if (!start) {
    return { trace, chain: [] };
  }

  const chain: CausalHop[] = [];
  const visited = new Set<number>();
  let current: TraceStep | undefined = start;
  let link: CausalLink = 'origin';

  while (current && !visited.has(current.step_number)) {
    visited.add(current.step_number);
    chain.push({ step: current, link, decision: current.decision ?? null });

    const next = resolveAntecedent(current, byNumber);
    if (!next) break;
    current = next.step;
    link = next.link;
  }

  return { trace, chain };
}

/** Resolve the single antecedent of a step per the causal-walk rules. */
function resolveAntecedent(
  step: TraceStep,
  byNumber: Map<number, TraceStep>,
): { step: TraceStep; link: CausalLink } | null {
  if (step.caused_by_step_number != null) {
    const s = byNumber.get(step.caused_by_step_number);
    if (s) return { step: s, link: 'caused_by' };
  }
  if (step.parent_step_number != null) {
    const s = byNumber.get(step.parent_step_number);
    if (s) return { step: s, link: 'parent' };
  }
  // Fallback: nearest earlier decision step
  let best: TraceStep | null = null;
  for (const s of byNumber.values()) {
    if (s.step_type === 'decision' && s.step_number < step.step_number) {
      if (!best || s.step_number > best.step_number) best = s;
    }
  }
  return best ? { step: best, link: 'prior_decision' } : null;
}
