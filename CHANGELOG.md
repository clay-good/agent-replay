# Changelog

All notable changes to `agent-replay` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A hardening pass focused on scriptability and CI use (consistent exit codes,
strict argument parsing), correctness of the comparison and evaluation paths
(`diff`, `eval`, cost estimation), and robustness of the OpenTelemetry receiver.
The recorded trace schema is unchanged.

### Added

- `export` now accepts an optional `[trace-id]` positional, so you can export a
  single trace by id (with prefix matching, like `show`/`why`/`replay`) instead
  of only bulk-filtering. A trace id and the filter flags (`--status`, `--agent`,
  `--tag`, `--since`) are mutually exclusive — passing both is a usage error
  (exit `2`) rather than silently ignoring the filters, and an unknown id exits
  `1`. Previously a trace id passed to `export` was silently dropped and the whole
  database was exported.
- The `otel serve` receiver now accepts `POST /v1/logs` in OTLP/protobuf as well
  as OTLP/JSON (it already accepted both on `/v1/traces`). OTLP exporters default
  to protobuf, so a Gemini CLI or Claude Code session left on the default
  protocol now has its log events ingested without switching the exporter to
  JSON. Malformed protobuf log bodies answer `400`, matching the traces path.

### Security

- `hook --enforce --no-input` no longer fails open on content-based guardrails.
  `--no-input` redacted the tool-call arguments before policy evaluation, not
  just before storage, so a `deny` / `require_review` policy keyed on the input
  (e.g. `input_contains: "rm -rf"`) silently never matched and the dangerous
  call was allowed — on exactly the shared machines where `--no-input` is used.
  Enforcement now evaluates the real arguments (held only in memory) while the
  stored tool-call input stays redacted. Name-based policies were unaffected.
- `hook --enforce` no longer downgrades a block to an allow when the audit write
  fails. The `guard_check` step is recorded after the verdict is decided but
  before it is returned, so a write error there (disk full, a locked database)
  propagated out and was swallowed into an exit `0`. The audit write is now
  best-effort — a failure is logged to stderr but the deny / require_review
  verdict is still returned, so the call is blocked (fail closed).
- The `otel serve` receiver now bounds request memory. It read the entire
  request body into memory unbounded and `gunzip`-ed it with no output limit, so
  a runaway or hostile client could exhaust memory — a gzip body decompresses at
  up to ~1000x, so a few KB could expand to gigabytes (a "zip bomb"). The
  receiver now caps the request body (32 MB) and the decompressed size (64 MB) —
  both far above any real OTLP batch — and answers `413` (not retryable) instead
  of crashing. Legitimate exporters are unaffected.

- Pinned transitive dependencies (`lodash`, `xml2js`, `esbuild`) to patched
  versions via a package `overrides` block, clearing 5 advisories that
  `blessed-contrib`'s latest release still pulls in transitively. `npm audit`
  now reports 0 vulnerabilities.

### Changed

- **Exit codes are now consistent across the CLI**, so scripts and CI can gate
  on `$?`: every failure exits non-zero — `1` for a runtime failure (not found,
  malformed input, a `check --golden` regression, an `eval` over its threshold)
  and `2` for a usage error or a `guard` / `hook --enforce` block. Success and
  empty results exit `0`; `run` propagates the child's status; `hook` capture
  always exits `0`. Previously several commands printed an error but still
  exited `0` (`export` invalid format, `guard add` invalid pattern/action,
  `import` with nothing importable, `watch`/`why` not-found, `diff --ai` with no
  provider, `demo --reset` refusal). A new "Exit codes" section in the README
  documents the convention.
- **Argument parsing now fails loudly on mistakes.** Every command rejects
  unexpected extra positional arguments instead of silently ignoring them, so
  `agent-replay show <id> <typo>` or `list production` (meant as `--tag
  production`) errors rather than quietly running on the first argument. And
  commander's own parse errors (unknown flag, unknown command, missing/excess
  argument) now exit `2` to match the documented "usage error" code — they
  previously exited `1`, contradicting the README's exit-code table.

### Fixed

- The `demo` dataset's two token totals that didn't add up are corrected: the
  `rag-context-pollution` and `successful-booking` sample traces declared a
  `total_tokens` 1,000 higher than their steps summed to, so `show` (which
  prints the stored total) and `replay` (which re-sums the steps) displayed
  different token counts for the same trace. Each declared total now equals its
  step sum, and a test asserts the invariant for every demo scenario.
