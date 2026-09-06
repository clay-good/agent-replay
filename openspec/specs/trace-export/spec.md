# trace-export Specification

## Purpose

Get traces back out of the store for sharing, pipelines, and regression testing: JSON/JSONL export and golden-dataset construction.

## Requirements

### Requirement: Filtered export

The system SHALL export traces via `agent-replay export` in `json`, `jsonl`, or `golden` format, honoring filters (`--status`, `--tag`, `--agent`, `--agent-exact`, `--since`) and optionally including evals (`--with-evals`) and snapshots (`--with-snapshots`), writing to `--output <file>` or stdout. Export processes every matching trace: a fixed cap silently truncated large exports, which corrupts a golden or JSONL dataset built from them. Because a `json`/`jsonl` export is a BACKUP, its document SHALL restore as one: `ingest` reads back both the evals written by `--with-evals` and the per-step snapshots written by `--with-snapshots`, so neither flag is a no-op on the one path that consumes its output.

#### Scenario: Export completed traces as JSONL

- **WHEN** a user runs `agent-replay export --format jsonl --status completed --output good.jsonl`
- **THEN** each completed trace is written as one JSON line to the file

### Requirement: Golden dataset format

The system SHALL build golden datasets from known-good runs via `--format golden`: a JSON array of entries, each with `id`, `agent_name`, `input`, `expected_output` (the trace's recorded output), `steps_summary` (per step: `step_number`, `step_type`, `name`, `failed`, plus `input` for a tool call and `model` when recorded), `eval_criteria` (per stored eval: `evaluator_name`, `score`, `passed`), and `metadata` (trace metadata plus `status`, `total_duration_ms`, `total_tokens`, `tags`). `--agent` is a SUBSTRING match and `--agent-exact` names one agent; they SHALL be mutually exclusive, and a golden baseline SHOULD be scoped with the exact form, since `--agent checkout` also writes `checkout-v2`'s runs into a file every later `check` gates on — the reason `check` has carried `--agent-exact`, at the command that reads baselines rather than the one that writes them. A golden dataset is built from RUNS, so forked traces SHALL be excluded from it: a fork is a never-executed copy of a step prefix, and a baseline holding one lets a real run that stopped early reproduce its shorter shape and pass. `json` and `jsonl` exports are backups and SHALL still carry forks. Of these fields, the regression gate compares only `agent_name` and `input` (together the match key), `steps_summary`, and `metadata.status`; `expected_output` and `eval_criteria` are carried for downstream consumers and human review and SHALL NOT be interpreted as assertions the gate checks. Removing `metadata` therefore breaks a baseline (`check` refuses an entry with no `metadata.status`), while removing the two carried fields does not.

#### Scenario: Build a golden set

- **WHEN** a user runs `agent-replay export --format golden --tag production --output golden.json`
- **THEN** a golden dataset containing the production-tagged traces is written

#### Scenario: A baseline for one agent among lookalikes

- **WHEN** a store holds `checkout` and `checkout-v2` runs and a user exports a golden baseline with `--agent-exact checkout`
- **THEN** only `checkout`'s runs are written, where `--agent checkout` would have written both
