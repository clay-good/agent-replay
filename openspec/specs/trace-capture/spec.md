# trace-capture Specification

## Purpose

Get agent execution data into the local SQLite store: batch ingestion of trace files, validation, and the canonical trace/step data model.
## Requirements
### Requirement: Batch trace ingestion

The system SHALL ingest traces from JSON files (single trace or array) and JSONL files (one trace per line) via `agent-replay ingest <file>`, auto-detecting the format when `--format` is omitted. Validation checks: `agent_name` present and a string; `status`/`trigger`/`step_type` within their enums; numeric totals finite and non-negative; `tags` an array of strings; step `step_number` a positive integer and step `name` present. A trace MAY carry `evals` (the shape `export --with-evals` writes), each validated for `evaluator_type` within its enum, a non-empty `evaluator_name`, a finite `score`, a boolean `passed`, an object `details`, and a parseable `evaluated_at`; they SHALL be restored with their own `evaluated_at` rather than the time of the import, since the column otherwise defaults to now and silently re-dates the evaluation. A file whose entries carry `steps_summary` instead of `steps` is a golden dataset rather than a trace export, and SHALL be refused (exit 2) naming `check --golden` and `--format json`: such entries validate (they have `agent_name` and `input`) and would otherwise be stored as traces with no steps, which read as real runs and are then carried into any golden dataset exported afterwards. A trace whose `steps` is legitimately empty SHALL still ingest. Each trace is inserted in a single transaction.

#### Scenario: Ingest a JSON trace file

- **WHEN** a user runs `agent-replay ingest trace.json`
- **THEN** the trace and its steps are validated and inserted into the database
- **AND** the assigned trace ID is printed

#### Scenario: Dry-run validation

- **WHEN** a user runs `agent-replay ingest trace.json --dry-run`
- **THEN** the file is validated and errors are reported without inserting anything

#### Scenario: Tagging at ingest

- **WHEN** a user runs `agent-replay ingest trace.json --tags production,v2`
- **THEN** both tags are added to every ingested trace

### Requirement: Canonical trace data model

The system SHALL store traces with agent identity, trigger, status (`running`, `completed`, `failed`, `timeout`), input/output payloads, timing, token and cost totals, error, tags, metadata, fork lineage (`parent_trace_id`, `forked_from_step`), and an optional `session_id` correlation key. Only `agent_name` is required at ingest; when `status` is omitted it defaults to `completed` if `ended_at` is present and `running` otherwise. Trace IDs are generated as `trc_<nanoid>`. A capture producer MAY supply its own id, but it SHALL be an identifier: a non-empty string with no control characters. This is enforced at the WRITE, so no route can store one — an id is rendered by nearly every read command and copied into `parent_trace_id` by `fork`, so one carrying an escape sequence would address the terminal of whoever later inspects the trace, and an empty one would produce a trace no later event can reach.

#### Scenario: Minimal trace accepted

- **WHEN** a trace containing only `agent_name` is ingested
- **THEN** it is accepted with status `running` (no `ended_at` was given), a defaulted `started_at`, and empty payloads

#### Scenario: Session key persisted

- **WHEN** a trace with `session_id: "conv-42"` is ingested
- **THEN** the session key is stored and usable as a list filter

### Requirement: Step model

The system SHALL store ordered steps per trace with a `step_type` from: `thought`, `tool_call`, `llm_call`, `retrieval`, `output`, `decision`, `error`, `guard_check`; each step carries name, input/output, timing, tokens, model, error, and metadata, plus optional structural fields: `parent_step` (hierarchy) and `caused_by_step` (causality), both step-number references to strictly earlier steps in the same trace. A step of ANY type MAY carry a structured decision record: the live recorder attaches one to whatever step made the choice, and every reader honors that. Step numbers SHALL be positive integers, unique within a trace — enforced both by pre-validation, so `ingest --dry-run` cannot pass a file the real run would reject, and by the database constraint `UNIQUE(trace_id, step_number)`.

#### Scenario: Duplicate step number rejected

- **WHEN** an ingested trace contains two steps with the same `step_number`
- **THEN** validation rejects it naming the duplicated step number, nothing from that trace is stored, and the error is reported

#### Scenario: Flat v1 trace remains valid

- **WHEN** a trace without any `parent_step`, `caused_by_step`, `decision`, or `session_id` fields is ingested
- **THEN** it is accepted unchanged, with the new fields stored as NULL

### Requirement: State snapshots

The system SHALL accept an optional snapshot per step capturing `context_window`, `environment`, `tool_state`, and `token_count`, stored for later inspection.

#### Scenario: Step with snapshot

- **WHEN** a step includes a `snapshot` object at ingest
- **THEN** the snapshot is persisted and retrievable via `show --snapshots`

### Requirement: Event-stream recording

The system SHALL accept a versioned JSONL event stream on stdin via `agent-replay record`, with native event types `trace_start`, `step_start`, `step_end`, `step`, `decision`, `snapshot`, and `trace_end`, writing traces incrementally so they are queryable while still `running`. Unknown event TYPES SHALL be skipped with a warning rather than aborting the stream; unknown FIELDS SHALL be ignored silently, so a newer producer's extra keys cost nothing. A usage or timing field that is not a non-negative finite number SHALL be dropped with a warning while the rest of the event is kept, since `ingest` refuses such a value and the trace would otherwise be unrestorable from its own export. For the same reason, a decision's `options` SHALL be held to exactly the rule `ingest` applies — each option an object with a non-empty string `option` and, if present, a finite `score` — from one shared check rather than a second copy that could drift.

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

