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

The system SHALL translate the documented non-interactive event streams of the major CLIs via `record --format`: `claude-stream` for Claude Code's `--output-format stream-json` (`system`/`init` → trace with `session_id`; `assistant` content blocks → `text` output steps, `thinking` thought steps and `tool_use` tool_call steps; `user` `tool_result` blocks → those steps' output and, when `is_error`, their error; `result` → finalization, carrying `total_cost_usd` onto the trace, with a non-success subtype failing the trace), `codex-exec` for OpenAI Codex CLI's `codex exec --json` stream (`thread.started` with `thread_id` → trace with `session_id`; `item.completed` items such as `agent_message`, `reasoning`, `command_execution`, `mcp_tool_call`, `file_change`, `web_search` → typed steps; `turn.completed` `usage` → token totals) and `gemini-stream` for Gemini CLI's `--output-format stream-json` (`init` → trace; `tool_use`/`tool_result` → tool_call steps; `message` → output steps; `result` → finalization).

The system SHALL record, on the steps a translated stream produces, the model any record of that stream names — read from the record, its `item`, or its `session` — tracking it as a running value so a session that changes model mid-run labels each step with the model in effect at its own time. A stream that names no model SHALL leave the field unset rather than guessing one.

The system SHALL accept `record --agent-name <name>`, recording it as the agent name of every trace the stream opens, overriding the name the stream reports. A blank value SHALL fall back to the stream's own name with a warning rather than storing an empty name.

#### Scenario: Labelling a translated capture

- **WHEN** a user pipes a codex stream into `record --format codex-exec --agent-name nightly-refactor`
- **THEN** the trace is recorded under that name instead of `codex`

The system SHALL accept `record --input <text>`, recording it as the prompt of any trace the stream opens without an input of its own, so a capture in a format whose harness takes its prompt on the command line can be matched by `check --golden`. A blank value SHALL be treated as absent, and an input the producer sent SHALL NOT be overridden.

#### Scenario: Prompt supplied for a translated stream

- **WHEN** a user pipes a harness stream into `record --format codex-exec --input "fix the tests"`
- **THEN** the trace records `{"prompt": "fix the tests"}` as its input and `check --golden` can match it

#### Scenario: A producer's own input wins

- **WHEN** a native stream's `trace_start` carries an input and `--input` is also given
- **THEN** the producer's input is stored unchanged

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

The system SHALL, when a translated capture records nothing, name the `--format` that reads the records it saw — and SHALL stay silent when those records belong to no single format, rather than suggesting one that would also capture nothing.

#### Scenario: The wrong format was piped in

- **WHEN** a Claude Code stream is piped into `record --format codex-exec` and nothing is recorded
- **THEN** the failure names `claude-stream` as the format to try

#### Scenario: The records name no format

- **WHEN** the records seen belong to two of the supported streams, or to none
- **THEN** no format is suggested

#### Scenario: Claude Code headless run captured

- **WHEN** a user pipes `claude -p "..." --output-format stream-json` into `agent-replay record --format claude-stream`
- **THEN** one trace is recorded whose `session_id` is the Claude session id, with `tool_use`/`tool_result` pairs stored as `tool_call` steps carrying the result's failure on their error field, token totals that include both cache fields, and the cost the run reported

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

