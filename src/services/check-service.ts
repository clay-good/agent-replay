import { createHash } from 'node:crypto';
import type { TraceWithDetails } from '../models/types.js';
import type { GoldenEntry, GoldenStepSummary } from './export-service.js';

/**
 * Golden regression check: compare candidate traces against a golden dataset,
 * matching by agent name + input hash and diffing on a structural field
 * allowlist (step count/types/names, tool-call inputs, final status) rather
 * than raw output text, so non-deterministic wording never trips the check.
 */

// Compared by default. `model` is opt-in via --fields (model swaps are often
// intentional, so it shouldn't fail a default regression check).
export const DEFAULT_FIELDS = ['step_count', 'step_types', 'step_names', 'tool_inputs', 'status'] as const;
export const KNOWN_FIELDS = [...DEFAULT_FIELDS, 'model'] as const;
export type CheckField = (typeof KNOWN_FIELDS)[number];

export interface Divergence {
  field: string;
  step_number?: number;
  golden: unknown;
  candidate: unknown;
}

export interface TraceCheckResult {
  trace_id: string;
  agent_name: string;
  matched: boolean;
  passed: boolean;
  divergences: Divergence[];
}

export interface GoldenCheckReport {
  results: TraceCheckResult[];
  passed: number;
  failed: number;
  unmatched: number;
  /** Overall CI verdict: no failures (and, in strict mode, no unmatched). */
  ok: boolean;
}

/** Deterministic JSON with recursively sorted keys, for stable hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function inputHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16);
}

function goldenKey(agentName: string, input: Record<string, unknown>): string {
  return `${agentName}::${inputHash(input)}`;
}

/**
 * Compare candidate traces against golden entries.
 * @param strict when true, an unmatched candidate counts as a failure.
 */
export function checkGolden(
  golden: GoldenEntry[],
  candidates: TraceWithDetails[],
  opts: { fields?: string[]; strict?: boolean } = {},
): GoldenCheckReport {
  const fields = opts.fields && opts.fields.length ? opts.fields : [...DEFAULT_FIELDS];
  // Reject unknown field names so a typo (or an unsupported field) can't silently
  // compare nothing and report a false pass.
  const unknown = fields.filter((f) => !(KNOWN_FIELDS as readonly string[]).includes(f));
  if (unknown.length > 0) {
    throw new Error(`Unknown --fields value(s): ${unknown.join(', ')}. Known fields: ${KNOWN_FIELDS.join(', ')}`);
  }
  // Bucket golden entries by key: several can share one (repeated runs of the
  // same agent with the same input, or a fork). A plain Map would keep only the
  // last, so the others' candidates would match the wrong entry and falsely
  // "regress".
  const index = new Map<string, GoldenEntry[]>();
  for (const g of golden) {
    const key = goldenKey(g.agent_name, g.input);
    const bucket = index.get(key);
    if (bucket) bucket.push(g);
    else index.set(key, [g]);
  }

  const results: TraceCheckResult[] = [];
  let passed = 0;
  let failed = 0;
  let unmatched = 0;

  for (const trace of candidates) {
    const bucket = index.get(goldenKey(trace.agent_name, trace.input));
    if (!bucket || bucket.length === 0) {
      unmatched++;
      results.push({ trace_id: trace.id, agent_name: trace.agent_name, matched: false, passed: !opts.strict, divergences: [] });
      continue;
    }

    // Pair the candidate with its closest golden entry in the bucket (fewest
    // divergences), then consume it so distinct candidates don't collide.
    let bestIdx = 0;
    let divergences = diffAgainstGolden(trace, bucket[0], fields);
    for (let i = 1; i < bucket.length && divergences.length > 0; i++) {
      const div = diffAgainstGolden(trace, bucket[i], fields);
      if (div.length < divergences.length) {
        bestIdx = i;
        divergences = div;
      }
    }
    bucket.splice(bestIdx, 1);

    const ok = divergences.length === 0;
    if (ok) passed++;
    else failed++;
    results.push({ trace_id: trace.id, agent_name: trace.agent_name, matched: true, passed: ok, divergences });
  }

  return { results, passed, failed, unmatched, ok: failed === 0 && (!opts.strict || unmatched === 0) };
}

function diffAgainstGolden(trace: TraceWithDetails, golden: GoldenEntry, fields: string[]): Divergence[] {
  const divergences: Divergence[] = [];
  const gSteps = golden.steps_summary;
  const cSteps = trace.steps;

  if (fields.includes('step_count') && gSteps.length !== cSteps.length) {
    divergences.push({ field: 'step_count', golden: gSteps.length, candidate: cSteps.length });
  }

  const n = Math.min(gSteps.length, cSteps.length);

  if (fields.includes('step_types')) {
    for (let i = 0; i < n; i++) {
      if (gSteps[i].step_type !== cSteps[i].step_type) {
        divergences.push({ field: 'step_types', step_number: cSteps[i].step_number, golden: gSteps[i].step_type, candidate: cSteps[i].step_type });
        break;
      }
    }
  }

  if (fields.includes('step_names')) {
    for (let i = 0; i < n; i++) {
      if (gSteps[i].name !== cSteps[i].name) {
        divergences.push({ field: 'step_names', step_number: cSteps[i].step_number, golden: gSteps[i].name, candidate: cSteps[i].name });
        break;
      }
    }
  }

  if (fields.includes('tool_inputs')) {
    const byNumber = new Map<number, GoldenStepSummary>();
    for (const g of gSteps) byNumber.set(g.step_number, g);
    for (const step of cSteps) {
      if (step.step_type !== 'tool_call') continue;
      const g = byNumber.get(step.step_number);
      if (!g || g.input === undefined) continue;
      if (stableStringify(g.input) !== stableStringify(step.input)) {
        divergences.push({ field: 'tool_inputs', step_number: step.step_number, golden: g.input, candidate: step.input });
        break;
      }
    }
  }

  if (fields.includes('status')) {
    const goldenStatus = (golden.metadata as { status?: string })?.status;
    if (goldenStatus != null && goldenStatus !== trace.status) {
      divergences.push({ field: 'status', golden: goldenStatus, candidate: trace.status });
    }
  }

  // Opt-in: catch a per-step model change (only where the golden recorded one).
  if (fields.includes('model')) {
    const byNumber = new Map<number, GoldenStepSummary>();
    for (const g of gSteps) byNumber.set(g.step_number, g);
    for (const step of cSteps) {
      const g = byNumber.get(step.step_number);
      if (!g || g.model == null) continue;
      if (g.model !== (step.model ?? null)) {
        divergences.push({ field: 'model', step_number: step.step_number, golden: g.model, candidate: step.model ?? null });
        break;
      }
    }
  }

  return divergences;
}