The system SHALL record, on the steps a translated stream produces, the model any record of that stream names — read from the record, its `item`, or its `session` — tracking it as a running value so a session that changes model mid-run labels each step with the model in effect at its own time. A stream that names no model SHALL leave the field unset rather than guessing one.

The system SHALL record a codex tool item's arguments as its step's input — a shell `command`, or the `arguments`/`input` an MCP or custom tool call carries, parsed when they are JSON and preserved verbatim when they are not.

#### Scenario: MCP tool call arguments recorded

- **WHEN** a `codex-exec` stream reports an `mcp_tool_call` item carrying JSON `arguments`
- **THEN** the step records those arguments as its input, so `diff` reports a changed tool query

#### Scenario: Model carried onto a translated stream's steps

- **WHEN** a `codex-exec` stream declares a model on `thread.started` and later items produce steps
- **THEN** each of those steps records that model, and steps after a record naming a different model record the new one

#### Scenario: A stream that names no model

- **WHEN** a translated stream never names a model
- **THEN** every step it produces records no model, and `check --golden --fields model` skips those baseline steps rather than comparing an invented value

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

The system SHALL provide `agent-replay hook [event]`, a stateless adapter for the stdin-JSON hook convention shared by Claude Code, OpenAI Codex CLI, Gemini CLI, and compatible harnesses, auto-detecting the dialect from the payload's `hook_event_name`. It SHALL map, per session (correlated by the `session_id` field present in every dialect's payload): `UserPromptSubmit`/`BeforeAgent` → open the session's trace and record the prompt as input; `PreToolUse`/`BeforeTool` (fields `tool_name`, `tool_input`) → open a `tool_call` step; `PostToolUse`/`AfterTool` (result field: `tool_output` in Claude Code, `tool_response` in Codex CLI and Gemini CLI — both accepted) and `PostToolUseFailure` (Claude Code; sets step error) → close it; `SubagentStart`/`SubagentStop` (fields `agent_type`, `agent_id`, and in Claude Code `depth`, `parent_session_id`) → open/close a nesting anchor step, with tool events parented to the anchor matching the `agent_id` their payload carries (Claude Code includes `agent_id`/`agent_type` on events firing inside a subagent) rather than by ordering alone; `Stop`/`AfterAgent`/`SessionEnd` → finalize the trace. A CLOSING event (`PostToolUse`/`AfterTool`, `PostToolUseFailure`, `SubagentStop`) finishes work an earlier event started, so it SHALL NOT create a trace, and it SHALL resolve to the session's trace whatever that trace's status — preferring one that holds a matching open step, since `session_id` is not exclusive to this path. Each hook fires as its own process, so a result arriving after the turn-ending event is the normal case, not an error: it is recorded on the finalized trace rather than discarded into a newly created one. Routing SHALL prefer the payload's own `hook_event_name`, falling back to the event named on the command line when the payload's is one the adapter cannot route — otherwise an unmodelled event name silently bypasses every enforcement gate. Raw payloads SHALL be preserved in step metadata, and in capture mode the adapter SHALL always exit 0 and write nothing to stdout — in these harnesses exit code 2 blocks the pending action and stdout JSON is interpreted as a hook decision, so capture must emit neither.

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

The system SHALL import existing on-disk session logs via `agent-replay import <path> --format claude-transcript|codex-rollout`: Claude Code transcript JSONL (`user`/`assistant`/`system` records; `tool_use`/`tool_result` content blocks paired by `tool_use_id` become `tool_call` steps; `thinking` blocks become `thought` steps; each assistant record's `model` is recorded on EVERY step that record produced — its tool calls and thinking as well as its message — since all of them were produced by that model; `usage` fields aggregate to token totals, including the cache sub-counts, which carry the bulk of a real session's consumption; subagent transcript files under `<session>/subagents/` import as child-anchored steps or linked traces) and Codex CLI rollout JSONL (`session_meta` → trace identity including git branch/sha metadata; `response_item` records with `function_call`/`function_call_output` AND `custom_tool_call`/`custom_tool_call_output`, each paired by `call_id` → `tool_call` steps, with a non-zero exit code or an explicit failure in the paired output recorded as the step's error; `reasoning` → `thought`; `turn_context` → the model in force for that turn, recorded on every step of the turn (a rollout may switch models mid-session, so it is read per turn rather than once per session); `compacted` → metadata; `token_count` → the session's token total, taken from the last such record because the figure is cumulative). Records wrapped in either `response_item` or `event_msg` SHALL be unwrapped to their inner type. Because both vendors declare these formats internal and version-unstable, the importer SHALL be best-effort: unrecognized records are skipped and counted, the report states how many records were imported versus skipped, and the source format/version is stamped in trace metadata.

Importing SHALL be idempotent: a session already in the store is reported and left unchanged, and `--replace` re-imports it. A session's identity SHALL be its session id, source format and source filename together — a subagent sidecar shares its parent transcript's session id, so the filename is required to tell them apart. The first user turn SHALL become the trace input and later turns SHALL be retained in `metadata.follow_up_prompts`, with any harness preamble preceding the chosen prompt retained in `metadata.preamble_prompts`; the prompt SHALL be the first turn that is not a harness envelope. The trace's `ended_at` SHALL be taken from the last timestamped record. Each STEP SHALL carry the timestamp of the record that produced it, and a record carrying none SHALL inherit the last timestamp seen, seeded with the trace's own start — the store defaults an absent step timestamp to the current time, which would place an imported session's steps outside the window of the trace they belong to. Step DURATIONS SHALL NOT be inferred from the interval between records, which includes time the user was away and is not a measurement of the step. Transcripts SHALL be read incrementally rather than loaded whole, so peak memory tracks the trace being built rather than the file size, and a single line exceeding 64 MB SHALL be refused as not being JSONL.

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

