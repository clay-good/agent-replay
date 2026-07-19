# harness-run Specification

## Purpose
Even with live capture, agent-replay only observes. Guardrail policies exist but can only be tested against traces after the damage is done, and golden datasets can be exported but nothing consumes them. To be a harness, agent-replay must be able to wrap an agent run end-to-end, enforce policies at the moment a dangerous step is attempted, and turn recorded runs into repeatable regression checks.
## Requirements
### Requirement: Wrapped agent execution

The system SHALL run an agent process under supervision via `agent-replay run [options] -- <command>`, pre-creating a trace and exposing the recording channel to the child through environment variables (`AGENT_REPLAY_DIR`, `AGENT_REPLAY_TRACE_ID`, `AGENT_REPLAY_EVENTS`), consuming JSONL events the child emits on that channel, and finalizing the trace from the child's exit: exit 0 → `completed`, non-zero → `failed` with the exit code recorded.

#### Scenario: Instrumented agent run

- **WHEN** a user runs `agent-replay run --agent-name my-bot -- node agent.js` and the agent emits step events via the SDK
- **THEN** a single trace records the full run, and the trace status reflects the process outcome

#### Scenario: Exit status propagation

- **WHEN** the wrapped command exits with code 3
- **THEN** the trace is finalized as `failed` and `agent-replay run` itself exits with code 3

### Requirement: Transparent supervision

The system SHALL pass the child's stdin, stdout, and stderr through unmodified, and SHALL still record a minimal trace (start, end, duration, exit metadata) for children that emit no events.

#### Scenario: Uninstrumented agent

- **WHEN** a command that knows nothing about agent-replay is wrapped
- **THEN** its terminal behavior is unchanged and a trace with timing and exit status is still recorded

