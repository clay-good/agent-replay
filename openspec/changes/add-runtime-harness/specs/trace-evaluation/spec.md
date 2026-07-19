# trace-evaluation Delta

## ADDED Requirements

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
