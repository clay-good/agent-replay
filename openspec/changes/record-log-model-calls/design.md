# Design Notes

## Open Questions

1. ~~**Does a CLI emit both `api_request` and `api_response` for one call?**~~
   **ANSWERED — no, and nothing is doubled.** Claude Code 2.1.260 emits
   `api_request` and never `api_response`: the shipped bundle contains exactly
   one `To("api_request", {...})` emission and zero `To("api_response", ...)`
   (the string `api_response` appears there only as an error category and a
   request-id classifier). Its attributes are
   `{ model, input_tokens, output_tokens, cache_read_tokens,
   cache_creation_tokens, cost_usd, cost_usd_micros, duration_ms, request_id,
   ... }`. Gemini CLI sends `api_response` with the `*_token_count` forms. So
   the `??` chain reads one or the other, never both, and today's totals are
   correct. Option 1 would likewise produce one step per call, not two.
   (This also confirmed the cache attribute names: the SHORT
   `cache_read_tokens` / `cache_creation_tokens` go on the wire — the
   `*_input_tokens` forms are the SDK usage object's own fields. The receiver
   reads both; the order was corrected to put the real ones first.)
2. **Is a baseline break acceptable?** Option 1 gives every log-captured
   baseline new steps, so the first `check --golden` after the upgrade reports a
   regression the tool itself caused. The repo's precedent is `--fields
   decisions`: the field was made opt-in rather than silently changing a gate
   that already existed.
3. **Is one step per API call the right grain for Claude Code?** A long session
   makes many calls, and unlike a span capture there is no tree to fold them
   into. `show`'s large-output hint covers the reading problem; whether a
   thousand `llm_call` rows is the trace a user wants is a separate question.
4. **Should a step be created when the record carries no model?** Both CLIs
   redact content by default, and a record may report only counts. A step named
   after a model that was not reported would be an invented value, which the
   repo does not do — so such records would either produce an unnamed step or
   keep contributing totals only, splitting the behavior again.

## What is already true

- The span path builds its `llm_call` steps from inference spans and stamps
  model, tokens and duration on each, so option 1 has a working shape to copy
  rather than to invent.
- The log path already builds an `llm_call` step for a FAILED model call
  (`*.api_error`), including its model — so the step type, naming and closing
  rules for this path exist and are tested; only the success case is missing.
- Every log-derived step is closed at write time (5477d5a) and the session now
  ends no earlier than its last step, so a new step type would inherit correct
  timing without further work.
- `metadata.model` already carries the model the session was last reported on,
  so a trace is not entirely modelless today — but it is a single trace-level
  value, not per call, and a session that switched models keeps only the last.
