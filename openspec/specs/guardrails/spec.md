# guardrails Specification

## Purpose

Define kill-switch policies that pattern-match trace steps and prescribe actions, and test them against recorded traces.

## Requirements

### Requirement: Policy management

The system SHALL manage guardrail policies via `agent-replay guard add|list|remove`, where each policy has a unique name, an action (`allow`, `deny`, `warn`, `require_review`), a priority, an enabled flag, and a JSON match pattern.

#### Scenario: Add a deny policy

- **WHEN** a user runs `agent-replay guard add --name no-deletes --pattern '{"step_type":"tool_call","name_contains":"delete"}' --action deny`
- **THEN** the policy is stored, enabled, and visible in `guard list`

### Requirement: Step match patterns

The system SHALL match steps against pattern fields — `step_type` (exact), `name_contains` (case-insensitive substring), `name_regex`, `input_contains`, `output_contains` — combining specified fields with AND logic. An empty pattern SHALL match nothing.

#### Scenario: AND semantics

- **WHEN** a pattern specifies both `step_type: tool_call` and `name_contains: delete`
- **THEN** only tool_call steps whose name contains "delete" match

### Requirement: Post-hoc policy testing

The system SHALL test all enabled policies against every step of a recorded trace via `agent-replay guard test <trace-id>`, reporting which policies matched which steps, in priority order, with human-readable match reasons.

#### Scenario: Test against a trace

- **WHEN** a user runs `agent-replay guard test <id>` on a trace containing a `delete_user` tool call and a `no-deletes` deny policy exists
- **THEN** the report flags that step with the policy name, action `deny`, and the match reason
