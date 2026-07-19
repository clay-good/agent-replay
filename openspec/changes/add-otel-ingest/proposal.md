# Add OpenTelemetry Ingest

## Why

Beyond hooks and session files, the third capture surface the ecosystem has standardized on is OpenTelemetry with the GenAI semantic conventions (`gen_ai.*`). It is emitted natively by Gemini CLI (spans, log events, metrics), Claude Code (opt-in log events and metrics; trace spans in beta), OpenHands V1, Goose, and AutoGen/Microsoft Agent Framework, and by most Python agent frameworks via the OpenInference and OpenLLMetry instrumentation ecosystems. A local OTLP receiver lets agent-replay capture all of these without per-framework adapters — the same approach LangSmith and Langfuse converged on for their ingest endpoints.

## What Changes

- New `agent-replay otel serve [--port 4318]` command: a minimal local OTLP/HTTP receiver accepting `POST /v1/traces` and `POST /v1/logs` in both `application/x-protobuf` and `application/json` encodings, writing received telemetry into the trace store live
- **GenAI semconv mapping** from spans to the trace model: agent/workflow spans → traces, `execute_tool` spans → `tool_call` steps, inference spans (`chat`, `generate_content`, `text_completion`) → `llm_call` steps, `embeddings`/`retrieval` → `retrieval` steps, span parentage → step hierarchy, `gen_ai.usage.*` → token totals, `gen_ai.conversation.id` → `session_id`
- **Compatibility ingest** for the conventions' churn (they are still status: Development): deprecated aliases are accepted (`gen_ai.system` for `gen_ai.provider.name`, `prompt_tokens`/`completion_tokens` era token names, all three generations of message-content capture), plus attribute fallbacks for OpenInference (`openinference.span.kind`) and OpenLLMetry (`traceloop.*`) instrumented sources
- **Known-emitter refinements**: recognize Gemini CLI's `gemini_cli.*` log events (e.g., `gemini_cli.tool_call` with `function_name`, `function_args`, `duration_ms`, `decision`) and Claude Code's `claude_code.*` events to enrich steps with approval decisions and prompt/response content where the user enabled it

## Impact

- Affected specs: new capability `telemetry-ingest`
- Affected code: new `src/services/otel/` (receiver, protobuf/JSON decoding, semconv mapping), `src/commands/otel.ts`, `src/cli.ts`; new dependency for OTLP protobuf decoding
- Depends on `add-decision-trace-model` (hierarchy, sessions) and the WAL work in `add-live-trace-capture`
- Non-goal: OTLP/gRPC (many emitters default to gRPC on 4317 — docs must show switching them to HTTP, e.g. Gemini CLI `telemetry.otlpProtocol: "http"`, Claude Code `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`)