- `record --format gemini-stream` no longer loses a tool result that is a plain
  string. The `tool_result` handler stored a bare string verbatim, which then
  failed to `JSON.parse` on read and came back as `null`; it now wraps a string
  as `{ output: <string> }`, matching how the `message` handler already wraps
  string content.
- `import`'s "records imported / skipped" report now accounts for a
  content-less user/assistant record (it produced no step but was previously
  counted as neither), so the tally the command prints matches the number of
  records in the file.
- `import` of a Claude Code transcript with subagent files now reports "Records
  imported" as a count of records, not steps. The subagent loop added the number
  of steps produced to the imported total, so one subagent record that expanded
  to several steps inflated the count (e.g. "3 records imported" from 2 input
  records) and broke the imported + skipped = records invariant. Each subagent
  record is now counted once — imported if it yielded a step, skipped otherwise.
- `import` of a Claude Code transcript no longer discards an entire subagent
  file because of one corrupt line. The subagent path parsed every line inside a
  single `try`, so a truncated final line (common after a killed run) dropped all
  of that subagent's steps and left an orphan anchor. It now parses line by line
  and skips only the bad line, matching the main-transcript path.
- `config set ai.max_tokens` rejects a non-positive-integer value instead of
  silently coercing it: `abc` and `0` used to become 1024 (while still printing
  "= abc"), and a negative was stored as-is and would break API calls.
- `agent-replay run` no longer corrupts non-ASCII event data. The incremental
  reader decoded raw byte slices with `Buffer.toString('utf-8')`, so a multi-byte
  UTF-8 character straddling a 200ms poll boundary (or a partial child write)
  turned into replacement characters. It now decodes through a `StringDecoder`,
  which buffers an incomplete byte sequence until the rest arrives.
- `diff` now shows the value of a step that exists on only one trace. A
  right-only step (`+ Right only`) rendered its value as `(none)` in the Right
  column instead of the actual step; both one-sided cases now display the
  present value.
- `config get` no longer prints API keys in plaintext. Fetching an object path
  (`config get ai` or `config get ai.api_keys`) dumped the raw object, bypassing
  the masking that `config list` and the scalar path already applied; the object
  branch now masks API keys recursively, and the scalar path masks even a short
  value.
- **Guardrails now fail closed on a malformed pattern (safety).** A blocking
  policy whose `name_regex` was invalid or ReDoS-rejected used to silently never
  match — a kill-switch that quietly did nothing. `guard add` now rejects an
  unusable pattern (bad/unsafe `name_regex`, or a non-string `name_contains` /
  `input_contains` / `output_contains`) so it can't be stored, and at evaluation
  time a `deny` / `require_review` policy with an unusable regex treats the step
  as a match (fails closed) instead of skipping it. Non-string match values no
  longer throw mid-evaluation (which, under `hook --enforce`, had let the pending
  tool call through).
- `fork --modify-context` no longer silently drops the modification. It was
  applied only by mutating a snapshot that already existed at the fork-point
  step, but snapshots are optional and most steps have none — so a fork at a
  snapshot-less step discarded the context while the CLI still reported
  "Modified context: Yes". `forkTrace` now creates a snapshot at the fork point
  when one is needed, and the modified context lands in `context_window` (the
  field the flag names and that `show --snapshots` renders) instead of
  `environment`; any other snapshot fields are still copied.
- `check --golden` no longer reports spurious regressions when several traces
  share an agent name and input (repeated runs of the same agent, or a fork):
  golden entries are bucketed and each candidate is paired with its closest
  entry instead of colliding on one.
- `check --golden` no longer consumes a golden entry once a candidate matches
  it. A bucket can hold several known-good shapes for one agent+input, and a
  candidate is good if it reproduces any of them — but the greedy pairing
  removed the matched entry, so a second candidate identical to the first was
  forced onto a leftover shape and falsely flagged `REGRESSED` (failing CI),
  and, when the bucket emptied, a genuinely regressed candidate could be hidden
  as merely "unmatched". Each candidate now compares against the whole bucket
  without consuming, so identical known-good traces all pass.
- `ingest` recognizes a pretty-printed (multi-line) single JSON object instead
  of misparsing it as JSONL and failing on "line 1"; the format is now detected
  by a whole-file parse.
