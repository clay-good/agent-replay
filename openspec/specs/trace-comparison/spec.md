# trace-comparison Specification

## Purpose

Understand behavioral change between runs: side-by-side diffing of two traces and what-if forking of a trace from any step.

## Requirements

### Requirement: Trace diff

The system SHALL compare two traces via `agent-replay diff <a> <b>`, pairing steps by position and comparing exactly the fields `step_type`, `name`, `input`, and `output` (input/output compared as their stored JSON text, so key order matters); unpaired trailing steps are reported as `missing_left`/`missing_right`. The first step with any difference is the divergence step. Output modes: `--compact`, `--fields`, `--json`.

#### Scenario: Diverging traces

- **WHEN** two traces share steps 1–2 but differ in tool input at step 3
- **THEN** the diff reports divergence at step 3 with an `input` field diff, and step-count differences appear as missing-side entries

### Requirement: AI divergence analysis

The system SHALL, when `--ai` is passed and an API key is configured, produce an AI-generated explanation of why the two traces diverged.

#### Scenario: No API key

- **WHEN** `diff --ai` runs without any configured provider key
- **THEN** the deterministic diff still prints and a clear message explains how to configure a key

### Requirement: Trace forking

The system SHALL fork a trace at a step via `agent-replay fork <id> --from-step N`, copying steps 1..N (including their snapshots) into a new trace linked by `parent_trace_id` and `forked_from_step`. The fork starts in status `running` with trigger `manual`, ready for continuation. `--modify-input` replaces the trace input; `--modify-context` replaces the snapshot environment at the fork-point step only (earlier steps keep their original snapshots); `--tag` tags the fork.

#### Scenario: Fork with modified input

- **WHEN** a user runs `agent-replay fork <id> --from-step 2 --modify-input '{"task":"revised"}'`
- **THEN** a new trace is created containing steps 1–2 with the modified input recorded, linked to the original
