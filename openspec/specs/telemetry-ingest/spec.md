# telemetry-ingest Specification

## Purpose
Beyond hooks and session files, the third capture surface the ecosystem has standardized on is OpenTelemetry with the GenAI semantic conventions (`gen_ai.*`). It is emitted natively by Gemini CLI (spans, log events, metrics), Claude Code (opt-in log events and metrics; trace spans in beta), OpenHands V1, Goose, and AutoGen/Microsoft Agent Framework, and by most Python agent frameworks via the OpenInference and OpenLLMetry instrumentation ecosystems. A local OTLP receiver lets agent-replay capture all of these without per-framework adapters — the same approach LangSmith and Langfuse converged on for their ingest endpoints.
## Requirements
### Requirement: Local OTLP/HTTP receiver

The system SHALL provide `agent-replay otel serve [--port 4318]`, a local OTLP/HTTP receiver accepting `POST /v1/traces` and `POST /v1/logs` in both `application/x-protobuf` and `application/json` encodings (responding in the encoding received, honoring the OTLP/JSON deviations: lowerCamelCase fields, hex-encoded `traceId`/`spanId`, integer enums, string-encoded int64s) with gzip support, returning 200 with an empty response on full success and 200 with `partial_success` details when records are rejected. Received telemetry SHALL be written to the trace store live.

#### Scenario: Gemini CLI exports to agent-replay

- **WHEN** Gemini CLI runs with `telemetry: {enabled: true, target: "local", otlpEndpoint: "http://localhost:4318", otlpProtocol: "http"}` while `agent-replay otel serve` is running
- **THEN** the session's telemetry is captured and queryable as a trace while the session is still active

#### Scenario: Partial acceptance reported per spec

- **WHEN** an export batch contains some undecodable spans
- **THEN** the receiver stores the valid spans and responds 200 with `partial_success.rejected_spans` and an `error_message`, so compliant SDK clients do not retry the batch

### Requirement: GenAI semconv span mapping

The system SHALL map OpenTelemetry GenAI semantic-convention spans onto the trace model: an `invoke_agent`/`invoke_workflow` root span becomes a trace (`gen_ai.agent.name` → agent name, `gen_ai.conversation.id` → session_id — never synthesized when absent); `execute_tool` spans (`gen_ai.tool.name`, `gen_ai.tool.call.id`) become `tool_call` steps; inference spans (`chat`, `generate_content`, `text_completion`) become `llm_call` steps with `gen_ai.request.model`; `embeddings` and `retrieval` become `retrieval` steps; `plan` becomes a `thought` step; span parentage becomes step hierarchy; span status ERROR with `error.type` becomes step error; `gen_ai.usage.input_tokens`/`output_tokens` (plus cache and reasoning sub-counts) aggregate to token totals. Spans arriving without an agent root SHALL be grouped into a synthetic trace per OTel trace ID.

#### Scenario: Agent span tree becomes a trace

- **WHEN** an OpenHands or AutoGen run exports an `invoke_agent` root span with child `chat` and `execute_tool` spans
- **THEN** one trace is created whose steps mirror the span tree, with `parent_step` reflecting span parentage and token totals summed from `gen_ai.usage.*`

### Requirement: Convention-drift tolerance

The system SHALL normalize known deprecated GenAI attribute forms through an alias table — `gen_ai.system` (renamed to `gen_ai.provider.name` in semconv v1.37.0), `gen_ai.usage.prompt_tokens`/`completion_tokens` (renamed in v1.27.0), and all three generations of message-content capture (`gen_ai.prompt`/`gen_ai.completion` attributes; per-message events such as `gen_ai.user.message`; current `gen_ai.input.messages`/`gen_ai.output.messages`/`gen_ai.system_instructions`) — and SHALL preserve unmapped `gen_ai.*` attributes in step metadata rather than dropping them, because the conventions are still status Development with no stable release to pin.

#### Scenario: Older instrumentation still ingests

- **WHEN** a source emits `gen_ai.system: "openai"` and `gen_ai.usage.prompt_tokens: 1200`
- **THEN** the trace records provider `openai` and 1,200 input tokens exactly as if the current attribute names had been used

### Requirement: OpenInference and OpenLLMetry fallbacks

The system SHALL additionally map the two widespread instrumentation dialects when GenAI attributes are absent: OpenInference (`openinference.span.kind` values AGENT/CHAIN → trace anchors, TOOL → `tool_call`, LLM → `llm_call`, RETRIEVER/EMBEDDING → `retrieval`, GUARDRAIL → `guard_check`) and OpenLLMetry (`traceloop.*` attributes) — the same trio of dialects LangSmith and Langfuse accept on their OTel endpoints.

#### Scenario: OpenInference-instrumented framework captured

- **WHEN** a LlamaIndex app instrumented with OpenInference exports spans with `openinference.span.kind: "TOOL"`
- **THEN** those spans become `tool_call` steps without requiring GenAI attributes

### Requirement: Known-emitter log-event enrichment

The system SHALL recognize the log events of the two CLIs that emit richer signal as logs than as spans: Gemini CLI (`gemini_cli.user_prompt` → trace input; `gemini_cli.tool_call` with `function_name`, `function_args`, `duration_ms`, `success`, and `decision` accept/reject/modify/auto_accept → a `tool_call` step plus a decision record attributed to user or policy; `gemini_cli.api_response` token counts → totals; common attribute `session.id` → session_id) and Claude Code (`claude_code.user_prompt`, `claude_code.tool_result`, `claude_code.tool_decision`, `claude_code.api_request`/`api_response`). Content fields SHALL be stored only when present — both CLIs redact prompt/response content unless the user opts in on their side (`telemetry.logPrompts`, `OTEL_LOG_USER_PROMPTS=1`).

#### Scenario: Gemini tool rejection becomes a decision record

- **WHEN** a `gemini_cli.tool_call` event arrives with `decision: "reject"`
- **THEN** the step is recorded with a decision record whose `decided_by` is `user` and whose chosen option is `reject`

