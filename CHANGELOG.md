# Changelog

All notable changes to `agent-replay` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A broad hardening pass across the whole CLI. Highlights: consistent exit codes
and strict argument parsing for scripting and CI; correctness of the
comparison, evaluation, and golden-regression paths (`diff`, `eval`,
`check --golden`); guardrail enforcement that now fails closed (`hook
--enforce`); more faithful live capture and import (`record`, `run`, `import`,
`fork`); and a more robust, memory-bounded OpenTelemetry receiver. The recorded
trace schema is unchanged.

### Added

- A `stats` command prints a non-interactive summary of the trace store —
  overall counts (traces, steps, evals, active policies), average duration, and
  token/cost totals, plus a per-status and per-agent breakdown (each agent's
  trace count and a failed+timeout tally). It exposes the same aggregates as the
  `dashboard` TUI but works in a plain terminal, a log, or CI, and `--json`
  emits `{ overall, by_status, by_agent }` for piping into `jq` or a gate.
  Previously these numbers were reachable only through the full-screen
  dashboard, which needs an interactive TTY.
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
- Cleared a newly-disclosed high-severity `nanoid` advisory
  (GHSA-28wg-ghj8-5hjv / GHSA-2v37-7h3g-55p8 — a non-secure generator can loop
  indefinitely on a negative or zero size). Bumped the direct dependency to
  `^5.1.16` (the patched 5.x release; `nanoid`'s API is unchanged) and raised the
  `postcss` override to `^8.5.26`, which pulls the patched `nanoid ^3.3.17`
  transitively. `npm audit` is back to 0 vulnerabilities.

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

- `otel serve` log ingest no longer lets a timestamp-less log record steal
  `step_number` 1 and mis-order a session's steps. `timeUnixNano` is optional in
  OTLP, and a record without it flattens to time `0`, which sorted ahead of the
  real, timed events — so a timestamp-less `tool_result`/`tool_decision` jumped
  to the front of the trace. The sort now places an untimed record last (`time ||
  Infinity`), mirroring the start-less span guard already applied to the trace
  path; the trace `started_at` was already derived only from timed records.
- `import --format codex-rollout` no longer drops a reasoning step's text (or an
  assistant message's) when the richer field is an empty array. A Codex/Responses
  API `reasoning` item with no generated summary serializes as `summary: []`
  (present but empty) with the actual text in `content`; the fallback chain used
  `??`, which treats `[]` as present, so it kept the empty summary and imported
  the thought as `{ text: "" }` — silently losing the reasoning. The same defeated
  a `message` whose `content` was `[]` with text in `text`. Both now fall back
  with `||`, treating an empty (`""`) extraction as absent, so the next candidate
  field is used.
- `eval --ai` / `diff --ai` cost estimation no longer under-prices a model that
  merely shares a name prefix with a cheaper entry in the rate table, which could
  let a run slip past `--max-cost`. The family-match borrowed a known rate when
  one model id was a string prefix of another — so `gemini-2.5-flash` (a real,
  pricier model) matched the cheaper `gemini-2.5-flash-lite` and was priced ~4×
  too low. A family match now only borrows a rate across a version/date suffix
  (`-<digits>`, e.g. `claude-haiku-4-5` ↔ `claude-haiku-4-5-20251001`); a
  different variant (`-lite`, `-pro`, …) falls through to the conservative
  max-rate fallback, preserving the "never cheaper than reality" guarantee.
- `config test-ai` now exits non-zero when the connectivity check fails. Like the
  other commands just fixed, its `catch` reported the failure but never set
  `process.exitCode`, so a broken or expired provider key exited `0` — a CI check
  gating on it would read a broken provider as healthy.
- Two more runtime-failure paths now exit non-zero, completing the exit-code
  sweep: an AI preset that throws inside `eval --ai` (a provider/network error —
  previously swallowed by the loop, and since the thrown preset never reached the
  pass/fail tally, a lone failing AI preset could exit `0`), and a `demo` seed
  failure.
- `otel serve` now answers a real `413` for an oversized *uncompressed* request
  body instead of resetting the connection. On exceeding the 32 MB raw-body cap
  it destroyed the socket before the `413` could flush, so the client saw a
  connection reset (`ECONNRESET`). OTLP exporters treat a reset as retryable but
  a `413` as not — so an oversized batch was resent forever, the exact runaway
  the cap exists to stop. The receiver now stops reading, sends the `413` with
  `Connection: close`, and lets the socket close after the response is delivered.
  (The gzip-bomb `413` path already worked; only the raw-body path reset.)
- `guard` now rejects a non-string `step_type` in a policy match pattern, and a
  blocking policy carrying one fails closed. `step_type` was the only match key
  not type-validated, so `guard add --pattern '{"step_type": true}'` stored a
  `deny` whose `step.step_type !== true` is always true — a kill-switch that
  silently never fired. `guard add` now rejects it (like the other keys), and the
  matcher treats an unusable `step_type` on a `deny` / `require_review` policy as
  a match (fail closed), mirroring the `name_regex` handling, so a policy stored
  before this validation still blocks rather than silently passing.
- `hook` now records a genuine 0 ms tool duration instead of leaving it blank. An
  instant or cached tool call that closed in the same millisecond it opened had
  its duration computed as `Math.max(0, …) || undefined`, so the real `0`
  collapsed to `undefined` and the step showed no duration — inconsistent with
  the live recorder, which preserves `0`. It now keeps `0` while still coalescing
  an unparseable timestamp to no-duration.
- `otel serve` no longer loses a whole trace's start time and duration to a
  single span that has an end but no start. Such a span flattens to nanos `0`,
  which sorted to the front of the group, so the trace's `started_at` came out
  `undefined` and `total_duration_ms` `null` even when other spans were fully
  timed (and the start-less span also stole `step_number` 1). The trace start and
  duration are now derived from the earliest *valid* span start, and a start-less
  span sorts last instead of first. (Extends the earlier start-less-span duration
  guard, which prevented the absurd `end - 0` value but discarded good timing.)
- `import` now tallies a tool-result-only record inside a subagent transcript as
  imported, not skipped, matching how the main transcript loop counts the
  identical record. Such a record carries no step of its own (its content is
  attached to the paired tool-call step's output), and tool calls and their
  results normally live in separate records — so the `Records imported` /
  `Records skipped` summary under-counted imported and over-counted skipped for
  any subagent that used tools. The `imported + skipped = records` invariant held
  either way; only the split between the two was wrong.
- `eval` no longer reports a self-contradictory verdict at a threshold boundary.
  `passed` was computed from the raw weighted score while the stored/displayed
  `score` was rounded to three decimals, so a score just under the threshold
  (e.g. a raw `0.6997` against a `0.700` threshold) failed but displayed as
  `score 0.700, threshold 0.700, passed false`. `passed` is now derived from the
  same rounded score that is shown — for the built-in presets, custom rubrics,
  and the AI-powered presets (`ai-quality-review`, `ai-optimization`).
- Several commands now exit non-zero when they fail at runtime, instead of
  printing an error and exiting `0` (which reads as success to a CI script). Each
  wrapped its work in a `try` whose `catch` reported the failure but never set
  `process.exitCode`: `export` (a failed write or serialization — e.g.
  `export --output` to a missing directory — is the standout, since a later
  `&& upload` step would proceed with no file), `fork` (a database write
  failure), `diff --ai` (an AI-analysis failure), and `eval` (a preset that
  throws — including in `--all`, the default all-presets run, and the AI-preset
  loop, where the thrown preset also never reached the pass/fail tally, so even a
  total failure could exit `0`). All now exit `1` on a runtime failure.
- `eval --ai` and the AI evaluators no longer summarize a large trace with the
  agent's decisions dropped. The trace summarizer's "important step" filter (used
  once the token budget is tight, on traces past ~145 steps) keyed off
  `step_type === 'decision'`, but the live recorder attaches decision records to
  steps of any type — so on a large trace the summary silently omitted a
  decision/rationale that `show`, `why`, and `decisions` all display. The filter
  (and the `why` causal-walk fallback, for consistency) now treat any step
  carrying a decision record as a decision point.
- `diff --ai` now shows the AI analyzer the actual differing `input`/`output`
  values instead of `[object Object]`. The diff summary stringified each field
  difference with `String(...)`, but `input`/`output` diffs carry the parsed
  objects — so the most information-rich kind of difference reached the model as
  `LEFT=[object Object] | RIGHT=[object Object]`, giving it no signal. The values
  are now JSON-stringified (a null side, meaning the step is absent on that
  trace, still renders as `(missing)`).
- `ingest` now exits non-zero on a partial validation failure, not only when
  every record is invalid. When some records failed validation but at least one
  passed, it inserted the valid ones and exited `0`, silently dropping the
  invalid records — so a CI gate (including `ingest --dry-run`, the natural
  "validate my file" check) read the data loss as success. Any validation error
  now yields a non-zero exit, matching the all-invalid path and the documented
  exit-code contract; the valid records are still inserted.
- `decisions` no longer omits a decision record attached to a non-`decision`
  step. The live recorder and the SDK's inline `step({ decision })` can attach a
  decision record to a step of any type (unlike the `ingest` validator, which
  requires a `decision`-type step), and the causal walk behind `why` surfaces
  those records regardless of step type — so `decisions` and `why` disagreed on
  the same trace. `decisions` now lists any step that carries a decision record,
  not just `decision`-type steps.
- `otel serve` now answers `400`, not `500`, when an OTLP/JSON body is a valid
  object but a repeated field (`resourceSpans`/`scopeSpans`/`spans`,
  `resourceLogs`/`scopeLogs`/`logRecords`) is the wrong type — e.g.
  `{"resourceLogs":{}}`. The `?? []` iteration guards only null/undefined, so a
  non-array value iterated a non-iterable and threw, surfacing as a `500`. OTLP
  exporters retry `5xx` but not `4xx`, so a permanently-malformed batch would
  have looped forever. The mapping step (pure client-data transform) now answers
  `400` on such input across all four quadrants (traces/logs × JSON/protobuf),
  while database-write errors still surface as `500`.
- The OTLP/protobuf decoder now reads an `int64` attribute value precisely. It
  accumulated the varint with JS `number` arithmetic, so a negative `int_value`
  (encoded as a full 10-byte two's-complement varint) decoded to a huge positive
  magnitude — `-1` surfaced as `~1.84e19` — and a positive value above 2^53 lost
  precision. It now decodes int64 with `BigInt` and two's-complement sign
  handling (matching the fixed64 path). Token counts and other small ints are
  unaffected.
- `check --golden` no longer lets a tool-input (or per-step model) regression
  slip through when the candidate numbers its steps differently from the golden.
  The `step_count`/`step_types`/`step_names` checks compare the two step
  sequences positionally, but `tool_inputs` and `model` matched by absolute
  `step_number`. Since a step number need only be `>= 1` (an OTLP-assembled or
  imported trace may start above 1 or skip values), a candidate with the same
  shape but shifted numbering had its `tool_call` look up an unrelated golden
  step and silently skip the comparison — so a real regression passed the gate
  while the positional checks reported a perfect match. `tool_inputs` and `model`
  now align positionally, consistent with the other structural checks.
- `otel serve` no longer reports an absurd trace duration for a span that has an
  end time but no start time. A span missing `startTimeUnixNano` flattens to
  nanos `0` and sorts first, so the trace-level `total_duration_ms` computed
  `end - 0` — a ~158-year duration paired with an unknown (`null`) start — while
  the parallel step-level duration and start time were both correctly `null`.
  The trace duration now applies the same missing-start guard, staying `null`.
- The `hook` adapter no longer mislabels a Gemini CLI session as `claude-code`.
  Gemini and Claude Code share the `SessionStart`/`SessionEnd` hook event names
  verbatim, but the Gemini detection allowlist omitted them, so a Gemini session
  whose first hook is `SessionStart` created its trace labeled `claude-code` —
  and because every later (correctly-detected) event reuses the running trace,
  the whole session stayed mislabeled. Detection now disambiguates these shared
  events by payload shape (Gemini carries `timestamp` and no `permission_mode`).
  Enforcement was unaffected (it runs only on `BeforeTool`, always detected
  correctly); this was a trace-labeling fix.
- `fork --from-step N` now requires step `N` to actually exist, instead of only
  checking `N` against the highest step number. Step numbers can have gaps (a
  valid ingested or OTLP-assembled trace may be numbered `[1, 3]`), so forking
  such a trace at step `2` passed the bound check but copied only step `1` — and
  because the fork point never existed, `--modify-context` was silently dropped
  even though the summary reported "Modified context: Yes" and the command exited
  `0`. Forking at a non-existent step now fails loudly (exit `1` from the CLI; the
  exported `forkTrace` throws).
- `import` of a Claude transcript now tallies a zero-step record as `skipped`,
  not `imported`, keeping the documented `imported + skipped = records`
  invariant. A follow-up user turn (which has no `user`/`input` step type to
  retain it) and an assistant record whose only text block is empty both yielded
  no step yet were counted as imported, inflating "Records imported" — the same
  classification the codex-rollout importer was already fixed to get right. The
  `contributed` flag is now set only on the paths that actually capture input or
  emit a step.
- `list --agent <name>` (and the same filter in `export`/`check`) now escapes
  `LIKE` metacharacters in the search term, so `_` and `%` match literally
  instead of acting as wildcards. A snake_case name like `travel_bot` otherwise
  also matched `travel-bot` (the `_` matches any character), and a term
  containing `%` matched nearly everything. This mirrors the `--session` fix
  below; the substring (`%term%`) behavior is unchanged for ordinary terms.
- `list --session <id>` now matches the session id as a literal prefix instead
  of a SQL `LIKE` pattern. Session ids routinely contain `_` (e.g. `sess_1`),
  which `LIKE` treats as a single-character wildcard, so `--session sess_1` also
  returned unrelated sessions like `sessX1` (and inflated the paginated total to
  match). The `_` and `%` metacharacters are now escaped with an explicit
  `ESCAPE` clause so only the trailing prefix wildcard applies. (The sibling
  `getTrace` prefix match is unaffected: generated `trc_…` ids carry `_` only at
  a fixed position, so the wildcard was inert there.)
- `eval --max-cost` and `replay --speed` now consume exactly the value they
  validate. Both flags were validated with `Number()` but then re-parsed with
  `parseFloat`, which disagree: an empty `--max-cost ""` validated as `$0` yet
  ran with an *unlimited* budget (`parseFloat("")` → `NaN` → the `Infinity`
  fallback), silently defeating the spend cap the validation exists to enforce;
  and `--speed 0x10` validated as `16` but replayed at speed `0` (instant),
  since `parseFloat` stops at the `x`. Each flag now uses the validated number
  directly, completing the "validate and consume the same value" convention
  already applied to `list --limit`, `otel --port`, and `dashboard --refresh`.
- `eval --rubric` no longer mis-scores a rubric whose `weight` is written as a
  quoted string. YAML authors naturally quote values (`weight: "2"`), which
  arrived as a string and made the score aggregation do `totalWeight += weight`
  as string concatenation (`"0"+"2"+"2"` → `"022"` → `22`), so a fully-passing
  rubric scored ~`0.18` and reported `passed: false` — silently failing a CI
  gate on a correct trace. A numeric weight is now coerced to a real number, and
  a weight that is present but not a non-negative number is rejected as a usage
  error (exit `2`), catching a negative weight that would otherwise push the
  score out of `[0, 1]`. Relatedly, a malformed or unreadable rubric file now
  fails the command (exit `2`) instead of exiting `0`, so a broken gate can no
  longer read as "passed".
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
- `record --format gemini-stream` marks an interrupted run as `timeout`, not
  `completed`. A clean Gemini run always emits a terminal `result` event, so
  reaching EOF without one means the process was killed or crashed — but the
  translator's EOF finalize defaulted to `completed`, pre-closing the trace so
  `record`'s "still-running → timeout" step never ran. The translator now emits
  no `trace_end` when its terminal event never arrived, leaving the trace for
  `record` to time out (or `--leave-open` to keep open), matching the native
  protocol. `codex-exec`, which has no terminal event, still completes on a
  clean EOF.
- `agent-replay run` propagates a signal-killed child as `128 + signal number`
  (e.g. `137` for SIGKILL) instead of flattening every signal death to exit `1`,
  and records which signal killed it (`child killed by signal SIGKILL`). A
  wrapped process that is OOM-killed is now distinguishable from a generic
  failure, both in the exit code scripts see and in the recorded trace error.
- `agent-replay run` now records a `failed` trace when the wrapped child exits
  non-zero after emitting a `trace_end` with no `status` field. The recorder
  defaults a statusless `trace_end` to `completed`, which is indistinguishable
  from the child having explicitly declared success — so the wrapper's
  exit-code finalization (which only ran while the trace was still `running`)
  was skipped, and a failed run was recorded as `completed` with no error. The
  wrapper now tracks whether the child declared an explicit status: if it did
  not, a non-zero exit finalizes the trace as `failed` with the code recorded,
  per the spec. An explicit child status is still honored.
- `record` (the live native protocol) now honors the `parent_step_number` /
  `caused_by_step_number` aliases on `step` and `step_start` events, matching
  batch `ingest`. The recorder forwarded only the `parent_step` / `caused_by_step`
  spelling, so a trace replayed from `show --json` or `export` — which uses the
  persisted column names — lost its step hierarchy and causality when re-recorded
  (the links stored as `null`), breaking the documented "a recorded trace is
  identical to the same run ingested as one batch" invariant for that round-trip.
- `import`'s "records imported / skipped" report now accounts for a
  content-less user/assistant record (it produced no step but was previously
  counted as neither), so the tally the command prints matches the number of
  records in the file.
- `import` of a Codex `rollout-*.jsonl` session no longer counts a dropped
  follow-up user turn as imported. In a multi-turn session, the first user
  message becomes the trace input and agent actions become steps, but a later
  user turn has no home (there is no `user` step type) — yet it was still marked
  "imported", inflating the tally and breaking `imported + skipped = records`.
  Such a message now counts as skipped, matching the Claude-transcript importer.
  (Its text is still not retained as a step — a shared limitation of both
  importers.)
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
