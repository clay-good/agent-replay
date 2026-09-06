# trace-comparison Specification

## Purpose

Understand behavioral change between runs: side-by-side diffing of two traces and what-if forking of a trace from any step.

## Requirements

### Requirement: Trace diff

The system SHALL compare two traces via `agent-replay diff <a> <b>`, pairing steps by `step_number` (a merge-join, so gaps and differing numbering never misalign the comparison) and comparing the fields `step_type`, `name`, `input`, `output`, `model`, `error`, and `decision`, plus the trace-level `trace_input`, `status`, `trace_error`, and `trace_output`. Input and output are compared as NORMALIZED JSON, so key order and whitespace never register as a difference. A step present on only one side is reported as `missing_left`/`missing_right`. `--fields` narrows the comparison to a named subset; a list naming no field at all is a usage error. The first step with any difference is the divergence step. When EVERY step-level difference is a step missing from the same side — one trace's steps are a prefix of the other's — the result SHALL report that the shorter trace STOPPED rather than that the two diverged, in the human view and as a `common_prefix` object (`shorter`, `last_common_step`, `missing_steps`) in `--json`, present only in that case. A fresh fork and a run that crashed early are both this shape, and `fork` prints the `diff` command that produces it, so "DIVERGES AT STEP 3" over a table of one-sided rows was the first thing a user was told about two traces that never disagreed. Output modes: `--compact`, `--fields`, `--json`. The `--json` document SHALL record what was compared in a `compared_fields` key — written on every run, `null` when unnarrowed — so a narrowed result is never byte-for-byte the shape of a full one. `--compact` selects a summary panel over the full rendered comparison and so shapes the human view alone; passing it with `--json` SHALL say it did nothing, on stderr, leaving the document on stdout untouched.

#### Scenario: Diverging traces

- **WHEN** two traces share steps 1–2 but differ in tool input at step 3
- **THEN** the diff reports divergence at step 3 with an `input` field diff, and step-count differences appear as missing-side entries

#### Scenario: A fork that has not been explored yet

- **WHEN** a trace is diffed against a fork of itself, which stops at the forked step
- **THEN** the verdict says the fork stops after that step and is identical up to there, and `--json` carries `common_prefix`

### Requirement: AI divergence analysis

The system SHALL, when `--ai` is passed and an API key is configured, produce an AI-generated explanation of why the two traces diverged.

The analysis SHALL be resolved before a `--json` document is written, so `--ai --json` answers in the requested shape rather than dropping the flag: the document carries an `ai_analysis` key, and a misconfiguration that exits 1 interactively SHALL exit 1 in automation too, as a refusal document, rather than exiting 0 with a null analysis.

#### Scenario: No API key

- **WHEN** `diff --ai` runs without any configured provider key
- **THEN** the deterministic diff still prints and a clear message explains how to configure a key, at exit 1
- **WHEN** the same command runs with `--json`
- **THEN** stdout is a single `{ ok: false, error, hints }` refusal document at exit 1, not a diff document with a null analysis

An AI comparison whose summary carried only part of the divergences SHALL report how many it was formed over, in the returned analysis and in the rendered panel — the summary tells the model the rest exist, and the reader is owed the same.

A comparison that finds nothing SHALL report what it compared rather than that the traces are identical: the diff covers each step's type, name, input, output, model, error and decision plus the trace's input, status and error, and state snapshots are outside it — two traces differing only in their context window are not identical, and saying so sends the reader away from the difference they came for. The message SHALL name where the uncompared data can be read.

### Requirement: Trace forking

The system SHALL fork a trace at a step via `agent-replay fork <id> --from-step N`, copying steps 1..N (including their snapshots) into a new trace linked by `parent_trace_id` and `forked_from_step`. The fork starts in status `running` with trigger `manual`, ready for continuation. `--modify-input` replaces the trace input; `--modify-context` replaces the snapshot **context window** at the fork-point step only (earlier steps keep their original snapshots), creating a snapshot there if the step had none; `--tag` tags the fork.

#### Scenario: Fork with modified input

- **WHEN** a user runs `agent-replay fork <id> --from-step 2 --modify-input '{"task":"revised"}'`
- **THEN** a new trace is created containing steps 1–2 with the modified input recorded, linked to the original
