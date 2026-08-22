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

#### Scenario: Tail a running trace

- **WHEN** a user runs `agent-replay watch` while an agent records steps
- **THEN** each new step appears in order shortly after it is written, and the watch reports the trace's final status on completion

### Requirement: Abandoned trace flagging

The system SHALL flag traces still in status `running` past a staleness threshold in `list` output, so crashed or dangling captures are visible.

#### Scenario: Stale running trace

- **WHEN** a trace has been `running` for longer than the staleness threshold
- **THEN** `agent-replay list` marks it as possibly abandoned

