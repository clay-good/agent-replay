import { createHash } from 'node:crypto';
import type { TraceWithDetails } from '../models/types.js';
import type { GoldenEntry } from './export-service.js';

/**
 * Golden regression check: compare candidate traces against a golden dataset,
 * matching by agent name + input hash and diffing on a structural field
 * allowlist (step count/types/names, tool-call inputs, final status) rather
 * than raw output text, so non-deterministic wording never trips the check.
 */

// Compared by default. `model` is opt-in via --fields (model swaps are often
// intentional, so it shouldn't fail a default regression check).
export const DEFAULT_FIELDS = ['step_count', 'step_types', 'step_names', 'tool_inputs', 'step_errors', 'status'] as const;
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
  /**
   * Baseline entries no candidate reproduced — a scenario the gate was supposed
   * to cover that this run never exercised. The verdict was candidate-driven
   * only, so if the run that produces a scenario crashed, recorded under a
   * different agent name, or ran a different input, the gate stayed green with
   * nothing to say about it. Reported always; a failure only under --strict.
   */
  uncovered: number;
  /** Overall CI verdict: no failures (and, in strict mode, no unmatched or uncovered). */
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

  const covered = new Set<string>();
  for (const trace of candidates) {
    const key = goldenKey(trace.agent_name, trace.input);
    const bucket = index.get(key);
    if (!bucket || bucket.length === 0) {
      unmatched++;
      results.push({ trace_id: trace.id, agent_name: trace.agent_name, matched: false, passed: !opts.strict, divergences: [] });
      continue;
    }

    // Compare against the closest golden entry in the bucket (fewest
    // divergences). A bucket holds several known-good baselines for one
    // agent+input (repeated runs, or a fork), and a candidate is good if it
    // reproduces ANY of them — so do NOT consume the matched entry. Consuming
    // gave two identical candidates opposite verdicts (the first took the exact
    // match, the next was forced onto a leftover and falsely "regressed") and
    // could even hide a real regression as "unmatched" once the bucket emptied.
    let divergences = diffAgainstGolden(trace, bucket[0], fields);
    for (let i = 1; i < bucket.length && divergences.length > 0; i++) {
      const div = diffAgainstGolden(trace, bucket[i], fields);
      if (div.length < divergences.length) {
        divergences = div;
      }
    }

    covered.add(key);
    const ok = divergences.length === 0;
    if (ok) passed++;
    else failed++;
    results.push({ trace_id: trace.id, agent_name: trace.agent_name, matched: true, passed: ok, divergences });
  }

  // Count ENTRIES, not bucket keys: a key can hold several baselines (repeated
  // runs of one agent+input), and reporting "1 baseline not exercised" for 100
  // untouched entries under-states the hole the message is there to name.
  let uncovered = 0;
  for (const [key, bucket] of index) if (!covered.has(key)) uncovered += bucket.length;

  return {
    results,
    passed,
    failed,
    unmatched,
    uncovered,
    ok: failed === 0 && (!opts.strict || (unmatched === 0 && uncovered === 0)),
  };
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
    // Align positionally, exactly like step_types/step_names above. Keying off
    // the absolute step_number instead would disagree with those checks whenever
    // the two traces number their steps differently — a valid, common case, since
    // step numbers need only be >= 1 (OTLP-assembled, imported, or gapped traces
    // may start above 1 or skip values). That mismatch made a tool_call's number
    // land on an unrelated golden step, so a real tool-input regression slipped
    // through the gate while the positional checks reported a perfect match.
    //
    // The guard keys off the GOLDEN side. Skipping when the *candidate* is not a
    // tool_call meant the one case this field exists to catch — a baseline tool
    // call the candidate replaced with something else — was invisible: with
    // `--fields tool_inputs` (no step_types to catch it), "the tool call became
    // an llm_call with different arguments" reported a clean pass.
    for (let i = 0; i < n; i++) {
      const g = gSteps[i];
      const step = cSteps[i];
      if (g.step_type !== 'tool_call' || g.input === undefined) continue;
      if (step.step_type !== 'tool_call') {
        // Name what replaced it. A bare `candidate: null` reads as "golden null
        // → got null" whenever the baseline itself recorded no tool input —
        // exactly what `export --format golden` writes for a store captured
        // with `hook --no-input`.
        divergences.push({
          field: 'tool_inputs',
          step_number: step.step_number,
          golden: g.input,
          candidate: { replaced_by_step_type: step.step_type },
        });
        break;
      }
      if (stableStringify(g.input) !== stableStringify(step.input)) {
        divergences.push({ field: 'tool_inputs', step_number: step.step_number, golden: g.input, candidate: step.input });
        break;
      }
    }
  }

  // A step that now fails where the baseline succeeded is a regression even when
  // every other field matches — and it is invisible to `status`, because a
  // hook-captured session finalizes `completed` from its Stop event however many
  // tool calls failed inside it. Positional, like the checks above.
  //
  // Steps from a baseline exported before this field are skipped individually —
  // see the guard inside the loop.
  if (fields.includes('step_errors')) {
    for (let i = 0; i < n; i++) {
      // Absent means the baseline predates the field, so this step's outcome is
      // unknown — skip it rather than reading absence as success, which would
      // report a false regression for every failing step in an old baseline.
      if (gSteps[i].failed === undefined) continue;
      const goldenFailed = gSteps[i].failed === true;
      const candidateFailed = cSteps[i].error != null;
      if (goldenFailed !== candidateFailed) {
        divergences.push({
          field: 'step_errors',
          step_number: cSteps[i].step_number,
          golden: goldenFailed ? 'failed' : 'ok',
          candidate: candidateFailed ? 'failed' : 'ok',
        });
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
  // Positional, for the same reason as tool_inputs above.
  if (fields.includes('model')) {
    for (let i = 0; i < n; i++) {
      const g = gSteps[i];
      const step = cSteps[i];
      if (g.model == null) continue;
      if (g.model !== (step.model ?? null)) {
        divergences.push({ field: 'model', step_number: step.step_number, golden: g.model, candidate: step.model ?? null });
        break;
      }
    }
  }

  return divergences;
}
