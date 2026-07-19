# trace-export Specification

## Purpose

Get traces back out of the store for sharing, pipelines, and regression testing: JSON/JSONL export and golden-dataset construction.

## Requirements

### Requirement: Filtered export

The system SHALL export traces via `agent-replay export` in `json`, `jsonl`, or `golden` format, honoring filters (`--status`, `--tag`, `--agent`, `--since`) and optionally including evals (`--with-evals`) and snapshots (`--with-snapshots`), writing to `--output <file>` or stdout. Export processes at most 10,000 matching traces per invocation.

#### Scenario: Export completed traces as JSONL

- **WHEN** a user runs `agent-replay export --format jsonl --status completed --output good.jsonl`
- **THEN** each completed trace is written as one JSON line to the file

### Requirement: Golden dataset format

The system SHALL build golden datasets from known-good runs via `--format golden`: a JSON array of entries, each with `id`, `agent_name`, `input`, `expected_output` (the trace's recorded output), `steps_summary` (per step: `step_number`, `step_type`, `name`), `eval_criteria` (per stored eval: `evaluator_name`, `score`, `passed`), and `metadata` (trace metadata plus `status`, `total_duration_ms`, `total_tokens`, `tags`).

#### Scenario: Build a golden set

- **WHEN** a user runs `agent-replay export --format golden --tag production --output golden.json`
- **THEN** a golden dataset containing the production-tagged traces is written