- `eval --max-cost` rejects a malformed value instead of silently falling back
  to an unlimited budget — a typo like `0.O5` no longer disables the spend cap.
- `eval --ai` cost estimation no longer bills a preset that won't run. A preset
  gated by applicability (`ai-root-cause` only runs on a failed trace) is
  skipped at run time for $0, but the estimate charged it anyway — so the
  `--max-cost` pre-gate could abort a run over a successful trace even when the
  actual spend would have fit the budget. The estimate now charges $0 for a
  non-applicable preset, matching what runs.
- `getTrace` (and every command that resolves a trace id) now prefers an exact
  id match and resolves prefix collisions deterministically, rather than letting
  `LIMIT 1` return an arbitrary row. This only affects custom/short trace ids
  where one id prefixes another; generated ids are fixed-length and unaffected.
- AI-eval cost estimation no longer reports a misleading `$0.00` for a model
  outside the built-in price table. `estimateCost` now (a) matches a versioned
  or shortened model id to its family rate (e.g. `gpt-5.4-nano-2025-12-01` →
  `gpt-5.4-nano`) and (b) falls back to the most expensive known rate for a
  genuinely unknown model. This also restores the `eval --max-cost` budget cap,
  which gates on `estimate > cap` and so was silently bypassed whenever the
  estimate was a false `0`.
- `attachSnapshot` now replaces a step's snapshot atomically (delete + insert in
  one transaction), matching `attachDecision`. Previously a failed insert — e.g.
  a context window that can't be serialized — left the step with its old
  snapshot deleted and no replacement.
- `diff` compares step `input`/`output` by parsed value instead of raw stored
  JSON text, so two traces carrying the same data serialized with different
  object-key order or whitespace (e.g. an OTLP-ingested trace vs. a
  hook-recorded one) no longer report a phantom diff and mis-pin
  `divergence_step` — which had been feeding the AI diff analysis a false
  divergence point. Genuine value differences are still reported. Uses the same
  `stableStringify` normalization `check --golden` already applies to inputs.
- `diff` aligns steps by `step_number` (a merge-join) instead of by array
  position. Step numbers may have gaps — validation only requires each be a
  positive integer — and pairing by index then compared unrelated steps: a
  trace numbered `1, 2, 4` diffed against `1, 2, 3, 4` reported phantom
  differences on step 4 and pinned the divergence there, when in fact step 3
  was simply right-only. A number present on only one side is now a one-sided
  step and matching numbers are compared field-by-field, so `divergence_step`
  and the AI diff analysis anchor to the real divergence.
- `diff --fields` recomputes the divergence point from the filtered results, so
  it no longer prints a "DIVERGES AT STEP N" banner above "0 difference(s)
  found" (or emit a `--json` `divergence_step` inconsistent with its own
  `diffs`) when the requested field has no difference.
- `eval` now exits `1` when an evaluation fails (a custom rubric scores below
  its threshold, or a built-in preset fails), matching the README's exit-code
  table. Previously it always exited `0` regardless of the result, so it could
  never fail a CI job — defeating the "build regression tests" use case. `--json`
  gates too. A passing eval, and a trace-not-found/no-provider/over-budget error,
  are unchanged.
- `list --limit`, `otel serve --port`, and `dashboard --refresh` reject a
  malformed value (non-integer, out of range) with a usage error instead of
  silently falling back to the default or, for a negative `--limit`, passing it
  to SQL `LIMIT` where SQLite reads it as "no limit". Previously `list --limit
  abc` quietly returned the default page and `otel serve --port abc` bound the
  default 4318, so an exporter pointed at the intended port connected to nothing.
- `list --limit`, `otel serve --port`, and `dashboard --refresh` now consume the
  same parse they validate. Each validated with `Number()` but then re-parsed
  the raw string with `parseInt`, and the two disagree on values like `0x20`
  (`Number` → 32, `parseInt` → 0) or `1e2` (100 vs 1): the input passed
  validation but ran with a different number — `list --limit 0x20` executed
  `LIMIT 0` and reported a false "No traces found", and `otel serve --port 0x20`
  bound a random OS port. The validated integer is now the one used.
- The `otel serve` receiver no longer records an errored span as a successful
  trace. A span with `status.code=ERROR` but an empty `status.message` (the
  description is optional, and some OTLP/JSON exporters send `""`) produced an
  empty error string, which then read as "no error" — so the trace was stored as
  `completed` and the failure was invisible. An empty message now falls through
  to `error.type`, then a generic `error`, so an error span always marks the
  trace `failed` and carries a non-empty step error.
