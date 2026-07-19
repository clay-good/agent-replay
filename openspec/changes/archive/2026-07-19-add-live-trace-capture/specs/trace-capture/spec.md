# trace-capture Delta

## ADDED Requirements

### Requirement: Event-stream recording

The system SHALL accept a versioned JSONL event stream on stdin via `agent-replay record`, with native event types `trace_start`, `step_start`, `step_end`, `step`, `decision`, `snapshot`, and `trace_end`, writing traces incrementally so they are queryable while still `running`. Unknown event types or fields SHALL be skipped with a warning rather than aborting the stream.

#### Scenario: Incremental capture

- **WHEN** an agent pipes `trace_start` followed by three `step` events into `agent-replay record`
- **THEN** the trace exists with status `running` and three steps before `trace_end` arrives

#### Scenario: Finalization on trace_end

- **WHEN** a `trace_end` event with status `completed` and totals arrives
- **THEN** the trace is marked `completed` with output, timing, and token/cost totals recorded

#### Scenario: Stream ends without trace_end

- **WHEN** stdin reaches EOF while a trace is still open and `--leave-open` was not passed
- **THEN** the trace is finalized with status `timeout` so it cannot dangle silently

### Requirement: Native harness stream dialects

The system SHALL translate the documented non-interactive event streams of the major CLIs via `record --format`: `codex-exec` for OpenAI Codex CLI's `codex exec --json` stream (`thread.started` with `thread_id` → trace with `session_id`; `item.completed` items such as `agent_message`, `reasoning`, `command_execution`, `mcp_tool_call`, `file_change`, `web_search` → typed steps; `turn.completed` `usage` → token totals) and `gemini-stream` for Gemini CLI's `--output-format stream-json` (`init` → trace; `tool_use`/`tool_result` → tool_call steps; `message` → output steps; `result` → finalization).

#### Scenario: Codex exec run captured

- **WHEN** a user runs `codex exec --json "fix the tests" | agent-replay record --format codex-exec`
- **THEN** one trace is recorded whose `session_id` is the Codex thread ID, with `command_execution` items stored as `tool_call` steps and `turn.completed` usage stored as token totals

#### Scenario: Gemini headless run captured

- **WHEN** a user pipes `gemini -p "..." --output-format stream-json` into `agent-replay record --format gemini-stream`
- **THEN** tool_use/tool_result pairs become completed `tool_call` steps and the `result` event finalizes the trace

### Requirement: Long-running step timing

The system SHALL support paired `step_start`/`step_end` events matched by `step_number`, recording real start/end timestamps and computing duration, so long tool and LLM calls carry true runtime timing.

#### Scenario: Paired step events

- **WHEN** `step_start` for step 2 arrives and `step_end` for step 2 arrives 800ms later with the tool output
- **THEN** step 2 stores both timestamps, the output, and a duration of ~800ms

### Requirement: Recorder SDK

The system SHALL export a `TraceRecorder` programmatic API (`startTrace`, `startStep`, `endStep`, `step`, `decision`, `snapshot`, `endTrace`) from the library entry point, producing traces equivalent to the event stream without an intermediate file.

#### Scenario: Programmatic recording

- **WHEN** a TypeScript agent calls `startTrace`, records two steps, and calls `endTrace`
- **THEN** the resulting stored trace is identical in shape to one built from the equivalent JSONL events

### Requirement: Hook-convention adapter

