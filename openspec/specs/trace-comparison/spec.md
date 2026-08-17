# trace-comparison Specification

## Purpose

Understand behavioral change between runs: side-by-side diffing of two traces and what-if forking of a trace from any step.

## Requirements

### Requirement: Trace diff

The system SHALL compare two traces via `agent-replay diff <a> <b>`, pairing steps by `step_number` (a merge-join, so gaps and differing numbering never misalign the comparison) and comparing the fields `step_type`, `name`, `input`, `output`, `model`, `error`, and `decision`, plus the trace-level `trace_input`, `status`, `trace_error`, and `trace_output`. Input and output are compared as NORMALIZED JSON, so key order and whitespace never register as a difference. A step present on only one side is reported as `missing_left`/`missing_right`. `--fields` narrows the comparison to a named subset; a list naming no field at all is a usage error. The first step with any difference is the divergence step. Output modes: `--compact`, `--fields`, `--json`.

#### Scenario: Diverging traces

- **WHEN** two traces share steps 1–2 but differ in tool input at step 3
- **THEN** the diff reports divergence at step 3 with an `input` field diff, and step-count differences appear as missing-side entries

### Requirement: AI divergence analysis

The system SHALL, when `--ai` is passed and an API key is configured, produce an AI-generated explanation of why the two traces diverged.

#### Scenario: No API key

- **WHEN** `diff --ai` runs without any configured provider key
- **THEN** the deterministic diff still prints and a clear message explains how to configure a key

### Requirement: Trace forking

The system SHALL fork a trace at a step via `agent-replay fork <id> --from-step N`, copying steps 1..N (including their snapshots) into a new trace linked by `parent_trace_id` and `forked_from_step`. The fork starts in status `running` with trigger `manual`, ready for continuation. `--modify-input` replaces the trace input; `--modify-context` replaces the snapshot **context window** at the fork-point step only (earlier steps keep their original snapshots), creating a snapshot there if the step had none; `--tag` tags the fork.

#### Scenario: Fork with modified input

- **WHEN** a user runs `agent-replay fork <id> --from-step 2 --modify-input '{"task":"revised"}'`
- **THEN** a new trace is created containing steps 1–2 with the modified input recorded, linked to the original
