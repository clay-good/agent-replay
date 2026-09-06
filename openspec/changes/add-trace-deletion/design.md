# Design — add-trace-deletion

## Context

`agent-replay` captures continuously (hooks fire per event, `run` wraps every
child, `otel serve` receives while it is up) and offers no way to remove what it
captured. Every other lifecycle operation exists: create (`init`), fill
(`record`/`import`/`ingest`), read, export, and re-import. Deletion is the one
gap, and the store is exactly the kind of data — prompts, tool inputs, tool
outputs, in plaintext at `0600` — where a user eventually needs it.

The current honest answer is documented in the README (remove the store
directory, or call the SDK's `deleteTrace`), which is a workaround, not a
feature.

## Open Questions — these are the decision, and they are the maintainer's

1. **Scope of a single invocation.** By id only (safe, tedious for a purge), or
   by the `list` filters (`--agent`, `--tag`, `--status`, `--before`)? A filter
   that matches more than intended is how this feature does harm.
2. **Confirmation.** Prompt on a TTY and refuse off one, as `guard check`
   distinguishes those environments? Require `--yes` in scripts? Always
   `--dry-run`-first? The repo already refuses to let `demo --reset` clear a
   directory it does not recognize; the same instinct applies here, one level
   sharper.
3. **Forks and lineage.** Deleting a parent whose fork survives leaves
   `parent_trace_id` pointing at nothing. Cascade to forks, refuse while a fork
   exists, or null the link (the schema's `ON DELETE SET NULL` already does the
   last)?
4. **Does it belong in the CLI at all?** The SDK function is exported and
   documented. If deletion is meant to be deliberate and rare, "write four lines
   against the SDK" may be the right amount of friction.

## Non-Goals (unless the answers above change them)

- Retention policies, TTLs, or automatic pruning on a schedule — a background
  process that removes a user's captured runs is a much larger commitment than a
  command they invoke
- `VACUUM`/compaction: SQLite reuses freed pages, and a store that must shrink
  on disk is a separate concern

## Notes for whoever implements it

- `deleteTrace` cascades through `ON DELETE CASCADE` on steps → snapshots and on
  evals; decisions hang off steps, so they go too. Verified on a demo store: no
  orphans in `agent_trace_decisions` afterwards.
- Deletion must not be reachable from a capture path. Everything that writes
  traces runs unattended, and the rule this repo already follows is that a
  command which loses data must be one a person typed.