The system SHALL provide `agent-replay hook [event]`, a stateless adapter for the stdin-JSON hook convention shared by Claude Code, OpenAI Codex CLI, Gemini CLI, and compatible harnesses, auto-detecting the dialect from the payload's `hook_event_name`. It SHALL map, per session (correlated by the `session_id` field present in every dialect's payload): `UserPromptSubmit`/`BeforeAgent` → open the session's trace and record the prompt as input; `PreToolUse`/`BeforeTool` (fields `tool_name`, `tool_input`) → open a `tool_call` step; `PostToolUse`/`AfterTool` (result field: `tool_output` in Claude Code, `tool_response` in Codex CLI and Gemini CLI — both accepted) and `PostToolUseFailure` (Claude Code; sets step error) → close it; `SubagentStart`/`SubagentStop` (fields `agent_type`, `agent_id`, and in Claude Code `depth`, `parent_session_id`) → open/close a nesting anchor step, with tool events parented to the anchor matching the `agent_id` their payload carries (Claude Code includes `agent_id`/`agent_type` on events firing inside a subagent) rather than by ordering alone; `Stop`/`AfterAgent`/`SessionEnd` → finalize the trace. Raw payloads SHALL be preserved in step metadata, and in capture mode the adapter SHALL always exit 0 and write nothing to stdout — in these harnesses exit code 2 blocks the pending action and stdout JSON is interpreted as a hook decision, so capture must emit neither.

#### Scenario: Claude Code session becomes a trace

- **WHEN** a Claude Code session fires UserPromptSubmit, then PreToolUse/PostToolUse for tool `Bash`, then Stop, each invoking `agent-replay hook` with the documented payloads
- **THEN** one trace exists whose `session_id` is the Claude Code session UUID, containing a completed `tool_call` step named `Bash` with real start/end timing

#### Scenario: Gemini dialect auto-detected

- **WHEN** the adapter receives a payload with `hook_event_name: "BeforeTool"` and Gemini base fields
- **THEN** it applies the Gemini mapping without any dialect flag

#### Scenario: Subagent activity nested

- **WHEN** SubagentStart (agent_id `a1`, agent_type `Explore`) is followed by two tool events whose payloads carry `agent_id: "a1"`, then SubagentStop
- **THEN** the two tool_call steps are parented under the subagent anchor step, which carries `agent_id`, `agent_type`, and `depth` in metadata

#### Scenario: Hook process failure is silent to the host

- **WHEN** the database is locked or missing during a hook invocation
- **THEN** the adapter logs to stderr and exits 0, and the host agent proceeds unaffected

### Requirement: Native session-log import

The system SHALL import existing on-disk session logs via `agent-replay import <path> --format claude-transcript|codex-rollout`: Claude Code transcript JSONL (`user`/`assistant`/`system` records; `tool_use`/`tool_result` content blocks paired by `tool_use_id` become `tool_call` steps; `thinking` blocks become `thought` steps; `usage` fields aggregate to token totals; subagent transcript files under `<session>/subagents/` import as child-anchored steps or linked traces) and Codex CLI rollout JSONL (`session_meta` → trace identity including git branch/sha metadata; `response_item` records with `function_call`/`function_call_output` paired by `call_id` → `tool_call` steps; `reasoning` → `thought`; `compacted` → metadata). Because both vendors declare these formats internal and version-unstable, the importer SHALL be best-effort: unrecognized records are skipped and counted, the report states how many records were imported versus skipped, and the source format/version is stamped in trace metadata.

#### Scenario: Import a Claude Code transcript

- **WHEN** a user runs `agent-replay import ~/.claude/projects/myproj/3f2a….jsonl --format claude-transcript`
- **THEN** a trace is created with the transcript's `sessionId` as `session_id`, tool_use/tool_result pairs as completed `tool_call` steps, and aggregated token usage

#### Scenario: Unknown records tolerated

- **WHEN** a transcript from a newer Claude Code version contains record types the importer does not recognize
- **THEN** the import completes, reports the skipped-record count, and does not fabricate steps for unknown records

### Requirement: Concurrent access

The system SHALL open the database in WAL mode with a busy timeout so that short-lived hook writers, a long-running recorder, and concurrent readers (watch, dashboard) can operate on the same store without corruption.

#### Scenario: Reader during live capture

- **WHEN** `agent-replay watch` reads while `record` is writing steps
- **THEN** both proceed without `SQLITE_BUSY` errors
