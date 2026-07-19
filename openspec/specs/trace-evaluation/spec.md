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
