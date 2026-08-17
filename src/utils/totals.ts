/**
 * The trace's token total, falling back to the sum its steps carry when the
 * trace-level column was never set. Display-only — it never changes stored data.
 *
 * The stored total exists only when a producer reports one (`trace_end` totals,
 * or an ingested `total_tokens`), while `ingest`, `record`, the OTel mapper and
 * the importers all populate per-step `tokens_used`. Reading the column alone
 * therefore reports "no tokens" for a trace that plainly has them — the TS twin
 * of `TOKENS_EXPR` in trace-service.ts and of the duration fallback in
 * `effectiveDurationMs`.
 *
 * Returns null only when nothing measured tokens at all, so "unmeasured" stays
 * distinguishable from a real zero.
 */
export function effectiveTokens(trace: {
  total_tokens?: number | null;
  effective_tokens?: number | null;
  steps?: { tokens_used: number | null }[];
}): number | null {
  if (trace.total_tokens != null) return trace.total_tokens;
  if (trace.effective_tokens != null) return trace.effective_tokens;
  return (trace.steps ?? []).reduce<number | null>(
    (sum, s) => (s.tokens_used == null ? sum : (sum ?? 0) + s.tokens_used),
    null,
  );
}
