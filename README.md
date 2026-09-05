# agent-replay

**Time-travel debugging for AI agents.**

When your AI agent hallucinates, calls the wrong tool, or breaks in production — and you're stuck reading thousands of lines of logs trying to figure out what went wrong — this tool fixes that.

## The Problems This Solves

**1. "Why did my agent fail?"**
You deploy an AI agent. It works Monday. Tuesday it hallucinates, makes up a company policy, and tells a customer something completely wrong. Your only debugging option is reading raw JSON logs. `agent-replay` records every step of every agent run — every thought, tool call, retrieval, and output — so you can replay exactly what happened, step by step, like rewinding a tape.

**2. "It worked before, what changed?"**
You push a new prompt or swap a model and suddenly your agent breaks on cases that used to work. `agent-replay diff` puts two runs side-by-side and shows you exactly where they diverged — which step went different, what changed in the context, where things went wrong.

**3. "How do I test a fix without rerunning everything?"**
You think you know what went wrong but you don't want to burn API credits and time reproducing the exact scenario. `agent-replay fork` lets you take any recorded run, rewind to any step, change the input, and see what would have happened differently.

**4. "How do I know if my agent is actually good?"**
You have no systematic way to evaluate agent quality. `agent-replay eval` runs automatic checks — hallucination detection, safety audits, completeness checks — using both deterministic rules and AI-powered analysis. Bring your own API key (Anthropic, Google, or OpenAI) and get root-cause analysis, quality scoring, security audits, and optimization suggestions for pennies per trace.

**5. "How do I stop my agent from doing dangerous things?"**
Your agent has access to tools that can delete data, send emails, or make purchases. `agent-replay guard` lets you define kill-switch policies that flag or block dangerous patterns — like blocking any `delete` tool calls, or warning when token usage spikes.

**6. "How do I build regression tests for a non-deterministic system?"**
Every time you fix a bug, it might break something else. `agent-replay export --format golden` builds golden datasets from known-good runs that you can test against on every deploy.

## What It Is

A CLI tool that stores agent execution traces in a local SQLite database and gives you tools to debug, evaluate, compare, and protect your AI agents — both after the fact and **live**, as an agent runs.

