# Project Context

## Purpose

`agent-replay` is a flight data recorder and replay engine for AI agents: it stores agent execution traces in a local SQLite database and provides CLI tools to debug, evaluate, compare, and protect agents. It is evolving from a passive post-hoc debugger into an active agent hook/harness that captures decisions and runtime executions live, and can enforce guardrails while an agent runs.

## Tech Stack

- TypeScript (ESM), Node.js >= 18
- CLI: commander; terminal UI: blessed/blessed-contrib, boxen, chalk, cli-table3, ora
- Storage: better-sqlite3 (single local file, `.agent-replay/traces.db`)
- Build: tsup; Tests: vitest; IDs: nanoid
- AI evaluation: direct HTTPS calls to Anthropic / Google / OpenAI (bring-your-own-key, cheapest models by default)

## Project Conventions

### Code Style

- ESM imports with `.js` extensions; strict TypeScript, no `any` where avoidable
- Section-comment dividers (`// ── Name ───`) inside modules
- snake_case for persisted/JSON field names; camelCase for in-memory function names

### Architecture Patterns

- `src/cli.ts` — thin commander definitions with lazy `import()` of command modules
- `src/commands/*` — one file per CLI command; parses options, prints, delegates
- `src/services/*` — all business logic; pure functions taking a `Database` handle
- `src/db/*` — connection, schema DDL, and versioned migrations (`schema_version` table)
- `src/models/*` — shared types and enums; `src/ui/*` — rendering only
- JSON columns are stored as TEXT; parsing is defensive (invalid JSON → `{}`/`[]`)

### Testing Strategy

- vitest against in-memory/temp SQLite databases; no mocking of the DB layer
- `npm run verify` = typecheck + build + test; must pass before merge

### Git Workflow

- `main` is the default branch; conventional-commit style titles (`feat:`, `fix:`, ...)

## Domain Context

- A **trace** is one agent execution; it contains ordered **steps** (thought, tool_call, llm_call, retrieval, output, decision, error, guard_check)
- **Snapshots** freeze context/environment/tool state at a step
- **Evals** score traces (deterministic rubrics or LLM judges); **guardrail policies** pattern-match steps and prescribe actions (allow/deny/warn/require_review)
- Traces may be **forked** from a step (`parent_trace_id`, `forked_from_step`)
- Trace IDs support prefix matching in all CLI commands

### The agent-harness ecosystem we integrate with (verified 2026-07)

- **Hook convention** (originated by Claude Code, since adopted nearly verbatim by OpenAI Codex CLI and, with renamed events, by Gemini CLI, Cline, and Crush): the harness runs an external command per lifecycle event, passing a JSON payload on stdin with common fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`; the command can block a pending tool call via structured stdout JSON or exit code 2 (stderr becomes the agent-visible reason)
- **OpenTelemetry GenAI semantic conventions** (`gen_ai.*`, status: Development; moved to the `semantic-conventions-genai` repo in v1.42.0): emitted natively by Gemini CLI, Claude Code (opt-in; trace spans beta), OpenHands V1, Goose, AutoGen/MS Agent Framework, and via OpenInference/OpenLLMetry instrumentation for most Python frameworks
- **Session-log files**: Claude Code transcript JSONL (`~/.claude/projects/<project>/<session-uuid>.jsonl`, internal format, version-unstable), Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), SWE-agent `.traj`, Cline/Roo per-task JSON, Goose SQLite; plus non-interactive event streams (`codex exec --json`, `gemini --output-format stream-json`)
- Local/open-weight agent stacks (Ollama, vLLM, LM Studio, llama.cpp serving Qwen3-Coder, DeepSeek, Kimi K2, GLM, gpt-oss) expose OpenAI-compatible APIs — ingest must stay vendor-neutral

## Important Constraints

- 100% local, offline-first: no cloud dependency, no telemetry; AI features are opt-in with user-supplied keys
- Framework-agnostic: any agent that can emit JSON can integrate
- Single-writer SQLite: concurrent writers must go through one process (relevant for live capture)
- Backward compatibility of the ingest JSON format — only `agent_name` is required

## External Dependencies

- Anthropic / Google Gemini / OpenAI HTTP APIs (optional, for `eval --ai` and `diff --ai`)
- Default eval model IDs live in `src/services/llm-client.ts`. As of 2026-07 the shipped defaults are partly stale: `claude-haiku-4-5-20251001` is still current ($1.00/$5.00 per MTok), but `gemini-2.0-flash` should move to `gemini-2.5-flash-lite` ($0.10/$0.40) and `gpt-4o-mini` to `gpt-5.4-nano` ($0.20/$1.25) or `gpt-5.4-mini`
