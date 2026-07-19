# trace-evaluation Specification

## Purpose

Score trace quality automatically: deterministic rubric presets, custom rubrics, and AI-powered judges (root cause, quality, security, optimization) with cost budgets.
## Requirements
### Requirement: Deterministic eval presets

The system SHALL provide built-in deterministic presets — `hallucination-check`, `safety-check`, `completeness-check` — runnable via `agent-replay eval <id> --preset <name>` or all at once with `--all`, each producing a weighted score, pass/fail against a threshold, and stored details.

#### Scenario: Run all deterministic checks

- **WHEN** a user runs `agent-replay eval <id> --all`
- **THEN** all three presets run without requiring an API key and results are persisted as eval records

### Requirement: Custom rubrics

The system SHALL evaluate traces against user-supplied YAML/JSON rubric files (`--rubric <file>`) containing pattern-based criteria with expected presence/absence, weights, and a pass threshold.

#### Scenario: Rubric evaluation

- **WHEN** a rubric with two weighted criteria is applied to a trace
- **THEN** the weighted score is computed and compared against the rubric threshold

### Requirement: AI-powered evaluation

The system SHALL provide AI presets (`ai-root-cause`, `ai-quality-review`, `ai-security-audit`, `ai-optimization`) using the configured provider's default cheap-tier model (currently `claude-haiku-4-5-20251001`, `gemini-2.0-flash`, `gpt-4o-mini` per provider), honoring a `--max-cost` budget in USD and failing gracefully when no key is configured.

#### Scenario: Cost budget exceeded

- **WHEN** an AI eval would exceed the `--max-cost` budget
- **THEN** the evaluation stops before the call and reports the budget constraint

### Requirement: Eval result persistence

The system SHALL persist every evaluation as an eval record (evaluator type `rubric`, `llm_judge`, or `policy_check`; name; score; passed; details) attached to the trace and visible via `show --evals`.

#### Scenario: Results retrievable

- **WHEN** evaluations have run against a trace
- **THEN** `agent-replay show <id> --evals` lists each result with score and pass/fail

### Requirement: Golden regression check

The system SHALL compare traces against a golden dataset via `agent-replay check --golden <file>`, matching candidate traces to golden traces by agent name and input hash, diffing on a structural field allowlist (step count, step types, step names, tool-call inputs, final status) rather than raw output text, and exiting non-zero with a divergence report when any matched trace regresses. `--fields` SHALL override the allowlist and `--json` SHALL emit the report as structured data.

#### Scenario: Regression detected in CI

- **WHEN** `agent-replay check --golden golden.json --agent travel-bot --since 1d` finds a trace whose tool-call sequence differs from its golden counterpart
- **THEN** the command exits non-zero and names the trace, the divergence step, and the differing fields

#### Scenario: Clean run passes

- **WHEN** all matched traces are structurally equivalent to their golden counterparts
- **THEN** the command exits 0 with a pass summary

#### Scenario: No golden match

- **WHEN** a candidate trace has no golden counterpart by agent name and input hash
- **THEN** it is reported as unmatched (not failed) unless `--strict` is passed

