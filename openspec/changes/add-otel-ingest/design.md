# Design — add-otel-ingest

## Context

Verified landscape (2026-07): the GenAI semantic conventions are status **Development** and were moved out of the main semconv repo into `open-telemetry/semantic-conventions-genai` at v1.42.0 (2026-06); there is currently no pinnable release of the new repo. Attribute names have churned repeatedly (`gen_ai.system` → `gen_ai.provider.name` in v1.37.0; `gen_ai.usage.prompt_tokens`/`completion_tokens` → `input_tokens`/`output_tokens` in v1.27.0; message capture went through three generations, currently `gen_ai.input.messages`/`gen_ai.output.messages`/`gen_ai.system_instructions` or the `gen_ai.client.inference.operation.details` event, with content off by default). Emitters in the wild therefore span several convention vintages, plus two parallel dialects: OpenInference (`openinference.span.kind` ∈ LLM/AGENT/TOOL/CHAIN/RETRIEVER/EMBEDDING/RERANKER/GUARDRAIL/EVALUATOR) and OpenLLMetry (`traceloop.*`). LangSmith and Langfuse both solved this the same way — one OTLP endpoint mapping all three dialects — which validates the approach.

## Goals / Non-Goals

- Goals: capture from OTel-native harnesses (Gemini CLI, Claude Code beta traces, OpenHands, Goose, AutoGen/MAF) and instrumented frameworks with zero per-framework code; tolerate convention drift; stay a transient local process, not a daemon
- Non-Goals: OTLP/gRPC (HTTP only; emitters are configurable), metrics ingest (aggregates without step structure — skip for v1), being a general-purpose observability backend, re-exporting to other collectors

## Decisions

### HTTP receiver on 4318, both encodings

Per the OTLP spec (v1.10.0, traces/logs stable), a compliant HTTP receiver listens on 4318, accepts `POST /v1/traces` and `/v1/logs` as `application/x-protobuf` or `application/json`, responds in the request's encoding, supports `Content-Encoding: gzip`, returns 200 with an empty response object on full success and 200 with `partial_success` (`rejected_spans`, `error_message`) on partial acceptance. OTLP/JSON has documented quirks we must honor: lowerCamelCase field names (`resourceSpans`, `startTimeUnixNano`), `traceId`/`spanId` as hex strings, enums as integers, int64 values as decimal strings. Protobuf decoding uses vendored OTLP descriptors — SDK defaults send protobuf, so JSON-only would miss most real emitters.

### Span mapping

Root agent span (`gen_ai.operation.name: invoke_agent` / `invoke_workflow`, or an OpenInference `AGENT`/`CHAIN` root) → one trace; `gen_ai.agent.name` → `agent_name`; `gen_ai.conversation.id` → `session_id` (never synthesized, per the conventions). Child spans map by operation: `execute_tool` (+ `gen_ai.tool.name`, `gen_ai.tool.call.id`) → `tool_call`; `chat`/`generate_content`/`text_completion` → `llm_call` with `gen_ai.request.model` → step model; `embeddings`/`retrieval` → `retrieval`; `plan` → `thought`. Span parent/child → `parent_step`; span status ERROR + `error.type` → step error. Orphan inference/tool spans with no agent root get a synthetic containing trace per OTel trace ID. `gen_ai.usage.input_tokens`/`output_tokens` (and the cache/reasoning sub-counts) aggregate to totals; `gen_ai.tool.call.arguments`/`result` and message-content attributes populate step input/output when present (they are opt-in on the emitter side).

### Alias table instead of version pinning

Because there is no semconv version to pin, ingest normalizes through an explicit alias table: `gen_ai.system` → `gen_ai.provider.name`; old token names → new; era-1 `gen_ai.prompt`/`gen_ai.completion` attributes and era-2 per-message events (`gen_ai.user.message` etc.) → the same step input/output fields as era-3 structured messages. Unmapped `gen_ai.*`/`openinference.*`/`traceloop.*` attributes are preserved in step metadata rather than dropped, so nothing is lost when the conventions move again.

### Known-emitter refinements as log-event mappers

Gemini CLI's richest signal is log events, not spans (spans are off by default there): `gemini_cli.tool_call` carries `function_name`, `function_args`, `duration_ms`, `success`, and `decision` (accept/reject/modify/auto_accept) — the last maps to a decision record with `decided_by: "user"`/`"policy"`. Claude Code's `claude_code.tool_result` and `claude_code.tool_decision` events map the same way. These mappers key on the event name prefix and run before the generic gen_ai mapping.

### Transient process, shared store

`otel serve` runs in the foreground (Ctrl-C to stop), writing through the same WAL-mode connection as `record`. Traces from OTel close when their root span arrives; a `--idle-timeout` finalizes stragglers as `timeout`.

## Risks / Trade-offs

- The conventions will change again (they are explicitly Development) — the alias table centralizes the churn; unknown attributes land in metadata, not the floor
- Many emitters default to gRPC/4317 — a hard setup pitfall; docs must lead with the two config lines per harness that switch to HTTP/4318
- Log-event-only emitters (Gemini CLI default) yield flatter traces than span emitters; acceptable, and `telemetry.traces: true` upgrades it

## Migration Plan

No schema change. New commands and services are additive.

## Open Questions

- Whether `/v1/metrics` is worth accepting-and-discarding (some SDKs fail the whole export batch if one signal endpoint 404s). Decide during implementation with a real Gemini CLI emitter test.
