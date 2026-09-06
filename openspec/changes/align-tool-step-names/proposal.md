# Align Tool Step Names Across Codex Capture Paths

> **Status: PROPOSAL — awaiting a decision. Nothing here is implemented.**
> Raised because the inconsistency is measured and real, and the choice between
> the two names is a product call, not a technical one.

## Why

The same Codex session captured two ways produces two different step names for
the same tool call:

| Path | Step name | Where it comes from |
| ---- | --------- | ------------------- |
| `record --format codex-exec` | `ls` | the first token of `item.command` |
| `import --format codex-rollout` | `shell` / `exec` | the call's `name` field |

Measured on this machine (2026-09-06): a synthetic pair of the same `ls -la`
session gives `ls` and `shell`; a real rollout's tool steps are all named `exec`
(the `custom_tool_call` name, which is 194 of every 219 real calls).

That matters because `step_names` is a DEFAULT field of the regression gate. A
baseline exported from one path and checked against a run captured by the other
reports a regression on every tool call — a false red that the tool itself
caused. `diff` across the two paths shows the same spurious differences.

Both spellings were chosen deliberately, for opposite reasons, which is why this
is a decision rather than a bug:

- The stream translator was changed to the command's first token *because*
  naming every step after the item type made `step_names` inert — two unrelated
  sessions produced byte-identical step names.
- The rollout importer uses the call's own `name`, which is what the vendor's
  record says the tool is, and matches how the Claude importer names a
  `tool_use` (`Bash`, `Read`).

## What Changes

Nothing yet. The options, with what each costs:

1. **Both use the tool name** (`shell` / `exec`). Consistent with the Claude
   paths and with the vendor's own vocabulary; makes `step_names` coarse for
   Codex, since nearly every call is `exec` — the inertness the stream fix
   existed to remove.
2. **Both use the command's first token** (`ls`). Keeps `step_names`
   discriminating; the rollout importer has the command in `arguments` and could
   derive it; changes the names of newly imported rollouts, so a baseline
   exported before the change reports a regression against runs imported after.
3. **Keep both and normalize in the gate.** No capture change; `check` would
   compare a canonical name. Hides the difference from `diff`, and puts
   knowledge of one vendor's shapes into the comparison layer.

## Impact

- Affected specs: `trace-capture` (both Codex paths), possibly `trace-comparison`
- Affected code: `src/services/stream-translators.ts`, `src/services/importers/codex-rollout.ts`, or `src/services/check-service.ts`
- Whichever is chosen, the cross-path test added in `tests/cross-path-consistency.test.ts` should grow a Codex case, so the two paths cannot drift again
