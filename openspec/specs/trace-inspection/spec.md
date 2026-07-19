# trace-inspection Specification

## Purpose

Browse and understand recorded traces: filtered listing, detailed step-by-step views, animated replay, and an aggregate terminal dashboard.
## Requirements
### Requirement: Trace listing

The system SHALL list traces via `agent-replay list` with filters (`--status` exact match, `--agent` substring match, `--tag` exact match against the tags array, `--since <duration>`), sorting (`--sort started_at|duration|tokens|cost`), a result limit (default 25), and `--json` output for piping.

#### Scenario: Filter failed traces

- **WHEN** a user runs `agent-replay list --status failed`
- **THEN** only traces with status `failed` are shown

### Requirement: Trace detail view

The system SHALL show a full trace via `agent-replay show <trace-id>` including metadata, the step timeline, and optionally eval results (`--evals`) and snapshot data (`--snapshots`). Trace lookup SHALL match by exact ID or ID prefix (IDs are `trc_`-prefixed, so a usable prefix starts with `trc_`); when a prefix matches multiple traces, the first match is returned — there is no ambiguity error.

#### Scenario: Prefix lookup

- **WHEN** a user runs `agent-replay show trc_ab3` and a trace ID starts with `trc_ab3`
- **THEN** that trace is displayed (the first match, if several share the prefix)

### Requirement: Animated replay

The system SHALL replay a recorded trace step-by-step in the terminal via `agent-replay replay <trace-id>`, with speed control (`--speed`, 0 = instant), optional pauses, and step-range bounds (`--from-step`, `--to-step`). Replay is a visualization of recorded data; it does not re-execute anything.

#### Scenario: Partial replay

- **WHEN** a user runs `agent-replay replay <id> --from-step 3 --to-step 7`
- **THEN** only steps 3 through 7 are animated

### Requirement: Terminal dashboard

The system SHALL provide a full-screen dashboard via `agent-replay dashboard` with aggregate stats and charts, auto-refreshing on an interval and supporting keyboard navigation.

#### Scenario: Launch dashboard

- **WHEN** a user runs `agent-replay dashboard --refresh 10`
- **THEN** the dashboard renders and refreshes every 10 seconds until `q` is pressed

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