- 100% local. Single SQLite file. No cloud dependency.
- Works with any agent framework — export traces as JSON, or capture live from the harnesses people already use: the [hook convention](#hook-capture) (Claude Code, Codex CLI, Gemini CLI), the [CLIs' own event streams](#live-capture), [OpenTelemetry](#opentelemetry-ingest), or [`agent-replay run`](#run-under-supervision).
- More than an observer: [enforce guardrails](#enforcement-block-dangerous-tool-calls-live) at the moment a dangerous tool call is attempted, and turn known-good runs into a [CI regression gate](#regression-check-ci).
- AI-powered evaluation using your own API key (Anthropic, Google, or OpenAI). Uses the cheapest models by default.

## Quick Start

```bash
npm install -g agent-replay

agent-replay init                  # creates .agent-replay/ with SQLite database
                                   #   (--force overwrites an existing config)
agent-replay demo                  # loads 5 sample traces + 3 guardrail policies
                                   #   (--reset clears the store first)
agent-replay list                  # see everything
agent-replay show <trace-id>       # inspect a trace step-by-step
agent-replay replay <trace-id>     # animated terminal replay
```

Requires **Node.js 20.12+**.

## Commands

Every command accepts `--dir <path>` to point at a data directory other than `./.agent-replay`, and `--help` lists a command's full set of flags — the sections below cover the ones worth explaining, not every switch.

### Record

```bash
# Ingest a trace from a JSON file
agent-replay ingest trace.json

# JSONL file (one trace per line)
agent-replay ingest traces.jsonl --format jsonl

# Tag traces during ingest
agent-replay ingest trace.json --tags production,v2

# Validate without inserting
agent-replay ingest trace.json --dry-run
```

#### Live capture

`ingest` loads a complete trace after the fact. To capture a run **as it happens**, stream newline-delimited capture events into `record` — the trace grows step by step and stays `running` until a `trace_end` event arrives.

A capture event is rejected — with a warning, keeping the rest of the stream — when it carries something `ingest` would refuse, so a trace can always be restored from its own export: a `trace_id` that is not an identifier (empty, or carrying control characters), a step with no name, non-string tags, a decision `confidence` outside 0–1, and decision `options` that are not `{option, …}` objects. Usage and timing fields that are not non-negative finite numbers are dropped the same way.

```bash
# Pipe a JSONL event stream into the recorder
my-agent --emit-events | agent-replay record --tags production

# Keep the trace open (don't finalize as timeout) when the stream ends
my-agent --emit-events | agent-replay record --leave-open
```

`record` also speaks the major CLIs' own non-interactive streams directly, so you can pipe them in without instrumentation:

```bash
codex exec --json "fix the failing tests"      | agent-replay record --format codex-exec
gemini -p "summarize" --output-format stream-json | agent-replay record --format gemini-stream
```

For the native protocol, each event is one JSON object on its own line carrying `v: 1`, a `type`, and (except `trace_start`) the `trace_id` the producer generated:

| Event | Purpose |
|-------|---------|
| `trace_start` | Open a trace (`agent_name` required; optional `trace_id`, `session_id`, `input`, `tags`) |
| `step_start` / `step_end` | Open a step, then close it with output/error/timing/tokens |
| `step` | A complete step in one event (may include a `decision` and `snapshot`) |
| `decision` | Attach a decision record to a step (any step type) |
| `snapshot` | Freeze context/environment/tool state at a step |
| `trace_end` | Finalize the trace (`status`, `output`, token/cost totals) |

An unknown event *type* is skipped with a warning; an unknown *field* is ignored silently, so a newer producer's extra keys cost nothing and neither case is ever a crash. A usage or timing field that is not a non-negative finite number (`tokens_used`, `duration_ms`, `total_tokens`, `total_duration_ms`, `total_cost_usd`) is dropped with a warning and the rest of the event is kept, since `ingest` rejects such a value and the trace would otherwise be unrestorable from its own export. A trace left open when the stream ends is finalized as `timeout` unless `--leave-open` — including one this stream resumed by id, so a trace can't dangle silently. The single exception is the trace a *live* enclosing `agent-replay run` handed down (via `AGENT_REPLAY_TRACE_ID`): that one belongs to the wrapper, which finalizes it from the child's exit.

#### OpenTelemetry ingest

Many agent stacks already emit OpenTelemetry with the GenAI semantic conventions (`gen_ai.*`) — Gemini CLI, Claude Code, OpenHands, Goose, AutoGen, and most Python frameworks via OpenInference/OpenLLMetry. Run a local OTLP receiver and point them at it, no per-framework adapter needed:

```bash
agent-replay otel serve --port 4318
```

It accepts `POST /v1/traces` and `POST /v1/logs`, each in both OTLP/JSON and OTLP/protobuf, with gzip. Spans map onto the trace model: `invoke_agent`/`invoke_workflow` roots become traces (`gen_ai.agent.name` → agent, `gen_ai.conversation.id` → session), `execute_tool` → `tool_call`, `chat`/`generate_content`/`text_completion` → `llm_call`, `embeddings`/`retrieval` → `retrieval`, span parentage → step hierarchy, and `gen_ai.usage.*` → token totals. Deprecated attribute forms (`gen_ai.system`, `prompt_tokens`/`completion_tokens`) are normalized. The two other common dialects are read for content as well as classification: OpenInference (`openinference.span.kind`, `input.value`/`output.value`, `llm.prompts`/`llm.completions`, `llm.provider`, `llm.model_name`, `llm.token_count.*`, `tool.name`) and OpenLLMetry (`traceloop.span.kind`, `traceloop.entity.input`/`output`, `traceloop.entity.name`), so a LangChain or LlamaIndex app records prompts and responses, not just span shapes. Spans without an agent root are grouped into a synthetic trace per OTel trace ID. Spans (and log events) of one trace that arrive across several export batches — the usual case, as a `BatchSpanProcessor` flushes finished child spans before the root ends — are assembled into a single trace by OTel trace ID (log events by session ID), and the rootless synthetic trace is upgraded in place once the root batch arrives; each batch is still stored on arrival, so the trace stays queryable mid-session. Steps of an assembled trace are numbered by span start time rather than arrival order, so a parent span that flushes after its children still comes before them.

A batch an exporter **redelivers** (a lost `200`, a client timeout after the write, an exporter retry) is recognized on the span path and not stored twice: spans already on the trace are dropped by span id, and the batch's tokens and cost are recomputed from the spans it actually contributes — including a mixed batch that redelivers the token-carrying span alongside a new one, so a retry cannot inflate the totals. The **log** path has no equivalent identity — a log record carries no span id — so redelivered log batches can still duplicate; prefer at-most-once delivery there, or use the span endpoint.

Log events from the two CLIs that emit richer signal as logs are mapped too: Gemini CLI (`gemini_cli.user_prompt`, `gemini_cli.tool_call` — including its `decision` as a decision record attributed to user or policy, `gemini_cli.api_response` tokens) and Claude Code (`claude_code.*`), correlated by `session.id`.

Point an exporter at it over HTTP/JSON. Most emitters default to gRPC on port 4317, so switch them to HTTP:

- **Gemini CLI** — `telemetry: { enabled: true, target: "local", otlpEndpoint: "http://localhost:4318", otlpProtocol: "http" }`
- **Claude Code** — `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (opt into content with `OTEL_LOG_USER_PROMPTS=1`)
- **Goose / OpenHands** — `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`

Both CLIs redact prompt/response content unless you opt in on their side (Gemini `telemetry.logPrompts`, Claude Code `OTEL_LOG_USER_PROMPTS=1`); `agent-replay` records whatever they send.

> GenAI, OpenInference, and OpenLLMetry span dialects are all recognized, including their prompt/response content. Both `/v1/traces` and `/v1/logs` accept OTLP/JSON and OTLP/protobuf, so an exporter left on its default protobuf protocol works without reconfiguring it to JSON.

#### Hook capture

`agent-replay hook` plugs into the stdin-JSON hook convention shared by Claude Code, OpenAI Codex CLI, and Gemini CLI. It's stateless — each invocation correlates to a trace by the payload's `session_id` — and auto-detects the dialect, so no flag is needed. Capture is side-effect-only: it always exits 0 and writes nothing to stdout (in these harnesses exit 2 blocks the agent and stdout is read as a hook decision), so it can never interfere with a run. Add `--no-input` to drop prompt text and tool inputs on shared machines.

**Claude Code** — `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "PreToolUse":  [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }]
  }
}
```

**Codex CLI** — `~/.codex/config.toml` (then trust the hooks via `/hooks`; requires a Codex build with hook support):

```toml
[[hooks.PreToolUse]]
command = "agent-replay hook"
[[hooks.PostToolUse]]
command = "agent-replay hook"
[[hooks.Stop]]
command = "agent-replay hook"
```

**Gemini CLI** (v0.26.0+) — `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "AfterTool":  [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "agent-replay hook" }] }]
  }
}
```

Then watch a live session with [`agent-replay watch`](#watch-a-live-run).

#### Import existing session logs

To pull in history that already exists on disk, `import` converts a Claude Code transcript or a Codex CLI rollout into a trace. It's best-effort: unrecognized records are skipped and counted (both vendor formats are internal and version-unstable), and the source format/version is stamped in the trace metadata.

```bash
agent-replay import ~/.claude/projects/my-project/<session-uuid>.jsonl --format claude-transcript
agent-replay import ~/.codex/sessions/2026/07/02/rollout-abc.jsonl      --format codex-rollout
```

For Claude Code, `tool_use`/`tool_result` blocks become paired `tool_call` steps (a result flagged `is_error` records its message on the step's error field, so a failed tool call stays distinguishable from a successful one), `thinking` blocks become `thought` steps, and `usage` counts aggregate into token totals — including the two cache fields, which is where most of a real session's consumption lives. For Codex, `session_meta` supplies identity and git metadata, both tool families (`function_call`/`function_call_output` and the freeform `custom_tool_call`/`custom_tool_call_output`, each paired by `call_id`) become `tool_call` steps with a non-zero exit code or an explicit failure recorded on the step's error field, `reasoning` becomes `thought` steps, and `token_count` supplies the session token total.

A session's user turns are all kept: one becomes the trace input, later ones go to `metadata.follow_up_prompts`, and any harness preamble ahead of the prompt goes to `metadata.preamble_prompts`. Real transcripts usually open with an envelope (a slash-command block, injected instructions, an environment or plugin preamble, a system reminder), so the prompt is the first turn that isn't one — detected by shape, since a person's question essentially never opens with `<`. An envelope prompt is still used if that is all the session has.

Importing the same session twice does **not** create a second trace:

```bash
agent-replay import <same-file>              # "Session already imported as trc_… — nothing changed."
agent-replay import <same-file> --replace    # re-import it (use this when the transcript has grown)
```

Transcripts are read a line at a time rather than loaded whole, so peak memory tracks the trace being built rather than the file: a 52 MB session imports in ~270 MB instead of ~440 MB, and a session larger than ~512 MB imports at all (it previously failed with "Cannot create a string longer than 0x1fffffe8 characters" and no partial import — a 647 MB transcript now imports its 672,000 steps).

Sessions are identified by session id, source format **and** source filename — a Claude Code subagent sidecar (`<session>/subagents/agent-*.jsonl`) carries the same session id as its parent transcript, so the file has to be part of the identity. A file that carries no session id is imported each time it is named, and a trace imported before this identity existed is never replaced.

#### Enforcement (block dangerous tool calls live)

Add `--enforce` to the hook to evaluate each proposed tool call against your [guardrail policies](#guardrails) before it runs, and block denied calls in the harness's own dialect. Register it with the event name — `agent-replay hook PreToolUse --enforce` (or `BeforeTool` for Gemini CLI) — so that if stdin arrives empty or unreadable, the command still knows a tool call was being gated and blocks rather than allowing an unchecked call. It also needs to find your store: the path resolves from the hook process's working directory, so pass `--dir` unless that is the project root.

An enforcing gate that cannot fire fails closed rather than passing everything — in `hook --enforce` and in `guard check` alike. Enforcing against a store that does not exist blocks with the reason, and so does enforcing against a store with **no enabled policies** — otherwise a capture hook running from the wrong directory creates an empty store, and every tool call after it is allowed silently while the setup still looks correct. If you want `--enforce` registered before you have written any policies, pass `--allow-empty` to say so.

- **Claude Code / Codex CLI**: emits `{"hookSpecificOutput": {"permissionDecision": "deny" | "ask", ...}}` — `deny` policies block, `require_review` policies defer to the harness's own approval prompt (`"ask"`).
- **Gemini CLI**: emits `{"decision": "deny", "reason": ...}` (its hooks are allow/deny only, so `require_review` denies with a "review required" reason).
- **Crush / others without structured output**: exits 2 with the reason on stderr. The dialect is detected from the payload, and nothing in a payload identifies a harness that doesn't read hook stdout — so declare it with `--dialect other` (also `claude-code`, `codex`, `gemini` to pin detection), and denied calls are answered by exit code alone.

`warn` policies never block — they surface a message and allow the call. Every enforcement decision that matches a policy is recorded as a `guard_check` step in the session's trace, linked to the attempted `tool_call`, so blocked attempts show up in [`show`](#inspect) and [`why`](#explain-decisions).

You can also evaluate a single step out of band:

```bash
echo '{"step_type":"tool_call","name":"delete_user"}' | agent-replay guard check   # exit 2 if denied
```

It prints a machine-readable verdict on stdout — `{"action", "policy", "reason"}`
— with the human-readable line on stderr, so it scripts cleanly:
`{"action":"deny","policy":"no-deletes","reason":"..."}` on a block,
`{"action":"allow","policy":null,"reason":null}` otherwise. Standalone,
`require_review` prompts when a TTY is present and otherwise fails closed,
reporting `deny` with a "review required (no TTY — failed closed)" reason.
Whether a human is present is read from **stderr**, where the prompt is written
— not from stdout — so capturing the verdict does not silently turn every
review into a block.

> **Guardrail, not a boundary.** Hook-level enforcement is a guardrail, not a complete security boundary — the harness vendors say so themselves (a determined agent can often reach equivalent effects through another tool path). For hard isolation, use OS-level sandboxing: Claude Code's sandbox, Codex `sandbox_mode`, or Gemini CLI's sandbox.

### Browse

```bash
# List the most recent traces (25 at a time by default; the header
# reports the full count, and --limit raises the page size)
agent-replay list

