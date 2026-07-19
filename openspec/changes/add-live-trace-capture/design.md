# Design — add-live-trace-capture

## Context

All writes currently happen in one short-lived CLI process. Live capture introduces long-running writers (`record`), many short-lived writers (`hook`, one process per hook event), and concurrent readers (`watch`, `dashboard`) against the same SQLite file.

Verified integration facts this design rests on (2026-07, official docs):

- **Claude Code hooks**: configured in `settings.json` under `hooks.<EventName>[] = {matcher, hooks: [{type: "command", command, timeout}]}`. Every payload carries `session_id`, `prompt_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`; tool events add `tool_name`, `tool_input`, and on PostToolUse `tool_output`; events firing inside a subagent additionally carry `agent_id` and `agent_type`; `SubagentStart`/`SubagentStop` add `agent_type`, `agent_id`, `depth`, `parent_session_id`. Exit 0 stdout can carry structured JSON; exit 2 blocks on blockable events — so a capture-only adapter must exit 0 unconditionally.
- **Codex CLI hooks**: same convention in `config.toml` (`[[hooks.PreToolUse]]` with regex `matcher`); payloads add `turn_id` and `model`; hooks must be trusted via `/hooks` before they run; feature-flagged in older versions — pin a minimum version.
- **Gemini CLI hooks**: same stdin-JSON pattern, different event names (`BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `SessionStart`, `SessionEnd`), base fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`; enabled by default since v0.26.0.
- **Native event streams**: `codex exec --json` emits `thread.started` (thread_id), `turn.started/completed/failed` (usage tokens), `item.started/updated/completed` (item types `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`); `gemini --output-format stream-json` emits `init`/`message`/`tool_use`/`tool_result`/`error`/`result`.
- **Session files**: Claude Code transcripts at `~/.claude/projects/<project>/<session-uuid>.jsonl` (record types `user`/`assistant`/`system` with `uuid`, `parentUuid`, `message.content` blocks incl. `tool_use`/`tool_result`, `usage` tokens; subagents in `<session>/subagents/agent-<id>.jsonl`); Codex rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`session_meta`, `response_item` mirroring the Responses API with `function_call`/`function_call_output` paired by `call_id`, `event_msg`, `turn_context`, `compacted`). Both vendors state these formats are internal and can change between releases.

## Goals / Non-Goals

- Goals: lossless incremental capture; a stable, versioned wire format of our own; first-class adapters for the three major CLIs; zero configuration beyond `init`
- Non-Goals: OTLP/OpenTelemetry ingest (sibling change `add-otel-ingest`); enforcement/blocking (`add-runtime-harness`); scraping stdout of agents that emit nothing; guaranteed-complete parsing of vendor-internal transcript formats

## Decisions

### JSONL events over stdin, not a socket

`record` reads newline-delimited JSON events from stdin. Every agent framework can append lines to a pipe; there is no port, no daemon, and the same stream can be teed to a file for later `ingest`. Each event carries `v: 1` and `trace_id` (client-generated or assigned by `trace_start`). Unknown event types and unknown fields are ignored with a warning — forward compatibility.

### Native stream dialects live in `record --format`, not separate commands

`record --format codex-exec` and `record --format gemini-stream` translate the harnesses' own non-interactive streams (shapes above) into our events: `thread.started`/`init` → `trace_start`, `item.*`/`tool_use`+`tool_result` → steps, `turn.completed`/`result` → totals and finalization. One consumer loop, per-dialect translators. These shapes are documented-stable (Codex's `--json` replaced `--experimental-json`), unlike the transcript files.

### One hook adapter, dialect auto-detected

Claude Code and Codex payloads are near-identical; Gemini differs only in event names and a few field names. Every dialect delivers `hook_event_name` in the payload, so `agent-replay hook` needs no dialect flag: it maps `PreToolUse`/`BeforeTool` → open a `tool_call` step, `PostToolUse`/`PostToolUseFailure`/`AfterTool` → close it (the result field is `tool_output` in Claude Code and `tool_response` in Codex and Gemini — accept both; failures set step `error`), `UserPromptSubmit`/`BeforeAgent` → open the trace if absent and store the prompt as input, `SubagentStart`/`SubagentStop` → open/close a nesting anchor step, `Stop`/`AfterAgent`/`SessionEnd` → finalize. Subagent attribution does not rely on event ordering: in Claude Code, tool events that fire inside a subagent carry `agent_id`/`agent_type` in the payload, so steps are parented to the anchor whose `agent_id` matches; `depth` (in metadata) preserves nesting for subagent trees. The event name argument (`agent-replay hook PreToolUse`) is kept as a cross-check but the payload wins.

### Hook adapter is stateless; the session is the correlation key

Each hook fires as a fresh process, so the adapter keeps no memory. It finds the open trace (`status = running`) with a matching `session_id`, creates one if absent, appends, and exits. Open tool_call steps are matched by `tool_name` + order (Codex additionally provides `turn_id`, stored in metadata). The adapter always exits 0 in capture mode — in all three CLIs a non-zero exit is at best a user-visible warning and at worst (exit 2) blocks the agent's action, which capture must never do. The raw payload is preserved in step `metadata`.

### Import is best-effort and version-pinned

`import` parsers for Claude Code transcripts and Codex rollouts target a pinned format version each, skip unrecognized records with counts reported at the end, and stamp `metadata.source_format` + `metadata.source_version`. Both vendors explicitly reserve the right to change these formats; the hook adapter and native streams are the supported paths, import is the escape hatch for history that already exists on disk.

### Prompt/response privacy follows the harness's own switches

We record what the harness hands us. Content-bearing fields arrive only when the user enabled them harness-side (Gemini `telemetry.logPrompts`, Codex hook payloads, Claude Code hook payloads always include `tool_input`). The adapter's `--no-input` flag additionally drops prompt text and tool inputs at our door for shared machines.

### WAL mode + busy timeout

`connection.ts` enables `journal_mode = WAL` and `busy_timeout = 3000ms`. WAL allows one writer plus concurrent readers, which covers hook bursts and `watch` polling. `watch` polls (500ms) rather than using file notifications — simpler and portable.

### Abandoned traces

A crash leaves a trace `running` forever. `record` finalizes open traces as `timeout` on EOF unless `--leave-open`; a missed `Stop`/`SessionEnd` hook does the same via a staleness threshold surfaced in `list`.

## Risks / Trade-offs

- Two writers racing on the same trace (record + hook misconfiguration) — last write wins; documented as unsupported
- Hook payloads evolve with harness versions (Codex hooks were feature-flagged into existence in late 2025) — defensive mapping, raw payload kept, minimum versions documented
- Claude Code subagent tool calls fire the parent session's hooks, so heavy subagent use produces interleaved steps; the SubagentStart/Stop anchors keep them attributable
- `codex exec --ephemeral` writes no rollout files — import cannot see those runs; hooks/streams still can

## Migration Plan

No schema change (builds on v2 from `add-decision-trace-model`). Purely additive commands and exports.

## Open Questions

- Whether to ship ready-made hook config snippets (`agent-replay hook install --harness claude-code|codex|gemini` writing the settings.json/config.toml blocks) in this change or a follow-up. Leaning follow-up; README snippets first.
