# trace-capture Specification

## Purpose

Get agent execution data into the local SQLite store: batch ingestion of trace files, validation, and the canonical trace/step data model.

## Requirements

### Requirement: Batch trace ingestion

The system SHALL ingest traces from JSON files (single trace or array) and JSONL files (one trace per line) via `agent-replay ingest <file>`, auto-detecting the format when `--format` is omitted. Validation checks: `agent_name` present and a string; `status`/`trigger`/`step_type` within their enums; numeric totals finite and non-negative; `tags` an array of strings; step `step_number` a positive integer and step `name` present. Each trace is inserted in a single transaction.

#### Scenario: Ingest a JSON trace file

- **WHEN** a user runs `agent-replay ingest trace.json`
- **THEN** the trace and its steps are validated and inserted into the database
- **AND** the assigned trace ID is printed

#### Scenario: Dry-run validation

- **WHEN** a user runs `agent-replay ingest trace.json --dry-run`
- **THEN** the file is validated and errors are reported without inserting anything

#### Scenario: Tagging at ingest

- **WHEN** a user runs `agent-replay ingest trace.json --tags production,v2`
- **THEN** both tags are added to every ingested trace

### Requirement: Canonical trace data model

The system SHALL store traces with agent identity, trigger, status (`running`, `completed`, `failed`, `timeout`), input/output payloads, timing, token and cost totals, error, tags, metadata, and fork lineage (`parent_trace_id`, `forked_from_step`). Only `agent_name` is required at ingest; when `status` is omitted it defaults to `completed` if `ended_at` is present and `running` otherwise. Trace IDs are generated as `trc_<nanoid>`.

#### Scenario: Minimal trace accepted

- **WHEN** a trace containing only `agent_name` is ingested
- **THEN** it is accepted with status `running` (no `ended_at` was given), a defaulted `started_at`, and empty payloads

### Requirement: Step model

The system SHALL store ordered steps per trace with a `step_type` from: `thought`, `tool_call`, `llm_call`, `retrieval`, `output`, `decision`, `error`, `guard_check`; each step carries name, input/output, timing, tokens, model, error, and metadata. Step numbers SHALL be positive integers, unique within a trace — uniqueness is enforced by the database constraint `UNIQUE(trace_id, step_number)`, not by pre-validation.

#### Scenario: Duplicate step number rejected

- **WHEN** an ingested trace contains two steps with the same `step_number`
- **THEN** the insert transaction fails on the uniqueness constraint, nothing from that trace is stored, and the error is reported

### Requirement: State snapshots

The system SHALL accept an optional snapshot per step capturing `context_window`, `environment`, `tool_state`, and `token_count`, stored for later inspection.

#### Scenario: Step with snapshot

- **WHEN** a step includes a `snapshot` object at ingest
- **THEN** the snapshot is persisted and retrievable via `show --snapshots`