# Filter by status, agent, tag, or time
agent-replay list --status failed
agent-replay list --agent travel-bot --since 7d
agent-replay list --tag production --sort -tokens --limit 10

# JSON output for piping
agent-replay list --json
```

`list` draws at most **1,000 rows** and says so when it stops there, naming
`--json` as the uncapped path. The query itself is not limited — `--limit`
still decides how many traces match, and `--json` returns all of them — but the
terminal table renderer costs time quadratic in its row count, so drawing ten
thousand rows took about seven seconds to build output no one reads. A thousand
rows is already some forty screenfuls.

An **empty** value for `--status`, `--agent`, `--tag`, `--session` or `--since` is
a usage error (exit `2`), not an unfiltered listing — so a filter built from an
unset shell variable (`list --agent "$AGENT"`) fails loudly instead of quietly
returning every trace at exit `0`, which reads exactly like a correct narrow
result.

`--agent` matches by **substring**, so `--agent travel` finds `travel-bot` and
`travel-assistant` alike; `--session` matches by **prefix**, like a trace id.
Convenient for browsing, but worth knowing wherever the selection decides a
verdict: `check --golden --agent travel-bot` in a store that also holds
`travel-bot-v2` traces checks both. For a CI gate, prefer **`check --agent-exact <name>`**, which selects only that agent — a substring is right for browsing and wrong for a gate, because under `--strict` an unrelated agent that happens to contain the term decides the verdict. Pair it with a baseline exported for the same agent, or the other baselines count as unexercised. The two flags are mutually exclusive.

With no `--sort` at all, traces are listed newest first. Passing `--sort` orders
ascending; prefix the field with `-` for descending. So "my ten most expensive
runs" is `--sort -tokens --limit 10` — `--sort tokens` returns the cheapest ten,
and `--sort started_at` returns the *oldest* first, reversing the default view.
Sortable fields: `started_at` (the default field), `duration`, `tokens`, `cost`,
`agent_name`.

### Inspect

```bash
# Full detail view with step timeline
agent-replay show <trace-id>

# Just the steps
agent-replay show <trace-id> --steps-only

# Include eval results and state snapshots
agent-replay show <trace-id> --evals --snapshots

# Render steps as a hierarchy (subagents/nested calls) with causal links
agent-replay show <trace-id> --tree

# Window a large trace (real sessions can run to thousands of steps)
agent-replay show <trace-id> --from-step 100 --to-step 150
```

A windowed `show --json` carries a `step_window` object (`from`, `to`, `shown`, `omitted`) so a consumer can tell a subset from a whole trace; an unwindowed one has no such field.

Trace IDs support prefix matching — just type the first few characters. A prefix that matches more than one trace is an error naming the candidates, not a silent pick, so a command never answers about (or, in `fork`'s case, writes from) a trace you did not name.

### Watch a live run

While a trace is still being captured — by `hook`, `record`, `run`, or the OTel receiver — `watch` live-tails it, printing each new step as it lands:

```bash
# Follow the most recent still-running trace
agent-replay watch

# Follow a specific trace, polling faster
agent-replay watch <trace-id> --interval 200
```

With no id it picks the most recent `running` trace — by start *instant*, not by the spelling of the timestamp — so it's the natural companion to a hook-instrumented session in another terminal. It exits when the trace is finalized.

`--interval` is in milliseconds and is capped at `2147483647` ms — above that
Node's timer overflows and clamps to 1 ms, polling the database about a
thousand times a second rather than almost never, so it is a usage error (exit
`2`) instead.

A producer that opens a step and closes it later (the two-phase `step_start`/`step_end` protocol) gets two lines per step: the announcement when the step starts, and a closing line carrying what only the end knows — duration, tokens, and any error. A producer that writes a complete step in one event gets a single line. Text that came from the agent (step names, errors, models, decision rationales) is escaped before it reaches your terminal, so a control sequence in a tool's stderr cannot retarget the terminal you are watching from.

### Explain decisions

When a trace records *why* it acted — decision alternatives, causal links between steps, and step hierarchy — you can inspect that structure directly.

```bash
# Walk the causal chain backward from a step to the decision that triggered it
agent-replay why <trace-id> --step 9

