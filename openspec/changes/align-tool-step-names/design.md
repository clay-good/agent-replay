# Design Notes

## Open Questions

1. **Is `step_names` meant to identify the TOOL or the ACTION?** The Claude paths
   answer "the tool" (`Bash`, `Read`) and the Codex stream answers "the action"
   (`ls`). Both are defensible; the gate compares whichever it is given.
2. **What should a `custom_tool_call` named `exec` become?** It is 194 of 219
   real calls, so under option 1 nearly every Codex step in a baseline shares one
   name, and `--fields step_names` stops distinguishing runs of that agent.
3. **Is a baseline break acceptable?** Option 2 changes names for newly imported
   rollouts, so a baseline exported before it reports a regression on the first
   run imported after. The repo's precedent for that is `--fields decisions`:
   the field was made opt-in rather than silently changing an existing gate.

## What is already true

- Both paths pair calls with their outputs and now close the paired steps
  (52375ee, 87c53d7), so the disagreement is about NAMES alone.
- `tool_inputs` already carries the command on both paths, so nothing is lost
  from the trace either way — this is about what the gate compares by default.