Importing SHALL be idempotent: a session already in the store is reported and left unchanged, and `--replace` re-imports it. `--replace` SHALL refuse when forks derive from the trace it would delete, and SHALL report how many stored evaluation results are destroyed with it — both hang off the trace and cascade with it, and the flag is the documented way to refresh a transcript that has grown, so the routine case is the one that loses them. Evaluations are reported rather than refused because they can be re-derived, and SHALL NOT be carried onto the refreshed trace, whose steps may differ from the ones they scored. A `step` capture event is a COMPLETE step — that is what distinguishes it from the `step_start`/`step_end` pair — so one that carries no `ended_at` SHALL be stored closed, at its own `started_at + duration_ms`, or at the instant it is recorded when the producer timed neither. Both ends SHALL read the same instant in that case, so a step can never carry a negative duration taken from two readings of one moment, and a duration the producer did not send SHALL stay null rather than becoming a measured zero. A `step_start` SHALL be left open: a step that has not ended is exactly what it means. A tool call whose RESULT reports a failure SHALL be recorded as failed, not only one whose EVENT NAME says so: Claude Code sends `PostToolUse` with the result and puts the failure inside it (`is_error`), so keying on a `post_tool_fail` event alone stored a failed call as clean on the primary live path — a false-green for `no_error_steps`, `completeness-check` and `check --fields step_errors`, on exactly the runs this tool exists to audit. The signals read SHALL be the unambiguous, vendor-generic ones the sibling paths already read (`is_error`, `success: false`, a non-zero top-level `exit_code`, an `error` field), and the stored text SHALL be the most specific the payload carries. A `subagent_stop` that names no `agent_id` SHALL close the session's subagent anchor when EXACTLY ONE is open — then it is not a guess but the only thing the event can mean — and SHALL leave them alone, saying why, when several are, since closing one would pair a subagent's end with another's start. Finalizing SHALL report how many steps were never closed: a tool call the harness never closed is left as it is, because its end was never observed and stamping one would invent a duration, so the trace is `completed` while holding steps that are not. The import summary SHALL report the trace's token total and say what it counts, because a Claude transcript's total is dominated by cache reads and is therefore far larger than a reader expects — a number first met in `stats` with no explanation reads as a defect in the tool. A `claude-stream` run's tokens SHALL be taken from the `result` record's `usage` when it states one — replacing the per-turn accumulation rather than adding to it, since that figure is the whole run's, the same rule the codex-rollout importer applies to its cumulative `token_count`. A stream that reports usage only at the end otherwise recorded a run with no tokens at all, beside a cost read from that very record. Every capture path SHALL stamp `metadata.source_format` with what produced the trace — `hook` (beside the `dialect` naming the harness), `record:<stream format>`, the importers' format names, the receiver's signal names — and a producer's own value SHALL win, since the native protocol lets it describe itself. A store holds traces from several paths at once, and without one key that says which, no view could tell them apart. `record` SHALL report, without counting it as a warning, when a `trace_start` carries a session id the store already has a root trace for: nothing correlates capture paths — the hook finds only its own open trace, the receiver merges only within its own source format, and the recorder opens a trace unconditionally — so the store silently holds two traces for one session and every store-wide count includes both. An import SHALL also report when the session it just imported is ALREADY in the store from a LIVE capture (the hook adapter or the OTel receiver, neither of which stamps a source format, so neither can be recognized by the identity key): the store then holds two traces for one session and every store-wide count includes both. Reported and not refused — a transcript and a live capture record different things — mirroring the notice the receiver gives for its own half of the same problem. A session's identity SHALL be its session id, source format and source filename together — a subagent sidecar shares its parent transcript's session id, so the filename is required to tell them apart. The first user turn SHALL become the trace input and later turns SHALL be retained in `metadata.follow_up_prompts`, with any harness preamble preceding the chosen prompt retained in `metadata.preamble_prompts`; the prompt SHALL be the first turn that is not a harness envelope. The CONTINUATION SUMMARY a harness writes when it compacts a session is such an envelope: it arrives as a user turn, so it was chosen as the prompt of every long session while the person's own message sat in `follow_up_prompts`. A transcript that records a compaction (a `compact_boundary` record, or the summary turn's own flag) SHALL record `metadata.compacted`, as the Codex importer already does from its `compacted` record — the steps before the boundary live in an earlier file, so the trace is a fragment of the session and a reader comparing it to a whole one should be able to tell. The trace's `ended_at` SHALL be taken from the last timestamped record. Each STEP SHALL carry the timestamp of the record that produced it, and a record carrying none SHALL inherit the last timestamp seen, seeded with the trace's own start — the store defaults an absent step timestamp to the current time, which would place an imported session's steps outside the window of the trace they belong to. An imported step SHALL be stored CLOSED when the transcript proves it finished — a `tool_use` PAIRED with its `tool_result`, and every step whose record is itself the artifact (a message, a thought) — and SHALL be left open otherwise, since an unpaired tool call is a session that was interrupted there, which is real information. The end SHALL be the step's own start, so the step reads "finished, duration unknown": the same session captured by the hook and by importing its transcript must agree about what finished. Step DURATIONS SHALL NOT be inferred from the interval between records, which includes time the user was away and is not a measurement of the step. Transcripts SHALL be read incrementally rather than loaded whole, so peak memory tracks the trace being built rather than the file size, and a single line exceeding 64 MB SHALL be refused as not being JSONL.

An import that produced NO trace SHALL name the supported format whose record shapes the file actually carries, when they unambiguously belong to one and it is not the format being used. `--format` defaults to `claude-transcript`, so a Codex rollout passed without the flag is read by the Claude parser and skips every record — "nothing importable" is then a cause the reader can disprove with the file in their hand. The suggestion SHALL be made only on a run that already failed and only on unambiguous evidence, since a wrong one sends the reader to a second format that also imports nothing.

#### Scenario: A session log passed without its format

- **WHEN** `agent-replay import ~/.codex/sessions/.../rollout.jsonl` is run with no `--format`
- **THEN** the import reports that nothing was importable AND names `--format codex-rollout` as the format those records belong to

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