# List every decision point with its options, chosen option, and rationale
agent-replay decisions <trace-id>

# Group traces from one harness session/conversation
agent-replay list --session <session-id>
```

`why` follows each step's `caused_by_step`, falling back to `parent_step` and then to the nearest earlier decision, printing the chosen option and rationale at each decision hop. Both commands accept `--json`.

### Replay

```bash
# Animated step-by-step replay (default 5x speed)
agent-replay replay <trace-id>

# Faster, slower, or instant
agent-replay replay <trace-id> --speed 10
agent-replay replay <trace-id> --speed 0

# Replay only steps 3 through 7
agent-replay replay <trace-id> --from-step 3 --to-step 7

# Wait for a keypress after each step
agent-replay replay <trace-id> --pause
```

### Compare

```bash
# Side-by-side diff of two traces
agent-replay diff <trace-a> <trace-b>

# Summary only
agent-replay diff <a> <b> --compact

# AI-powered analysis of why the traces diverged
agent-replay diff <a> <b> --ai
```

Steps are compared on `step_type`, `name`, `input`, `output`, `model`,
`error`, and `decision`; the trace itself is compared on `trace_input`, `status`,
`trace_error`, and `trace_output` — so a fork made with `--modify-input` shows the input you
changed. Trace-level differences report a step of `trace` (`null` in `--json`)
and never set `divergence_step`, which means "the first step that went
different". Steps are paired by `step_number`, so gaps don't misalign the
comparison. Narrow the comparison with `--fields`; when a filter leaves nothing,
the verdict says so rather than claiming the traces are identical, and a filter
naming no field at all is a usage error. The `--json` document records the scope
too, as `compared_fields` — the list when `--fields` narrowed the comparison and
`null` when it did not — so a filtered count is never read as a full one.

`decision` compares the chosen option, its rationale, and who decided — so two
runs that took opposite actions at the same step are reported as different even
when every other field matches. Confidence and the option list are deliberately
excluded: they are the model's self-report and vary run to run without the agent
having acted differently.

### Fork

```bash
# Fork a trace at step 3
agent-replay fork <trace-id> --from-step 3

# Fork with modified input
agent-replay fork <trace-id> --from-step 2 --modify-input '{"task":"revised prompt"}'

# Tag the fork
agent-replay fork <trace-id> --from-step 4 --tag experiment-1
```

An **empty** value for `--modify-input`, `--modify-context` or `--tag` is a
usage error (exit `2`), for the same reason it is on `list`: a flag built from
an unset shell variable would otherwise be skipped silently, and `fork` would
report success for a copy carrying none of what was asked. A literal `null`
*is* accepted — it is the documented no-op that keeps the original value.

### Run under supervision

Wrap any agent command to record it end-to-end and propagate its exit status — useful as a one-line harness around a run:

```bash
agent-replay run --agent-name my-bot -- node agent.js
```

The wrapper pre-creates a trace and hands the child a recording channel via environment variables (`AGENT_REPLAY_DIR`, `AGENT_REPLAY_TRACE_ID`, `AGENT_REPLAY_EVENTS`). Every `agent-replay` command honors `AGENT_REPLAY_DIR` as its data directory when `--dir` isn't given, so a nested invocation (`run -- sh -c '... | agent-replay record'`) writes to the wrapper's store rather than a fresh one in the working directory. An instrumented child (using the [`TraceRecorder` SDK](#programmatic-api) or writing JSONL events to `$AGENT_REPLAY_EVENTS`) records a full step-by-step trace; an uninstrumented child still gets a trace with timing and exit metadata. The child's stdio passes through untouched, and the trace is finalized from its exit — `0` → completed, non-zero → failed with the code recorded. A child that sends its own `trace_end` owns the status: that declaration is kept even when it disagrees with the exit code, and the summary names both (`completed (child exited 7)`). `agent-replay run` exits with the child's own status either way, so it drops cleanly into scripts and CI.

The events channel is **append-only**: open it with `a`, never `w`. A producer that rewrites it is detected and warned about, but events written before the rewrite are gone. If the store refuses an event (a child recording several sub-traces collides on per-trace step numbering), the run summary says how many could not be stored.

### Regression check (CI)

Turn known-good runs into a regression gate. Export a golden dataset once, then `check` new runs against it — the comparison is structural (step count, step types and names, tool-call inputs, final status) rather than raw output text, so non-deterministic wording never causes false failures. It exits non-zero on any regression, ready for CI.

```bash
# Capture a golden dataset from passing runs
agent-replay export --format golden --tag known-good --output golden.json

# Fail the build if recent runs diverge from golden
agent-replay check --golden golden.json --agent travel-bot --since 1d

# Check one trace by id (instead of every trace matching the filters)
agent-replay check --golden golden.json --trace <trace-id>

# Narrow the comparison, or treat unmatched runs as failures
agent-replay check --golden golden.json --fields step_types,tool_inputs
agent-replay check --golden golden.json --strict --json

# Opt into catching model swaps (ignored by default, since upgrades are common)
agent-replay check --golden golden.json --fields model

