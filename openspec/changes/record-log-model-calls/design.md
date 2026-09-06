# Design Notes

## Open Questions

1. **Does a CLI emit both `api_request` and `api_response` for one call?** The
   token accumulator adds counts from either, and each vendor is believed to
   emit only one — Claude Code `api_request`, Gemini CLI `api_response`. If
   that is wrong, today's token totals are already doubled, and option 1 would
   double the steps too. Confirm against a real capture before building
   anything: this is the one question whose answer could change what the
   existing numbers mean.
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
