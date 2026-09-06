# Add Trace Deletion

> **Status: PROPOSAL — awaiting a decision. Nothing here is implemented.**
> Raised because the gap is real and the shape is not mine to pick; the
> questions that need answering are in `design.md` under Open Questions.

## Why

The store only grows, and nothing in the CLI removes anything from it.

That matters more here than for a typical local database, because of what a
trace holds. The store is created `0600` for a stated reason — "a trace holds
prompts, tool inputs and tool outputs" — and a hook-captured session records
every one of them for as long as the project exists. A user who captures a run
containing a secret, a customer's data, or a prompt they simply do not want kept
has two options today: delete the entire store (losing every other run, and the
API keys in `config.json` beside it), or open `traces.db` in `sqlite3` and write
the DELETE themselves.

The capability already exists internally. `deleteTrace(db, id)` is exported from
the package, is used by `import --replace`, and cascades correctly — steps,
decisions, snapshots and evaluations go with the trace and nothing is orphaned
(verified 2026-09-06). What is missing is the decision about how a user should
reach it, which is a product question rather than a technical one.

## What Changes

Nothing yet. Sketched for discussion:

- A command that removes traces by id, and possibly by the same filters `list`
  already takes (`--agent`, `--tag`, `--status`, `--before`/`--since`)
- A confirmation model for a destructive operation, following the precedent
  `demo --reset` already sets (it refuses a directory that does not look like a
  store it created)
- A `--dry-run` that reports what would go, following `ingest --dry-run`
- Documentation of what deletion means for a golden baseline exported earlier
  (the entries stay in the file; the runs behind them are gone)

## Impact

- Affected specs: `local-store` (a data-lifecycle requirement), possibly
  `trace-inspection`
- Affected code: a new `src/commands/*`, `src/cli.ts`; the service function
  already exists
- **Risk is the point of the proposal**: this is the second destructive command
  in the tool, and the first one that can destroy captured work rather than a
  sample dataset. The guard design matters more than the feature