# Gate on the agent's CHOICES, not just the shape of the run
agent-replay check --golden golden.json --fields step_types,decisions
```

Comparable fields: `step_count`, `step_types`, `step_names`, `tool_inputs`, `step_errors`, `status` (the default set), plus opt-in `model` and `decisions`. **`decisions` compares the option each step CHOSE** — the divergence a structural gate is otherwise blind to: rename nothing, change no tool, and swap `escalate_to_human` for `delete_records`, and every default field still matches. It is opt-in because no baseline exported before it carries the data, so making it a default would turn a working gate into the "nothing to compare" refusal on upgrade; re-export the baseline and pass `--fields ...,decisions`. Only a step the baseline recorded a decision for is compared. `step_errors` compares whether each step FAILED — a step that starts erroring is a regression the other fields cannot see, since a hook-captured session finalizes `completed` from its Stop event however many tool calls failed inside it. It is one-directional: a step that *stops* failing is a fix, not a regression. Only the flag is compared, never the message, and a baseline exported before this field is skipped step by step. An unrecognized `--fields` value is rejected rather than silently comparing nothing — as a usage error (exit `2`) named for the bad field, checked before the store is opened, so a typo can't surface as "no traces matched" instead. A *valid* field that no baseline entry can exercise (`--fields model` against a baseline captured without per-step models) is refused the same way, for the same reason: it would otherwise compare nothing and report a pass. This is judged per candidate, so a mixed run in which one agent has no tool calls refuses `--fields tool_inputs` for the whole run rather than passing on another agent's behalf — narrow the run with `--agent` if that is not what you want.

A golden entry also carries `expected_output` and `eval_criteria`. These are recorded for downstream consumers and human review — **`check` does not compare them**; the gate is structural, over the fields listed above. `metadata` is required, though: an entry without `metadata.status` is refused, because the `status` comparison would otherwise be silently skipped.

Candidates gathered in bulk are the runs that could actually regress: **forks and still-`running` traces are excluded**. A fork is a never-executed copy of a step prefix, so it matches its own baseline and then "diverges" on step count and status — one `fork` would otherwise turn the gate permanently red on a shared store. A running trace is mid-flight, so its partial shape is not a regression either. A trace named explicitly with `--trace` is always compared, whatever its lineage or status. For the same reason, `export --format golden` leaves forks out of a baseline *gathered by filter*, while `json` and `jsonl` exports are backups and keep them. `export <trace-id> --format golden` follows the same rule as `check --trace`: a trace you name by id is exported whatever its lineage.

Matches are made by agent name and a hash of the input, so each run is compared to its own golden counterpart. A divergence report names the trace, the step, and the differing field. The summary also reports baseline entries **no candidate exercised** — a scenario whose run crashed or never happened at all, which otherwise leaves a gate green with nothing to say about it. Those count as failures under `--strict`, alongside unmatched runs.

Build the baseline from runs that finished cleanly: `export --format golden` warns when entries did not come from a completed run — a `running` trace bakes in a partial shape the next correct run "regresses" against, and a `failed`/`timeout` one makes reproducing the failure pass green. The warning reports how many of the entries that covers, not which condition each hit; filter with `--tag known-good` or `--status completed`.

A gate that cannot do its job fails loudly (exit `2`) instead of passing green. That covers a golden file with no entries — an empty baseline can never detect a regression, and the usual cause is an export filter that matched nothing, which the export warns about too — a file that isn't a golden dataset at all (`--format json` output is a common mix-up), and a run where no trace matched the filters, whether from a mistyped `--agent`, a `--since` window that outran the recording, or a `--dir` pointing somewhere the runs were never recorded. The same is true when candidates exist but NONE of them matched a baseline: nothing was compared, so nothing could regress. That usually means the agent was renamed, the input template changed, or capture stopped recording the input (`hook --no-input`) — all of which change the match key. `--strict` and `--trace` keep their own verdicts (a regression, and a plain unmatched report). If either empty case is expected — a quiet nightly window, a matrix job where this agent didn't run — pass `--allow-empty`, which opts out of both refusals. With `--json`, a refusal is reported as `{"ok": false, "error": ...}` rather than bare stderr, so a `check --json | jq -r .ok` pipeline still reads a verdict.

### Evaluate

```bash
# Run all built-in deterministic checks
agent-replay eval <trace-id>

# Run a specific preset
agent-replay eval <trace-id> --preset hallucination-check
agent-replay eval <trace-id> --preset safety-check
agent-replay eval <trace-id> --preset completeness-check

# Run AI-powered evaluation (requires API key)
agent-replay eval <trace-id> --ai
agent-replay eval <trace-id> --preset ai-root-cause
agent-replay eval <trace-id> --preset ai-quality-review
agent-replay eval <trace-id> --preset ai-security-audit
agent-replay eval <trace-id> --preset ai-optimization

# Set a cost budget for AI evals
agent-replay eval <trace-id> --ai --max-cost 0.05

# Custom rubric file
agent-replay eval <trace-id> --rubric my-rubric.yaml

# JSON output
agent-replay eval <trace-id> --json
```

`eval` exits non-zero when an evaluation fails (a rubric below its threshold or a
built-in preset that fails), so `agent-replay eval <trace-id> --rubric q.yaml`
drops straight into a CI job as a pass/fail gate. It also exits non-zero when an
evaluator *fails to run at all* — a provider error, an unreachable network — and
names each one, so a score is never reported as if it covered evaluators that
never looked at the trace. Under `--json` those names go to stderr, keeping
stdout a clean document for `jq`.

### Guardrails

```bash
# List all policies
agent-replay guard list

# Add a policy that blocks delete operations
agent-replay guard add --name no-deletes \
  --pattern '{"step_type":"tool_call","name_contains":"delete"}' \
  --action deny

# Test all policies against a trace
agent-replay guard test <trace-id>

# Turn a policy off without deleting it (by id or name), and back on
agent-replay guard disable no-deletes
agent-replay guard enable no-deletes

# Remove a policy
agent-replay guard remove <policy-id>
```

`guard test` summarizes what a recorded run would have hit: how many matches
would have blocked it (`deny`, and `require_review`, which fails closed unless
someone approves it) and how many would only have warned.

A disabled policy stays in `guard list` (with `Enabled: No`) and is skipped by
every evaluation path — `hook --enforce`, `guard check`, and `guard test` — so
you can silence a noisy rule for a run without losing its id, priority, or
description.

Patterns support `step_type`, `name_contains`, `name_regex`, `input_contains`, and
`output_contains`. `guard add` rejects an unusable pattern (an invalid or unsafe
`name_regex`, a non-string match value, a `step_type` that isn't a real step type
— e.g. `"toolcall"` for `tool_call` — or a pattern with no recognized match key,
e.g. a typo'd key) so a blocking policy can never be stored in a form that
silently fails to match. If a malformed policy is somehow
present anyway, a `deny`/`require_review` policy fails *closed* (treats the step
as a match) rather than letting it through. The one exception is a completely
empty pattern, which stays inert even for a `deny`: it expresses no intent to
filter, and blocking every step would be worse than the misconfiguration.

**`output_contains` cannot block live.** Enforcement evaluates a *proposed* tool
call — before it runs, so it has no output yet — and every match key in a pattern
must match. A `deny` or `require_review` keyed on `output_contains` therefore
never fires under `hook --enforce`, no matter how it looks in `guard list`. It
still matches in post-hoc evaluation (`guard test`, and `guard check` on a
recorded step), so it is a useful auditing pattern, not a blocking one; `guard
add` warns when you write one as a blocking policy.

**The most restrictive match wins.** When several policies match one step, the
verdict is the strictest of them — `deny` over `require_review` over `warn` over
`allow` — and `--priority` only breaks ties *among equally restrictive* matches,
deciding which policy is cited. So a broad `deny` plus a narrow, higher-priority
`allow` does **not** carve out an exception: the call is still denied. Express an
exception by narrowing the `deny` pattern itself.

`input_contains` and `output_contains` match against both the raw text and the
JSON form of the step's input/output, so a pattern containing quotes,
backslashes, newlines, or tabs matches as written — `rm -rf "/etc"` and
`C:\Windows\System32` both work, as do patterns aimed at the JSON itself like
`"cmd"`. Matching is case-insensitive.

### Export

```bash
# Export as JSON
agent-replay export --format json --output traces.json

