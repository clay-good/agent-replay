# trace-inspection Delta

## ADDED Requirements

### Requirement: Live trace watch

The system SHALL live-tail a running trace via `agent-replay watch [trace-id]`, rendering new steps as they are written; with no trace ID given, it SHALL follow the most recently started `running` trace, and it SHALL announce final status when the trace completes.

#### Scenario: Tail a running trace

- **WHEN** a user runs `agent-replay watch` while an agent records steps
- **THEN** each new step appears in order shortly after it is written, and the watch reports the trace's final status on completion

### Requirement: Abandoned trace flagging

The system SHALL flag traces still in status `running` past a staleness threshold in `list` output, so crashed or dangling captures are visible.

#### Scenario: Stale running trace

- **WHEN** a trace has been `running` for longer than the staleness threshold
- **THEN** `agent-replay list` marks it as possibly abandoned
