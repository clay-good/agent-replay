# Tasks — add-otel-ingest

## 1. OTLP/HTTP receiver

- [x] 1.1 `agent-replay otel serve [--port 4318] [--idle-timeout]`: HTTP server with `POST /v1/traces` and `POST /v1/logs`
- [ ] 1.2 Decode `application/x-protobuf` (vendored OTLP descriptors) and `application/json` (honoring OTLP/JSON quirks: camelCase, hex traceId/spanId, integer enums, string int64s); gzip request bodies
- [x] 1.3 Respond per spec: 200 + empty object on success, 200 + `partial_success` with `rejected_spans`/`error_message` on partial acceptance, matching response encoding
- [ ] 1.4 Test: fixture OTLP payloads in both encodings round-trip; malformed body → 400

## 2. GenAI semconv span mapping

- [x] 2.1 Map spans: `invoke_agent`/`invoke_workflow` root → trace (`gen_ai.agent.name` → agent_name, `gen_ai.conversation.id` → session_id); `execute_tool` → tool_call; `chat`/`generate_content`/`text_completion` → llm_call; `embeddings`/`retrieval` → retrieval; `plan` → thought; parentage → `parent_step`; ERROR status + `error.type` → step error
- [x] 2.2 Token accounting: `gen_ai.usage.input_tokens`/`output_tokens` + cache/reasoning sub-counts → step tokens and trace totals
- [x] 2.3 Alias table: `gen_ai.system`→`gen_ai.provider.name`, `prompt_tokens`/`completion_tokens`→new names, era-1/era-2/era-3 message-content forms → step input/output; unmapped `gen_ai.*` attributes preserved in metadata
- [x] 2.4 Orphan spans (no agent root) grouped into a synthetic trace per OTel trace ID
- [x] 2.5 Test: fixture span trees from GenAI semconv examples produce correct trace/step/hierarchy/token results across convention vintages

## 3. Dialect fallbacks

- [x] 3.1 OpenInference: `openinference.span.kind` (AGENT/CHAIN → trace anchors; TOOL → tool_call; LLM → llm_call; RETRIEVER/EMBEDDING → retrieval; GUARDRAIL → guard_check) with its input/output value attributes
- [ ] 3.2 OpenLLMetry: `traceloop.*` span attributes mapped equivalently
- [ ] 3.3 Test: fixture payloads from OpenInference- and OpenLLMetry-instrumented runs ingest correctly

## 4. Known-emitter log-event mappers

- [ ] 4.1 Gemini CLI: `gemini_cli.user_prompt` → trace input; `gemini_cli.tool_call` (`function_name`, `function_args`, `duration_ms`, `success`, `decision`) → tool_call step + decision record (`decided_by` user/policy); `gemini_cli.api_response` token counts → totals; `session.id` → session_id
- [ ] 4.2 Claude Code: `claude_code.user_prompt`, `claude_code.tool_result`, `claude_code.tool_decision`, `claude_code.api_request`/`api_response` → steps and totals; `session.id` → session_id
- [ ] 4.3 Test: fixture log-event batches from both CLIs produce coherent traces without spans present

## 5. Docs

- [ ] 5.1 README: per-harness two-line setup (Gemini CLI `telemetry: {enabled, target: "local", otlpEndpoint: "http://localhost:4318", otlpProtocol: "http"}`; Claude Code `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, beta traces flag; Goose/OpenHands `OTEL_EXPORTER_OTLP_*`); call out the gRPC/4317-default pitfall and content-capture opt-ins
- [ ] 5.2 `npm run verify` passes
