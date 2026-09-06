# trace-inspection Specification

## Purpose

Browse and understand recorded traces: filtered listing, detailed step-by-step views, animated replay, and an aggregate terminal dashboard.
## Requirements
### Requirement: Trace listing

The system SHALL list traces via `agent-replay list` with filters (`--status` exact match, `--agent` substring match, `--tag` exact match against the tags array, `--session <id>` prefix match, `--since <duration>`), sorting (`--sort started_at|duration|tokens|cost|agent_name`, each accepting a `-` prefix for descending order), a result limit (default 25), and `--json` output for piping. An EMPTY value for any filter SHALL be a usage error (exit 2), never a silently widened scope: a filter built from an unset shell variable must fail loudly rather than return every trace at exit 0, which reads exactly like a correct narrow result. Ordering by `started_at` SHALL rank traces by the instant their timestamp denotes, not by its bytes, for every timestamp format a producer writes — including an ISO 8601 basic-format offset (`+0200`).

#### Scenario: Filter failed traces

- **WHEN** a user runs `agent-replay list --status failed`
- **THEN** only traces with status `failed` are shown

### Requirement: Trace detail view

The system SHALL show a full trace via `agent-replay show <trace-id>` including metadata, the step timeline, and optionally eval results (`--evals`) and snapshot data (`--snapshots`). Trace lookup SHALL match by exact ID or ID prefix (IDs are `trc_`-prefixed, so a usable prefix starts with `trc_`); a prefix matching more than one trace SHALL be an error naming the candidates, never a silent pick — `show`/`why`/`decisions` answer about a trace the user did not name, and `fork`, which WRITES, would derive a new trace from one.

A `--json` document SHALL be the whole trace, in document order, whatever the view flags say. `--snapshots` SHALL attach each snapshot to its own step as `snapshot`, field for field the shape `export --with-snapshots` writes and `ingest` reads, so the document re-ingests with its snapshots intact; a step with no snapshot SHALL carry `null`. The steps SHALL be rewritten ONLY when the flag is passed, so a `show --json` without it is unchanged. `--evals` needs no such handling because evaluations are always in the payload. The flags that shape the HUMAN view alone — `--steps-only` and `--tree` — cannot be honoured by a document, so passing either with `--json` SHALL say the flag did nothing, on stderr, leaving stdout a clean document; the tree it would have drawn is rebuildable from the `parent_step_number` and `caused_by_step_number` carried on each step.

#### Scenario: Snapshots in machine-readable form

- **WHEN** a user runs `agent-replay show <id> --json --snapshots` on a trace whose steps 1 and 3 have snapshots and step 2 does not
- **THEN** steps 1 and 3 carry their snapshot under `snapshot` and step 2 carries `null`
- **WHEN** that document is piped back through `agent-replay ingest`
- **THEN** the re-ingested trace has both snapshots, and step 2 still has none
- **WHEN** the same command runs without `--snapshots`
- **THEN** no step carries a `snapshot` key at all

#### Scenario: A view flag a document cannot honour

- **WHEN** a user runs `agent-replay show <id> --json --tree`
- **THEN** stderr says `--tree` has no effect with `--json`, and stdout is the same document the command would print without it

#### Scenario: Prefix lookup

- **WHEN** a user runs `agent-replay show trc_ab3` and a trace ID starts with `trc_ab3`
- **THEN** that trace is displayed; if several traces share the prefix, the command errors (exit 1) and names the candidates

### Requirement: Animated replay

The system SHALL replay a recorded trace step-by-step in the terminal via `agent-replay replay <trace-id>`, with speed control (`--speed`, 0 = instant), optional pauses, and step-range bounds (`--from-step`, `--to-step`). Replay is a visualization of recorded data; it does not re-execute anything.

#### Scenario: Partial replay

- **WHEN** a user runs `agent-replay replay <id> --from-step 3 --to-step 7`
- **THEN** only steps 3 through 7 are animated

### Requirement: Terminal dashboard

The system SHALL provide a full-screen dashboard via `agent-replay dashboard` with aggregate stats and charts, auto-refreshing on an interval and supporting keyboard navigation.

Because it takes over the terminal and exits on a keypress, it SHALL refuse with exit 2 — writing nothing to stdout — when stdout or stdin is not a TTY, pointing the caller at `stats --json`; otherwise it hangs forever after emitting alt-screen and mouse-tracking escape sequences into a redirected stream. It SHALL refuse a `--refresh` above 2147483 seconds, which a 32-bit timer clamps to 1 ms — the inverse of the request. Argument validation SHALL run BEFORE the terminal check, so a typo is reported to the script that made it.

#### Scenario: Launch dashboard

- **WHEN** a user runs `agent-replay dashboard --refresh 10` on an interactive terminal
- **THEN** the dashboard renders and refreshes every 10 seconds until `q` is pressed
- **WHEN** the same command runs with stdout redirected
- **THEN** it refuses with exit 2 and writes nothing to stdout

### Requirement: Hierarchical step view

The system SHALL render the step hierarchy via `agent-replay show <trace-id> --tree`, nesting child steps under their `parent_step` and marking causal links, falling back to the flat timeline when no structure is present.

