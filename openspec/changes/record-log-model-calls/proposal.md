# Record Model Calls Captured as Log Events

> **Status: PROPOSAL — awaiting a decision. Nothing here is implemented.**
> Raised because the gap is measured and real, and closing it changes the shape
> of already-stored traces, which is a product call rather than a technical one.

## Why

The two OTel receivers front the same store, and they disagree about whether a
model call is a step.

| Path | A successful model call becomes | A failed model call becomes |
| ---- | ------------------------------- | --------------------------- |
| `/v1/traces` (spans) | an `llm_call` step with model, tokens and duration | an `llm_call` step with the error |
| `/v1/logs` (`claude_code.api_request`, `gemini_cli.api_response`) | **nothing** — only a contribution to the trace's token and cost totals | an `llm_call` step with the error |

Measured on this machine (2026-09-06): a session of one prompt, two
`claude_code.api_request` records and one `tool_result` maps to a trace with
**one step** (`tool_call:Bash`) and `total_tokens: 42`. The same session as
spans maps to a trace with an `llm_call` step per inference span.

So a log-captured session reports a token total with nothing in the trace to
attribute it to. Concretely:

- `show` and `replay` draw a run that apparently called no model at all, while
  the header prints its token count.
- `check --fields step_names` / `step_types` compare different shapes for one
  session depending on which endpoint the exporter was pointed at, so a
  baseline is not portable between them.
- An evaluator that reasons about model calls sees zero of them, the same class
  of blindness the hook's swallowed tool failures caused for `step_errors`.
- The per-call model, duration and token split are all present in the payload
  and are discarded; only the summed total survives.

This is acknowledged in the code today ("a batch of nothing but model-call
events (which produce no steps)"), which is why it is raised rather than
silently changed.

## What Changes

Nothing yet. The options, with what each costs:

1. **Emit an `llm_call` step per model-call record**, mirroring the span path:
   name from the model, `model`, `tokens_used` from that record's own counts,
   `duration_ms` when reported. Most faithful, and makes the two receivers
   agree. Costs: every existing log-captured baseline gains steps, so
   `check --golden` reports a regression on the first run after the upgrade;
   and a long session gains one step per API call, which for Claude Code is
   many — `show`'s large-output hint exists for exactly this, but it is a real
   change in what a trace looks like.
2. **Emit one `llm_call` step per model, aggregated**, so a session shows what
   it called without one row per request. Cheaper to read; loses the per-call
   timing and split that option 1 preserves, and has no counterpart on the span
   path, so the two receivers still would not agree.
3. **Leave capture as it is and disclose it** — have `show` say that this
   trace's tokens come from records that produced no steps. No shape change and
   no baseline churn; the data stays lost, and `check` remains non-portable
   across the two endpoints.

## Impact

- Affected specs: `telemetry-ingest` ("Known-emitter log-event enrichment"),
  possibly `trace-inspection` if option 3
- Affected code: `src/services/otel/log-events.ts`; option 3 also
  `src/commands/show.ts`
- Whichever is chosen, `tests/cross-path-consistency.test.ts` should grow a
  spans-vs-logs case so the two receivers cannot drift again — that pair is how
  this was found, along with two defects already fixed (cache tokens dropped
  from log token totals, and a log session ending before its own last step).
- **Unresolved and worth answering first**: the token accumulator adds counts
  from BOTH `*.api_request` and `*.api_response`. Each CLI is believed to emit
  only one of the two per call, so nothing double-counts today — but that has
  not been checked against a real capture from either vendor, and if a CLI
  emits both, option 1 would double the steps as well as the tokens. This
  should be confirmed against a real session before any of the options is built.
