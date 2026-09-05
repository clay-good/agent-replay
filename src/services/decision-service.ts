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
 * List every decision point in a trace, in step order. A decision point is a
 * `decision`-type step OR any step that carries a decision record: the live
 * recorder (`attachDecision`) and the SDK's inline `step({ decision })` can
 * attach a record to a step of any type, and the causal walk (`why`) surfaces
 * those records regardless of step type — so listing only `decision`-type steps
 * here made `decisions` omit a record that `why` shows on the same trace.
 */
export function listDecisions(
  db: Database.Database,
  traceId: string,
): { trace: TraceWithDetails; decisions: DecisionPoint[] } | null {
  const trace = getTrace(db, traceId);
  if (!trace) return null;

  const decisions: DecisionPoint[] = trace.steps
    .filter((s) => s.step_type === 'decision' || s.decision != null)
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
  const prevDecision = nearestEarlierDecisions(trace.steps);

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

    const next = resolveAntecedent(current, byNumber, prevDecision);
    if (!next) break;
    current = next.step;
    link = next.link;
  }

  return { trace, chain };
}

/**
 * For each step number, the nearest decision point strictly before it.
 *
 * Built once, in one ascending pass, because the walk below needs it once per
 * HOP. Scanning every step to find it each time made `why` cost O(steps x hops)
 * — fine while a producer sets `caused_by`, since the walk then never reaches
 * the fallback, and quadratic the moment one does not. On a trace whose steps
 * all carry decisions and no causal links (the shape a hook-captured session
 * with `attachDecision` produces), the walk visits every step and rescanned
 * every step at each one: 1,000 steps took 0.02s, 10,000 took 1.07s — 10x the
 * data for 50x the work, on a command whose whole job is explaining a step.
 *
 * A decision point is a `decision`-type step OR any step carrying a decision
 * record — the live recorder attaches records to steps of any type — mirroring
 * listDecisions, so the walk doesn't skip past a real decision on a tool step.
 */
function nearestEarlierDecisions(steps: TraceStep[]): Map<number, TraceStep> {
  const ascending = [...steps].sort((a, b) => a.step_number - b.step_number);
  const nearest = new Map<number, TraceStep>();
  let last: TraceStep | null = null;
  for (const s of ascending) {
    if (last) nearest.set(s.step_number, last);
    if (s.step_type === 'decision' || s.decision != null) last = s;
  }
  return nearest;
}

/** Resolve the single antecedent of a step per the causal-walk rules. */
function resolveAntecedent(
  step: TraceStep,
  byNumber: Map<number, TraceStep>,
  prevDecision: Map<number, TraceStep>,
): { step: TraceStep; link: CausalLink } | null {
  if (step.caused_by_step_number != null) {
    const s = byNumber.get(step.caused_by_step_number);
    if (s) return { step: s, link: 'caused_by' };
  }
  if (step.parent_step_number != null) {
    const s = byNumber.get(step.parent_step_number);
    if (s) return { step: s, link: 'parent' };
  }
  // Fallback: the nearest earlier decision point, precomputed above.
  const best = prevDecision.get(step.step_number) ?? null;
  return best ? { step: best, link: 'prior_decision' } : null;
}
