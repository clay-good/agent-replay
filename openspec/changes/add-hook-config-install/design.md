# Design — add-hook-config-install

## The blocker: the proposed spelling cannot work

`agent-replay hook install --harness claude-code` — the form the original design
doc names — is not available, for two independent reasons. Both verified against
the built CLI on 2026-09-06:

1. **`hook` already takes a positional argument.** It is declared
   `hook [event]`, so `hook install` parses as the hook EVENT named "install"
   and runs the capture adapter: `agent-replay hook: unknown [unknown] —
   ignored event "install"`, exit 0. A subcommand cannot be added under a
   command whose positional it would collide with.
2. **A usage error on `hook` is forced to exit 0.** `cli.ts` overrides
   commander's exit for capture-mode `hook`, deliberately: in every supported
   harness a non-zero hook exit blocks the pending tool call, so a typo'd
   settings line would otherwise block every tool call in the session. An
   installer living under `hook` would inherit that, and could not report a
   failed install — the one thing an installer must be able to do.

## Options for the name

- **`agent-replay install-hooks --harness <h>`** — a sibling command, no
  collision, no inherited exit rule. Reads a little unlike the rest of the CLI,
  which is all single words.
- **`agent-replay init --hooks <h>`** — folds into the command that already
  sets a project up. Mixes "create a store here" with "edit a file in my home
  directory", which are different blast radii.
- **`agent-replay config hooks <h>`** — under the existing config namespace,
  which is already about writing configuration. The config command family today
  only touches agent-replay's own config file, not a harness's.
- **Don't add it.** The README snippets are copy-pasteable and correct, and a
  command that edits another program's config file in `$HOME` is a support
  burden the tool may not want.

## Open Questions

1. Which name (above) — or none?
2. Print or write? A printer (`>>` in the user's own shell) has no blast radius
   at all; a writer has to merge JSON/TOML without clobbering what is there.
3. If it writes: back up first, or refuse when the file already has a `hooks`
   key it did not create? The `--force`/`--dry-run` precedents both exist in
   this CLI.
4. Gemini and Codex event names differ from Claude's, and Codex needs `/hooks`
   trust afterwards. Does the command say that, or is that back to documentation?

## Non-Goals

- Detecting which harnesses are installed and configuring them all at once
- Removing or updating a previously written block (an uninstall is a second,
  larger decision)
