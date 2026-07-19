# Tasks — add-live-trace-capture

## 1. Storage concurrency

- [x] 1.1 Enable WAL mode and `busy_timeout` in `src/db/connection.ts`
- [x] 1.2 Test: two processes (writer + reader) operate concurrently without `SQLITE_BUSY` failures

## 2. Event protocol

- [x] 2.1 Define event types and validators in `src/services/event-protocol.ts` (versioned, `v: 1`)
- [x] 2.2 Unknown event types/fields are skipped with a stderr warning, not a crash
- [x] 2.3 Test: valid/invalid/unknown event fixtures

## 3. Recorder service & SDK

- [x] 3.1 `src/services/recorder.ts`: apply events incrementally (open trace, upsert steps, match step_start/step_end, attach decisions/snapshots, finalize)
- [x] 3.2 `TraceRecorder` class exported from `src/index.ts` wrapping the recorder for programmatic use
- [x] 3.3 Test: full event stream produces a trace identical to the equivalent batch `ingest`

## 4. `record` command

- [x] 4.1 `agent-replay record` reading JSONL from stdin; `--tags`, `--leave-open`
- [x] 4.2 `--format codex-exec` translator: `thread.started`→trace (thread_id→session_id), `item.*` (`agent_message`, `reasoning`, `command_execution`, `mcp_tool_call`, `file_change`, `web_search`)→typed steps, `turn.completed` usage→totals, `turn.failed`/`error`→failed
- [x] 4.3 `--format gemini-stream` translator: `init`→trace, `tool_use`/`tool_result`→tool_call steps, `message`→output, `result`→finalize, exit codes 0/1/42/53 respected
- [x] 4.4 Finalize still-open traces as `timeout` on EOF (unless `--leave-open`)
- [x] 4.5 Test: recorded fixture streams from `codex exec --json` and `gemini --output-format stream-json` produce correct traces; kill mid-stream → trace remains `running`

## 5. Hook-convention adapter

- [x] 5.1 `agent-replay hook [event]`: dialect auto-detection from `hook_event_name`; mappings for Claude Code/Codex (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`) and Gemini (`SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `SessionEnd`); correlate by `session_id`; raw payload → step metadata; Codex `turn_id`/`model` → metadata
- [x] 5.2 Subagent nesting: SubagentStart/Stop anchor step; tool events parented by matching payload `agent_id` (fall back to ordering for dialects without it); `agent_id`/`agent_type`/`depth` in metadata; accept both `tool_output` (Claude Code) and `tool_response` (Codex/Gemini) result fields
- [x] 5.3 Capture mode always exits 0 and writes nothing to stdout (stdout JSON is a hook decision in all three dialects); `--no-input` drops prompt/tool-input content
- [x] 5.4 README: registration snippets — Claude Code `settings.json` `hooks` block, Codex `config.toml` `[[hooks.*]]` (note `/hooks` trust step and minimum version), Gemini `settings.json` `hooks` block (v0.26.0+)
- [x] 5.5 Test: replayed fixture payload sequences per dialect yield one coherent trace per session

## 6. Session-log importers

- [ ] 6.1 `agent-replay import <path> --format claude-transcript`: user/assistant/system records, `tool_use`/`tool_result` pairing by `tool_use_id`, `thinking` → thought steps, usage aggregation, subagent files under `<session>/subagents/`
- [ ] 6.2 `--format codex-rollout`: `session_meta` → identity + git metadata, `response_item` `function_call`/`function_call_output` pairing by `call_id`, `reasoning` → thought, `compacted` → metadata
- [x] 6.3 Best-effort contract: skip-and-count unknown records, stamp `source_format`/`source_version`, report imported vs skipped
- [ ] 6.4 Test: fixture transcript and rollout files (pinned versions) import correctly; corrupted/newer records are skipped not fatal

## 7. `watch` command

- [x] 7.1 `agent-replay watch [trace-id]` live-tails new steps (500ms poll); with no ID, follows the most recently started running trace
- [x] 7.2 Flag long-running `running` traces in `list` output as possibly abandoned
- [x] 7.3 Test: steps inserted while watching are rendered in order

## 8. Docs

- [x] 8.1 README: event protocol reference, SDK example, per-harness hook setup, `record`/`import`/`watch` usage, privacy notes (`--no-input`, harness-side content switches)
- [x] 8.2 `npm run verify` passes
