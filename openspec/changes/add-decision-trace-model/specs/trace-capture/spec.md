# trace-capture Delta

## MODIFIED Requirements

### Requirement: Step model

The system SHALL store ordered steps per trace with a `step_type` from: `thought`, `tool_call`, `llm_call`, `retrieval`, `output`, `decision`, `error`, `guard_check`; each step carries name, input/output, timing, tokens, model, error, and metadata, plus optional structural fields: `parent_step` (hierarchy) and `caused_by_step` (causality), both step-number references to strictly earlier steps in the same trace. Steps of type `decision` MAY carry a structured decision record. Step numbers SHALL be positive integers, unique within a trace — uniqueness is enforced by the database constraint `UNIQUE(trace_id, step_number)`, not by pre-validation.

#### Scenario: Duplicate step number rejected

- **WHEN** an ingested trace contains two steps with the same `step_number`
- **THEN** the insert transaction fails on the uniqueness constraint, nothing from that trace is stored, and the error is reported

#### Scenario: Flat v1 trace remains valid

- **WHEN** a trace without any `parent_step`, `caused_by_step`, `decision`, or `session_id` fields is ingested
- **THEN** it is accepted unchanged, with the new fields stored as NULL

### Requirement: Canonical trace data model

The system SHALL store traces with agent identity, trigger, status (`running`, `completed`, `failed`, `timeout`), input/output payloads, timing, token and cost totals, error, tags, metadata, fork lineage (`parent_trace_id`, `forked_from_step`), and an optional `session_id` correlation key. Only `agent_name` is required at ingest; when `status` is omitted it defaults to `completed` if `ended_at` is present and `running` otherwise. Trace IDs are generated as `trc_<nanoid>`.

#### Scenario: Minimal trace accepted

- **WHEN** a trace containing only `agent_name` is ingested
- **THEN** it is accepted with status `running` (no `ended_at` was given), a defaulted `started_at`, and empty payloads

#### Scenario: Session key persisted

- **WHEN** a trace with `session_id: "conv-42"` is ingested
- **THEN** the session key is stored and usable as a list filter