- The `otel serve` receiver answers client-malformed payloads (a `null`, array,
  or primitive JSON body, or a body that claims gzip but isn't) with `400`
  rather than `500`, so exporters don't retry an un-processable batch (5xx is
  retryable per the OTLP spec, 4xx is not).
- The `otel serve` receiver now assembles a logical trace whose spans arrive
  across several export batches into one agent-replay trace, instead of emitting
  one trace per batch. A `BatchSpanProcessor` routinely flushes completed child
  spans before the root span ends, so later batches now merge into the existing
  trace by OTel trace id (log events merge by session id) — re-linking a child
  to a parent stored earlier, recomputing the window and token totals, and
  upgrading the initially rootless synthetic trace to the real agent once the
  root arrives. Each batch is still stored immediately, so a trace stays
  queryable mid-session.
- OTel-ingested traces carry a trace-level end time and duration derived from
  their span times, instead of showing `-` for duration.
- `list` and `show` display a trace's duration derived from its start/end
  timestamps when an explicit total wasn't recorded, instead of showing `-`.
- `show` and `replay` validate their `--from-step`/`--to-step` window (and
  `replay --speed`): a non-numeric, `< 1`, or inverted range is a usage error
  instead of a silently empty view.
- A blank trace id is reported as "not found" instead of prefix-matching every
  trace and resolving to an arbitrary one, so `<cmd> ""` (e.g. an unset shell
  variable) fails cleanly.
- Opening a corrupt or non-SQLite database file reports a clear, actionable
  error instead of a raw `SqliteError` stack trace.

## [0.2.0]

This release grows agent-replay from a post-hoc trace debugger into an active
agent harness: it can capture runs live from the harnesses people already use,
enforce guardrails at the moment a dangerous tool call is attempted, and gate CI
on structural regressions.

### Added

- **Decision-trace model.** Step hierarchy (`parent_step`) and causality
  (`caused_by_step`), a typed decision record (options, chosen, confidence,
  `decided_by` = agent/user/policy), and a `session_id` correlation key on
  traces. New commands `why <trace> --step N` (walk the causal chain) and
  `decisions <trace>`; `show --tree` renders the step hierarchy; `list --session`
  filters by session. Schema v2 with an automatic v1→v2 migration.
- **Live capture.** A versioned JSONL event protocol and `record` command that
  writes traces incrementally, plus a `TraceRecorder` SDK. `record --format`
  also translates the CLIs' own streams (`codex-exec`, `gemini-stream`). A
  stateless `hook` adapter for the Claude Code / Codex CLI / Gemini CLI hook
  convention (dialect auto-detected), `import` for Claude Code transcripts and
  Codex rollouts, and `watch` to live-tail a running trace. WAL mode + busy
  timeout for concurrent writers and readers; `list` flags abandoned running
  traces.
- **Runtime harness.** `guard check` evaluates a proposed step against policies
  (exit 0 allow/warn, exit 2 deny; `require_review` fails closed without a TTY).
  `hook --enforce` blocks denied tool calls in each harness's dialect and records
  a `guard_check` step. `run -- <command>` wraps an agent process, records it,
  and propagates its exit status. `check --golden` compares runs against a golden
  dataset on a structural field allowlist and exits non-zero on regression.
- **OpenTelemetry ingest.** `otel serve` runs a local OTLP/HTTP receiver
  (`/v1/traces` in JSON and protobuf, `/v1/logs` in JSON, gzip), mapping the
  GenAI semantic conventions onto the trace model with OpenInference and
  OpenLLMetry fallbacks, drift-tolerant attribute aliasing, and Gemini CLI /
  Claude Code log-event enrichment (including tool-decision records).

### Changed

- Default eval models refreshed to the current cheapest tier: Google
  `gemini-2.5-flash-lite`, OpenAI `gpt-5.4-nano` (Anthropic
  `claude-haiku-4-5-20251001` unchanged).

## [0.1.0]

- Initial build: local SQLite trace store; `ingest`, `list`, `show`, `replay`,
  `diff`, `fork`, `eval`, `guard`, `export`, `dashboard`, and `config` commands;
  AI-powered evaluation with bring-your-own-key.