#### Scenario: Tree rendering

- **WHEN** a user runs `show <id> --tree` on a trace where steps 4–6 are children of step 3
- **THEN** steps 4–6 render indented beneath step 3

#### Scenario: Flat trace fallback

- **WHEN** a user runs `show <id> --tree` on a trace with no parent references
- **THEN** the ordinary flat timeline is shown without error

### Requirement: Live trace watch

The system SHALL live-tail a running trace via `agent-replay watch [trace-id]`, rendering new steps as they are written; with no trace ID given, it SHALL follow the most recently started `running` trace, and it SHALL announce final status when the trace completes.

Each poll SHALL read the steps written since the previous one, not the whole trace, so that the cost of following a run does not grow with the length of the run — a live tail is used on long sessions, which is exactly where re-reading everything twice a second is most expensive. The cursor SHALL be write order, not step number, because producer-supplied step numbers need not increase and a step written after a higher-numbered one must still reach the tail. A step closed in place (`step_end`) SHALL be re-read by number while it is open, and the tail SHALL reconcile against the trace's step COUNT so a step that lands outside the cursor cannot be dropped.

A trace still `running` past the abandoned threshold SHALL be marked as such wherever it is presented — the listing, the `show` header, `watch`'s attach line — and reported in BOTH `list --json` and `show --json` as a derived `possibly_abandoned`, never as a stored column — the listing is where a store-wide scan for stalled runs happens, and a document reader sees no glyph. A producer that died without finalizing is indistinguishable from one still working, and a view that omits the marker disagrees with the one the reader just came from.

`list --source <format>` SHALL filter by the capture path a trace records, matching EXACTLY — the format names prefix one another (`record:native`, `record:codex-exec`), so a substring match would answer a narrower question than it was asked — and SHALL name the paths the store actually holds when the value matches nothing, since that is the difference between a typo and an absence. The `show` header SHALL name the capture path a trace records (`metadata.source_format`, with `dialect` when it adds something), and SHALL say nothing when the trace records none rather than guessing: the path is what explains an absent field (a hook capture records no model, an OTLP span carries no prompt) and the first thing a reader needs when one session has two traces. A trace recorded as a CONTINUATION (`metadata.compacted`, set by the importer when the transcript states it) SHALL be marked as such in the `show` header: its duration and step count cover only the part after the compaction boundary, and the steps before it are in a file this trace cannot reach, so without the marker a fragment reads as a whole run. A FORK SHALL NOT be marked abandoned at any age, and SHALL be marked as a fork in the listing. `fork` leaves its copy `running` for the user to explore, so the marker fired on every what-if sandbox half an hour after it was made and reported a healthy copy as a capture whose writer had died — the same line `getMostRecentRunningTrace` already draws when it refuses to attach `watch` to a fork. The listing SHALL say what the trace IS instead: a fork carries its parent's agent name, status and token count, so without a marker it reads as a second live run of the same agent, and `list` counts it where `stats` does not. The dashboard's trace table SHALL mark it the same way; a view that reads a derived fact SHALL select the column that fact depends on, since a query that omits `parent_trace_id` puts the view beyond the reach of a fix made at the source.

A trace that DISAPPEARS from the store while being watched SHALL end the tail with a message naming it and exit 1, not be polled indefinitely: a deleted trace is not a quiet one, and a watcher that cannot tell the difference reports the wrong thing about a live run.

The poll interval SHALL be settable with `--interval <ms>`. Because Node stores a timer delay in a 32-bit signed integer and CLAMPS anything larger to 1 ms, a value above that range SHALL be refused (exit 2) rather than polled: it plainly asks to poll almost never and would instead poll about a thousand times a second, the inverse of the request. `--interval` SHALL be validated BEFORE the trace is resolved, so a typo is a usage error even when there is nothing to watch. A trace named explicitly that does not exist SHALL be an error (exit 1); finding nothing running in the auto case is a normal empty state and SHALL stay at exit 0.

#### Scenario: Tail a running trace

- **WHEN** a user runs `agent-replay watch` while an agent records steps
- **THEN** each new step appears in order shortly after it is written, and the watch reports the trace's final status on completion

#### Scenario: An interval that would overflow the timer

- **WHEN** a user runs `agent-replay watch --interval 999999999999`
- **THEN** the command refuses with exit 2, naming the maximum, instead of polling every millisecond

#### Scenario: Nothing to watch

- **WHEN** a user runs `agent-replay watch trc_missing` for a trace that does not exist
- **THEN** the command errors with exit 1
- **WHEN** a user runs `agent-replay watch` with no trace running
- **THEN** it reports the empty state at exit 0

### Requirement: Abandoned trace flagging

The system SHALL flag traces still in status `running` past a staleness threshold in `list` output, so crashed or dangling captures are visible.

#### Scenario: Stale running trace

- **WHEN** a trace has been `running` for longer than the staleness threshold
- **THEN** `agent-replay list` marks it as possibly abandoned

#### Scenario: A what-if fork left open for an afternoon

- **WHEN** a fork made three hours ago is listed and shown
- **THEN** it is marked `⑂ fork`, not `⚠ abandoned?`, and `show --json` reports `possibly_abandoned: false`

