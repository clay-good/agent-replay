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
