# Add Live Trace Capture

## Why

Today traces only enter the store after the fact, via `ingest` of a complete JSON file. That means no visibility while an agent is running, a lossy export step between the agent and the recorder, and no way to hook agent-replay into the harnesses people actually use. Those harnesses have converged on two concrete surfaces we can capture from today: the Claude Code-style hook convention (a command receives a JSON payload on stdin per lifecycle event — adopted near-verbatim by OpenAI Codex CLI, and in renamed form by Gemini CLI, Cline, and Crush) and machine-readable session/event formats (Claude Code transcript JSONL, Codex rollout JSONL, `codex exec --json` and `gemini --output-format stream-json` event streams).

## What Changes

- A versioned JSONL **event protocol** (`trace_start`, `step_start`, `step_end`, `step`, `decision`, `snapshot`, `trace_end`) for incremental capture
- New `agent-replay record` command that consumes an event stream from stdin and writes traces incrementally (status `running` until `trace_end`); `--format` also accepts the native `codex exec --json` (`thread.*`/`turn.*`/`item.*`) and Gemini CLI `stream-json` (`init`/`message`/`tool_use`/`tool_result`/`result`) event shapes
- A **recorder SDK** in the library API (`TraceRecorder`): `startTrace`, `startStep`/`endStep`, `step`, `decision`, `snapshot`, `endTrace` — so TypeScript agents can record directly without files
- New `agent-replay hook` adapter for the hook convention, auto-detecting the dialect from the payload: Claude Code and Codex CLI (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` (CC), `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd` (CC)) and Gemini CLI (`SessionStart`, `BeforeAgent`/`AfterAgent`, `BeforeTool`/`AfterTool`, `SessionEnd`). Invocations are correlated into one trace per harness session via the `session_id` payload field
- New `agent-replay import <path>` command for after-the-fact conversion of native session logs: Claude Code transcript JSONL and Codex CLI rollout JSONL (both explicitly version-unstable internal formats — best-effort, version-pinned parsers)
- New `agent-replay watch [trace-id]` command: live-tail steps of a running trace in the terminal
- SQLite opened in WAL mode with a busy timeout so short-lived hook processes and readers can coexist

## Impact

- Affected specs: `trace-capture` (added requirements), `trace-inspection` (added `watch`)
- Affected code: new `src/services/recorder.ts`, `src/services/event-protocol.ts`, `src/services/importers/*`, `src/commands/record.ts`, `src/commands/hook.ts`, `src/commands/import.ts`, `src/commands/watch.ts`; `src/db/connection.ts` (WAL/busy_timeout); `src/index.ts` (export SDK); `src/cli.ts`
- Depends on `add-decision-trace-model` (events carry `parent_step`, `caused_by_step`, `decision`, `session_id`)
- Sibling change `add-otel-ingest` covers the third capture surface (OTLP/OpenTelemetry GenAI); enforcement (blocking) is `add-runtime-harness`