# Export a single trace by id (accepts an id prefix, like show/why/replay)
agent-replay export <trace-id> --output one.json

# Export completed traces as JSONL
agent-replay export --format jsonl --status completed --output good.jsonl

# Build a golden dataset for regression testing
agent-replay export --format golden --tag production --output golden.json

# Include stored evals and per-step context snapshots
agent-replay export --format json --with-evals --with-snapshots --output full.json
```

An **empty** value for `--status`, `--agent`, `--tag` or `--since` is a usage
error (exit `2`), as it is for `list`. It matters more here, because `export`
writes: a widened `--agent ""` would dump the whole store into a file you
believed held one agent's traces, and a golden baseline built that way then
gates CI on runs it was never meant to cover.

A trace id and the filter flags (`--status`, `--agent`, `--tag`, `--since`) are
mutually exclusive: pass an id to export exactly one trace, or filters to export a
set. Combining them is a usage error rather than silently ignoring the filters.

### Dashboard

```bash
# Full-screen terminal dashboard with charts and stats
agent-replay dashboard

# Custom refresh interval
agent-replay dashboard --refresh 10
```

Keyboard: `q` quit, `r` refresh, arrow keys navigate.

The dashboard needs an **interactive terminal**: it takes over the screen and
exits on a keypress, so with stdout redirected or in CI it refuses with exit `2`
and writes nothing to stdout, pointing at `stats --json` instead. (Otherwise it
would hang forever, having already emitted alt-screen and mouse-tracking escape
sequences into the log.) `--refresh` is capped at `2147483` seconds — above that
Node's timer overflows and clamps to 1 ms, refreshing about a thousand times a
second, the inverse of what was asked — also exit `2`.

### Stats

A non-interactive summary of the store — the same aggregates the dashboard shows, but printable to a log and scriptable in CI (where the full-screen dashboard can't run).

```bash
# Overall counts, per-status, and per-agent breakdown
agent-replay stats

# Only count activity in a recent window (like `list --since`)
agent-replay stats --since 7d
agent-replay stats --since 2026-08-01

# JSON for piping into jq / a CI check
agent-replay stats --json
```

The `--json` shape is `{ since, overall, by_status, by_agent }`. `overall` carries `traces`, `steps`, `evals`, `policies`, `avgDurationMs`, `avgDurationSample`, `totalTokens`, `totalTokensSample`, `totalCost` and `totalCostSample` — **each `*Sample` is how many traces the figure beside it was actually taken over**. A trace that is still running, or whose timestamps no format can parse, has no measurable duration and is skipped; tokens and cost are recorded only when a producer reports them, so both totals are sums over a subset. Read alone, any of the three can describe far fewer runs than `traces`. The panel says `(over N of M)` on each one when they differ. `by_agent` lists each agent's trace `count` and a `failed_or_timeout` tally, most-active first (named for what it counts, so it can't be read as failures alone alongside `by_status`). `--since` windows every count to traces started at or after the cutoff (steps and evals by their parent trace's start time); the active-policy count is current config and is never windowed. A malformed `--since` is a usage error (exit `2`). **Forks are excluded from every count**, as they are from `check` and `export --format golden` — a fork is a never-executed copy, so counting it would report spend that never happened. `stats` can therefore report fewer traces than `list`, which shows them.

### Configuration

```bash
# Show current config
agent-replay config list

# Set an API key for AI-powered evaluation
agent-replay config set ai.api_keys.anthropic sk-ant-...
agent-replay config set ai.api_keys.google AIza...
agent-replay config set ai.api_keys.openai sk-...

# Choose a specific provider instead of auto-detect
agent-replay config set ai.provider anthropic

# Pin a model, and raise the judge's output ceiling if verdicts get truncated
agent-replay config set ai.model claude-haiku-4-5-20251001
agent-replay config set ai.max_tokens 4096

# Test that your API key works
agent-replay config test-ai

# Read a config value
agent-replay config get ai.provider
```

You can also set API keys via environment variables: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`. Environment variables take priority over config file values.

`ai.max_tokens` caps the model's reply on every AI path — `eval --ai` and `diff --ai` alike (default 1024) — and is what the `--max-cost` estimate prices, so raising it raises both the ceiling and the quoted cost. `ai.model` is only applied to a provider it belongs to — a `claude-*` model is never sent to OpenAI.

`config set` refuses an **empty** value (exit `2`): a blank key was stored, then
displayed as `***` by `config get` — looking set — while every check downstream
treated it as unset, so `test-ai` told you to set the key you had just set. To
clear a value, re-run `agent-replay init --force`.

A config file that exists but **cannot be parsed** is reported as its own error,
naming the file and the parse position, rather than as "no configuration found"
— which used to send you to `init`, which then said the store was already
initialized. `config set` also writes back only the key you named: a value it
had to ignore (say a `ai.max_tokens` typed as a string) stays on disk, so it is
still reported and still fixable.

`traces.db` and `config.json` are created owner-only (`0600`) — a trace holds
prompts, tool inputs and tool outputs, and the config holds API keys in
plaintext. A directory `agent-replay` creates for itself is `0700` as well; a
directory that already exists is left exactly as you set it, since the mode of a
directory you made is your decision. The file modes are set at creation only, so
if you deliberately open a store up it stays open.

## Exit codes

Every command exits non-zero on failure, so it drops cleanly into scripts and CI:

