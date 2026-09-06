# Add Hook Config Install

> **Status: PROPOSAL — awaiting a decision, specifically on the command name.**
> The spelling the original design doc proposed cannot work; `design.md`
> explains why and lists the alternatives. Nothing here is implemented.

## Why

This was deferred once already. `add-live-trace-capture`'s design doc closed
with: "Whether to ship ready-made hook config snippets (`agent-replay hook
install --harness claude-code|codex|gemini` writing the settings.json/config.toml
blocks) in this change or a follow-up. Leaning follow-up; README snippets
first." The README snippets shipped; the follow-up did not.

The snippets are the setup path for the tool's headline capture mode, and they
are the step most likely to go wrong: a JSON block hand-merged into
`~/.claude/settings.json`, six event names, a TOML table array for Codex, and
different event names again for Gemini. A typo there is silent — capture simply
does not happen — and the tool cannot tell the user, because it is never
invoked.

Writing the blocks is transcription, not invention: all three live in the README
today, verbatim.

## What Changes

Nothing yet. The feature is well understood; the naming is not (see below).

Sketched: a command that, per harness, prints the block or merges it into the
harness's config file, refusing to overwrite an existing unrelated key, with a
`--dry-run` that shows the resulting file.

## Impact

- Affected specs: `trace-capture` (a setup-assistance requirement)
- Affected code: a new command module, `src/cli.ts`; no service changes
- Writes to files OUTSIDE the store, in the user's home directory — the first
  such write in the tool. That alone deserves the deliberate decision this
  proposal is asking for
