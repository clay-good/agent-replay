# harness-run Specification

## Purpose
Even with live capture, agent-replay only observes. Guardrail policies exist but can only be tested against traces after the damage is done, and golden datasets can be exported but nothing consumes them. To be a harness, agent-replay must be able to wrap an agent run end-to-end, enforce policies at the moment a dangerous step is attempted, and turn recorded runs into repeatable regression checks.
## Requirements
### Requirement: Wrapped agent execution

The system SHALL run an agent process under supervision via `agent-replay run [options] -- <command>`, pre-creating a trace and exposing the recording channel to the child through environment variables (`AGENT_REPLAY_DIR`, `AGENT_REPLAY_TRACE_ID`, `AGENT_REPLAY_EVENTS`), consuming JSONL events the child emits on that channel, and finalizing the trace from the child's exit: exit 0 → `completed`, non-zero → `failed` with the exit code recorded. A child that declares its own TERMINAL status in a `trace_end` event owns the outcome and that status is kept whatever the exit code; a status the store cannot record does not count as a declaration, so the exit code still decides. A child killed by a signal exits `128 + signal` with the signal named in the trace error.

#### Scenario: Instrumented agent run

- **WHEN** a user runs `agent-replay run --agent-name my-bot -- node agent.js` and the agent emits step events via the SDK
- **THEN** a single trace records the full run, and the trace status reflects the process outcome

#### Scenario: Exit status propagation

- **WHEN** the wrapped command exits with code 3
- **THEN** the trace is finalized as `failed` and `agent-replay run` itself exits with code 3

### Requirement: Run invocation and labelling

The system SHALL refuse `run` with no command as a usage error (exit `2`), without creating a trace. It SHALL accept `--agent-name`, `--tags` (comma-separated, blank entries dropped) and `--dir`. A blank `--agent-name` SHALL NOT refuse the run — the child process is the user's real work, and losing it over a label is the worse outcome — but SHALL fall back to the command name and say that it did, so the trace does not quietly carry a name nobody chose.

#### Scenario: No command given

- **WHEN** a user runs `agent-replay run` with nothing after `--`
- **THEN** it prints the usage line, exits `2`, and no trace is created

### Requirement: Honest reporting of the recorded run

The system SHALL end a wrapped run with a summary naming the trace, the status the trace was actually STORED with, and how many events it recorded. When the stored status and the child's exit code disagree — a child that declared `completed` and then crashed during shutdown — the summary SHALL name both rather than hide either. The trace id SHALL be printed as a leading prefix that the other commands resolve, since this is the only pointer to the run at the moment it finishes.

Every event the wrapper could not record SHALL be counted and reported in that summary, whether the protocol REJECTED the line (bad JSON, unknown type, a missing `trace_id`) or the store refused it. The stderr warning alone is not the durable record: this wrapper passes the child's own output through unmodified, so a warning is interleaved with the agent's output while the summary is the last thing printed. A blank or `//` comment line is legal protocol and is not a loss, and neither is an event validation KEPT while ignoring one unusable field.

#### Scenario: A child emits malformed events

- **WHEN** a wrapped child writes lines the protocol rejects
- **THEN** the summary reports how many events could not be recorded, instead of reporting only that zero were recorded

### Requirement: Append-only event channel

The system SHALL treat the recording channel as append-only and SHALL detect a producer that rewrites or truncates it — by a shrink in size, or by a change in the file's opening bytes when a rewrite happens to be at least as long as what was already consumed. On detection it SHALL say so, name the append-only contract, and resume from the new end, rather than reading on at a stale offset and dropping every later event silently at exit `0`.

#### Scenario: Channel opened with 'w' instead of 'a'

- **WHEN** a child reopens the events file truncating and writes fresh events
- **THEN** the wrapper reports that the channel was rewritten and continues reading from the new end

### Requirement: Transparent supervision

The system SHALL pass the child's stdin, stdout, and stderr through unmodified, and SHALL still record a minimal trace (start, end, duration, exit metadata) for children that emit no events.

#### Scenario: Uninstrumented agent

- **WHEN** a command that knows nothing about agent-replay is wrapped
- **THEN** its terminal behavior is unchanged and a trace with timing and exit status is still recorded