| Code | Meaning |
| ---- | ------- |
| `0`  | Success — including "no matches" for queries like `list` and empty exports. |
| `1`  | Runtime failure — trace not found, a malformed ingest, a `record` stream whose every event was rejected, an `import` that found nothing to import (no steps and no prompt), a `check --golden` regression, or an `eval` that fails (a rubric below its threshold or a built-in preset that fails). |
| `2`  | Usage error, or a command refusing an environment it cannot run in (`dashboard` without an interactive terminal; any read command pointed at a directory with **no trace store** — run `agent-replay init` there, or pass `--dir`) — an unknown flag, an unknown command, a missing, empty or bad argument value, or an unexpected extra argument (a typo'd second id or a bare word meant to be a flag is rejected, not silently ignored). Also the **guard block** signal: `guard check` exits `2` when a policy denies a step (the harness "block" convention), as does `hook --enforce --dialect other`. `guard check` fails closed, so it also answers `2` — with a `deny` verdict on stdout — for a step it cannot evaluate at all: unreadable or malformed stdin, a payload that isn't a step object, a missing `step_type`, a store it cannot open, or a store holding no enabled policies (a gate that can never fire; pass `--allow-empty` if that is deliberate). For a detected harness dialect, `hook --enforce` answers with that harness's own JSON on stdout and exits `0` — the block is the JSON, not the code — so don't gate a script on `$?` there. |

Two commands instead propagate a child's own status: `run` exits with the wrapped command's exit code, and `hook` (capture mode) always exits `0` so it can never interfere with the host agent.

Under `--json`, a failure is still answered **as JSON on stdout** — `{"ok": false, "error": "...", "hints": [...]}` — so a `| jq` pipeline gets a document it can read on every outcome rather than a parse error. The exit code is unchanged by the output shape.

## Evaluation Presets

### Deterministic Presets

These run instantly with no API key required.

**hallucination-check** — Detects hallucination indicators:
- Flags excessive hedging language (30%)
- Checks if output is grounded in retrieval content (40%)
- Verifies no failed steps and no trace-level error (30%, **critical** only when the run itself ended badly — see below)
- Threshold: 0.7

**safety-check** — Detects safety concerns:
- Flags dangerous tool calls like delete/drop/destroy (40%)
- Checks for PII in output (SSN, credit card, email patterns) (30%)
- Detects prompt injection patterns (30%)
- Threshold: 0.8

**completeness-check** — Validates execution completeness:
- Ensures the run produced an answer — an output step, a trace-level output, or a final step that carried output (40%)
- Verifies all tool calls have output (30%, **critical**)
- Checks the trace didn't end with an unresolved error (30%, **critical**)
- Threshold: 0.7

A step counts as failed if its `step_type` is `error` **or** it carries an
`error` value. That matters because the live capture paths (`hook`, `record`,
`import`) record a failed tool as a `tool_call` step with `error` set rather
than as a separate `error` step. Both error criteria also fail on a trace-level
`error`, so a run that died before emitting a final step is caught.

A **critical** criterion fails its preset on its own when it scores 0, whatever
the weighted total says, and the report names which one forced the verdict in a
`failed_critical` list. The weights are 0.4/0.3/0.3 against a 0.7 threshold, so
a lone zeroed 0.3-weight criterion lands on exactly 0.7 and would otherwise
pass — meaning the criterion that detects a failed run could never fail the
preset by itself.

`hallucination-check`'s `no_error_steps` is critical *conditionally*: only when
the run itself ended badly (a trace-level `error`, or status `failed` or
`timeout`). A step error the run recovered from — one tool call that failed and
was retried successfully, on a trace that completed — still costs the criterion
its full 0.3 weight, but does not hard-fail the preset. Otherwise every imported
session containing a single failed shell command would fail outright, while
`completeness-check` called the same trace complete. So a recovered step failure
scores exactly 0.7 and **passes**; if you want any step failure to fail a gate,
use `check --golden` (whose `step_errors` field compares per-step outcomes) or a
custom rubric.

A custom rubric searches what each criterion is actually asserting about:
`expected: false` ("must not contain") sees the whole run — trace input, output
and error, plus every step's name, input, output and error — while
`expected: true` ("must contain") sees only what the run produced, the trace
output and the step outputs. Otherwise a criterion asserting the answer cites a
source is satisfied by the prompt that asked for one. A pattern that cannot be
used — an invalid regex, or one refused as a backtracking risk (a quantified
group containing alternation, or nested quantifiers) — is a usage error naming
the pattern, never a failing criterion: a rejected pattern must not read as a
quality problem with the trace.

### AI-Powered Presets

These require an API key. They use the cheapest models by default (see the provider table below for the current defaults) and typically cost less than $0.01 per evaluation.

**ai-root-cause** — For failed traces. Identifies what went wrong, which step caused it, contributing factors, and suggests a fix. Returns a confidence score.

**ai-quality-review** — Scores any trace on four dimensions: relevance, completeness, coherence, and accuracy (each 1-10). Returns an overall quality score.

**ai-security-audit** — Checks for prompt injection, data exfiltration, unauthorized access patterns, and privilege escalation. Returns a risk level (none/low/medium/high/critical) and specific findings.

**ai-optimization** — Analyzes token efficiency and identifies redundant steps, unnecessary tool calls, and wasted context. Returns an efficiency score and specific optimization suggestions.

### Custom Rubrics

Create a YAML or JSON file with pattern-based criteria:

```yaml
name: my-custom-check
threshold: 0.8
criteria:
  - name: has_greeting
    pattern: "hello|hi|welcome"
    expected: true
    weight: 1
  - name: no_profanity
    pattern: "badword1|badword2"
    expected: false
    weight: 2
```

```bash
agent-replay eval <trace-id> --rubric my-rubric.yaml
```

## Trace Format

To ingest your agent's execution data, export it as JSON matching this structure:

```json
{
  "agent_name": "my-agent",
  "agent_version": "1.0.0",
  "trigger": "user_message",
  "status": "completed",
  "input": { "task": "book a flight to Tokyo" },
  "output": { "result": "Flight booked: AA 1234" },
  "started_at": "2026-02-27T10:00:00.000Z",
  "ended_at": "2026-02-27T10:00:03.200Z",
  "total_duration_ms": 3200,
  "total_tokens": 4500,
  "total_cost_usd": 0.018,
  "error": null,
  "tags": ["production"],
  "steps": [
    {
      "step_number": 1,
      "step_type": "thought",
      "name": "analyze_request",
      "input": { "message": "book a flight to Tokyo" },
      "output": { "intent": "flight_booking" },
      "duration_ms": 120,
      "tokens_used": 400
    },
    {
      "step_number": 2,
      "step_type": "tool_call",
      "name": "search_flights",
      "input": { "destination": "TYO" },
      "output": { "flights": ["AA 1234", "UA 5678"] },
      "duration_ms": 800,
      "tokens_used": 200
    }
  ]
}
```

Only `agent_name` is required. Everything else is optional.

### Decision & structure fields

Traces and steps carry optional fields that record *why* an agent acted, not just *what* it did. All are backward compatible — omit them and a flat trace remains fully valid.

| Field | On | Meaning |
|-------|----|---------|
| `session_id` | trace | Correlation key grouping traces from one harness session/conversation (e.g. a Claude Code / Codex `session_id`, a Gemini `session.id`, or an app conversation ID) |
| `parent_step` | step | Step number of the parent — nests subagents and nested calls into a tree. Must reference an earlier step. (Stored and returned by `show --json` as `parent_step_number`.) |
| `caused_by_step` | step | Step number that triggered this step. Must reference a strictly earlier step (chains are acyclic). (Stored and returned by `show --json` as `caused_by_step_number`.) |
| `decision` | step | Structured decision record, valid on a step of any type (see below) |

A `decision` block:

```json
{
  "step_number": 4,
  "step_type": "decision",
  "name": "rank_options",
  "caused_by_step": 3,
  "decision": {
    "options": [
      { "option": "fl_1", "rationale": "nonstop, lowest price", "score": 0.92 },
      { "option": "fl_2", "rationale": "nonstop but pricier", "score": 0.74 }
    ],
    "chosen": "fl_1",
    "rationale": "Nonstop matches the user preference; lowest price among nonstops.",
    "confidence": 0.92,
    "decided_by": "agent"
  }
}
```

`decided_by` is one of `agent` (the model chose), `user` (a human at a permission prompt), or `policy` (a policy engine). `confidence` is between 0 and 1. Inspect these with [`show --tree`](#inspect), [`why`, and `decisions`](#explain-decisions).

> **How values are stored, exactly.** Three things are worth knowing before you
> compare a trace to what you sent:
>
> - **`input` and `output` keep their type.** A string stays a string — a tool
>   that returns the text `null`, `42` or `true` reads back as that text, not as
>   JSON null, a number or a boolean. A string that is genuinely an object or an
>   array (`{...}`, `[...]`) is stored as the structure it spells, so a producer
>   that hands over pre-serialized JSON — an OTel attribute, a harness payload —
>   gets structure back rather than a quoted blob.
> - **`error` is text.** The column is TEXT, so a structured error object is
>   flattened to JSON text and reads back as a string. It round-trips stably
>   (export → ingest → export is identical), but it is not returned as the
>   object you sent.
> - **Trace-level totals are taken at face value.** `total_tokens`,
>   `total_duration_ms` and `total_cost_usd` are stored as the producer reported
>   them and are never reconciled against the steps, so a producer that reports a
>   total disagreeing with its own steps is what `stats` will report. Only when a
>   total is *absent* do the per-step counts fill in. (The one exception is the
>   OpenTelemetry receiver's cross-batch merge, which recomputes as it
>   assembles.)

> **Schema migration:** these fields arrived in schema v2; the current schema is v6 (v3 through v6 add indexes only, no columns). Databases created by earlier versions upgrade automatically the next time they are opened — every existing row is preserved with the new fields defaulting to null. The upgrade is one-way (there is no down-migration).

### Step Types

| Type | Description |
|------|-------------|
| `thought` | Agent reasoning or planning |
| `tool_call` | External tool invocation |
| `llm_call` | LLM API call |
| `retrieval` | RAG / document retrieval |
| `output` | Response delivery |
| `decision` | Decision point |
| `error` | Error occurred |
| `guard_check` | Guardrail policy check |

## Guardrail Policies

Policies match against trace steps and trigger actions.

### Match Pattern

```json
{
  "step_type": "tool_call",
  "name_contains": "delete",
  "name_regex": "drop|destroy",
  "input_contains": "production",
  "output_contains": "error"
}
```

Every field is optional individually, but a pattern must include at least one of
them — an empty pattern (or one with only unrecognized keys) is rejected, since it
would match nothing. When multiple fields are specified, all must match (AND logic). `name_contains` does a case-insensitive substring match; `name_regex` uses a regular expression.

Both sides of a match are **Unicode-folded** first (NFKC, with zero-width and soft-hyphen characters removed), so a policy matches the name an operator meant: `name_contains: "delete"` blocks `DELETE_USER`, the fullwidth `ｄｅｌｅｔｅ_user`, and `delete_user` with a zero-width space inside it. Folding can only make a policy match more — for a guard that is the safe direction, since an over-match is a blocked call you can see and amend, while an under-match runs the call you meant to stop. A `name_regex` is tested against the raw name and the folded one.

### Actions

| Action | Description |
|--------|-------------|
| `allow` | Explicitly allow matching steps |
| `deny` | Block matching steps |
| `warn` | Flag for review |
| `require_review` | Require human review before proceeding |

## AI Provider Setup

`agent-replay` auto-detects your API key. A configured `ai.model` naming a known family picks its own provider first (a `claude-*` model chooses Anthropic if that key is present); otherwise the order is:

1. **Anthropic** (default model: `claude-haiku-4-5-20251001`)
2. **Google Gemini** (default model: `gemini-2.5-flash-lite`)
3. **OpenAI** (default model: `gpt-5.4-nano`)

Set a key via environment variable or config:

```bash
# Environment variable (recommended)
export ANTHROPIC_API_KEY=sk-ant-...

# Or store in config
agent-replay config set ai.api_keys.anthropic sk-ant-...

# Verify it works
agent-replay config test-ai
```

All AI presets use the cheapest available model. A typical evaluation costs less than $0.01.

Every provider call has a **60-second deadline** and retries a transient failure **twice** with a doubling backoff (0.5s, then 1s), honoring a `Retry-After` header when the provider sends one. So a routine rate limit or a 503 no longer fails a whole `eval --ai` run, and a provider that accepts the connection and then stalls can no longer hang an unattended CI job — it fails with `Request timed out after 60000ms`. A bad key, a malformed request (4xx) and an unparseable reply are *not* retried; they cannot succeed on a second attempt. Failed attempts consume no tokens, so retries don't change what `--max-cost` prices.

## Programmatic API

You can also use `agent-replay` as a library:

```typescript
import { ensureDatabase, ingestTrace, getTrace } from 'agent-replay';

const db = ensureDatabase('.agent-replay/traces.db');
const trace = ingestTrace(db, {
  agent_name: 'my-agent',
  status: 'completed',
  steps: [{ step_number: 1, step_type: 'output', name: 'answer', output: { text: 'done' } }],
});
const full = getTrace(db, trace.id); // trace with its steps, evals, and decisions
```

To record a run live from TypeScript, use the `TraceRecorder` SDK — the same incremental engine the `record` command uses, no files or subprocess required:

```typescript
import { ensureDatabase, TraceRecorder } from 'agent-replay';

const db = ensureDatabase('.agent-replay/traces.db');
// Or bring your own better-sqlite3 handle (e.g. in-memory) and init the schema:
//   import Database from 'better-sqlite3';
//   import { runMigrations } from 'agent-replay';
//   const db = new Database(':memory:'); runMigrations(db);
const rec = new TraceRecorder(db);

rec.startTrace({ agent_name: 'my-agent', session_id: conversationId, input: { task } });
rec.startStep({ step_number: 1, step_type: 'tool_call', name: 'search' });
rec.endStep(1, { output: results, tokens_used: 120 });
rec.endTrace({ status: 'completed', output: answer, total_tokens: 120 });
```

These functions validate their own arguments: an invalid `status` or `step_type` throws an error naming the value and the valid set, rather than surfacing a database constraint.

The two entry points differ on purpose, and in one direction only. `ingestTrace` is a **batch** import, so it refuses a malformed trace outright and names the field. `TraceRecorder` is **live capture**, where one bad field must never cost you the step: a decision `confidence` outside `[0, 1]` and an unrecognized `decided_by` are normalized away (to `null` and `agent`) and the decision is kept, exactly as an unusable `tokens_used` or a forward causal reference already are. Both rules exist for the same reason — **a trace written through the SDK can always be re-ingested from its own export**, which is what the golden-regression gate depends on.

## Development

```bash
git clone <repo-url>
cd agent-replay
npm install
npm run verify    # typecheck + build + test
npm run dev       # watch mode
```
