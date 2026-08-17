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
  dashboard, which needs an interactive TTY. `stats --since <window>` (a
  duration like `7d`/`24h` or an ISO date, matching `list --since`) windows
  every count to traces started at or after the cutoff — steps and evals by
  their parent trace's start time, so the view is internally consistent — while
  the active-policy count stays store-wide (current config, not history). A
  malformed `--since` is a usage error (exit `2`); `--json` adds a `since` field.
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

- The OTel *logs* path no longer loses or fabricates data. A flush window
  carrying only model-call events has no steps and no prompt but does have
  token counts, and the whole group was discarded — so a session's token total
  depended on where the exporter happened to cut its batches. Records with no
  `session.id` were all grouped under one placeholder, fusing unrelated
  services in a batch into a single trace (the span path already refuses the
  same fusion). And no log-derived step recorded the event's own time, so every
  step was stamped with the moment the batch arrived — a timeline where
  everything happens at once — while the trace never got an end time, and so
  showed no duration at all.

- `import` no longer fabricates token totals from string counts. A transcript
  whose `usage` carried `"100"` rather than `100` concatenated instead of
  adding — `0 + "100" + 20` becomes `"010020"`, stored as 10,020 tokens instead
  of 120 — and the poisoning was sticky, so every later record concatenated
  too. (The Codex *stream* translator was hardened against exactly this; the
  importers were missed.) A `tool_use` whose `name` is not a string no longer
  aborts the entire import either: one bad block in a 50,000-record transcript
  threw out of the whole run, contradicting the importer's best-effort
  contract. And a file that yields no steps *and* no prompt now reports a
  failed import rather than creating an empty trace and exiting `0`.

- OTel spans in the OpenInference and OpenLLMetry dialects now carry their
  prompt and response content. Only the `gen_ai.*` content attributes were
  read, so a LangChain or LlamaIndex app — the frameworks these conventions
  come from, and the ones the README names — produced traces whose every step
  had an empty input and no output. The spans were classified, timed, and
  token-counted correctly; they simply carried nothing to read, and the raw
  attributes were preserved nowhere either. `input.value`/`output.value`,
  `llm.prompts`/`llm.completions`, `traceloop.entity.input`/`output`,
  `llm.provider`, and `tool.name` are now mapped alongside their GenAI
  equivalents.

- Opening the trace store no longer *lowers* its own lock patience, and no
  longer blames corruption for every failure. `busy_timeout` was set to 3s
  where better-sqlite3 already defaults to 5s — a reduction, written as though
  it were an increase — so a short-lived `hook` process contending with a slow
  `otel serve` merge was aborted earlier than the default would have, and a
  `SQLITE_BUSY` there is swallowed as a warning, i.e. silently lost capture.
  It is now 10s and set *before* the WAL conversion, which itself needs a
  lock. Separately, a store that is merely locked, read-only, or unreadable is
  reported as such: the old message said "may be corrupted" for all of them,
  and the natural response to that is to delete the store.

- `guard add` now warns when a `deny` or `require_review` policy matches on
  `output_contains`. Enforcement evaluates a *proposed* tool call — before it
  runs, so there is no output yet — and every match key must match, so such a
  policy can never block live, however active it looks in `guard list`. It
  remains valid for post-hoc evaluation (`guard test`, recorded steps), which
  is why this warns rather than rejects. Documented in the README as well.

- `guard check` now fails closed when it cannot evaluate policies at all.
  Opening the store and running the policy match were unguarded, so an
  infrastructure error — an unopenable or read-only store, or `SQLITE_BUSY`
  from a concurrent `hook` process — exited `1`. That is not the block signal
  (`2` is), so every harness treated it as a non-blocking error and ran the
  tool: a gate wired in as a blocking pre-exec check quietly stopped denying
  the moment the database was locked. `hook --enforce` already failed closed
  here, as does this command's own `require_review` path without a TTY.

- `eval --ai` no longer reports `ai-root-cause ✔ 100%` for a trace whose every
  tool call failed. The preset decided it was "not applicable" by looking for a
  step of type `error`, but no capture path emits one — `hook`, `record`, and
  both importers record a failed tool call as a `tool_call` step carrying an
  `error` — so it was skipped for every real failure, and a skip stores a score
  of 1.0. The provider was never called for the analysis the preset exists to
  do. The deterministic criteria were corrected the same way; this one was
  missed.

- `eval --ai --max-cost` now exits non-zero when the budget stops the run part
  way through. The remaining evaluators never reach the results list, and the
  pass/fail gate can only reason about the ones that ran, so an unfinished run
  reported green. (The pre-run estimate check already exited non-zero for the
  same reason.) The notice also goes to stderr, so it can no longer corrupt
  `--json` output.

- `--since` now compares instants instead of bytes, across `list`, `stats`,
  `export`, and `check`. `started_at` is a TEXT column and nothing constrains
  the format a producer writes — `ingest`, `record`, and both importers pass a
  timestamp through verbatim — so the byte order was not the time order. A
  timestamp with a UTC offset landed in the wrong window (`14:00+02:00` is
  `12:00Z`, an hour *before* a `13:00Z` cutoff, yet it was the row returned),
  and a space-separated timestamp — SQLite's own `datetime()` form — sorted
  below every `T`-separated one and was excluded from *every* window. A
  `check --since 1d` CI gate therefore skipped traces it should have checked.
  A timestamp that cannot be parsed at all still falls back to the old
  comparison, so nothing that used to be returned disappears.

- `--since` also rejects a date-shaped value that isn't a real date. `2026-99`
  passed the format check and became a bound no timestamp could satisfy, so
  every query reported "No traces found" and exited `0` — indistinguishable
  from an empty store, and a silently empty CI gate.

- An OTel trace assembled from several export batches now numbers its steps by
  start time rather than arrival, so a parent span that flushes late no longer
  produces a *forward* parent reference. Batches arrive in completion order and
  a parent span ends after its children, so the parent was numbered above the
  child it owned — a reference `ingest` rejects (the export → ingest round-trip
  hard-failed for exactly the deep traces cross-batch assembly exists to serve)
  and one that made `why` and `show --tree` render step 1 as "caused by #2".
  The hierarchy is preserved; it now points backward, as everything downstream
  already assumed.

- OTel spans that end before they start (clock skew between hosts, or a
  hand-rolled exporter) no longer persist a negative duration at the step or
  trace level. Those values are exactly what `validateTraceInput` rejects, so
  `otel serve` was writing rows `ingest` refuses — the same round-trip break
  already fixed for span parentage — and the UI printed a negative millisecond
  count. Contradictory timing is now recorded as unknown rather than clamped to
  zero, which would claim the call was instant. A genuine 0 ms span is
  unaffected.

- `check --golden` now refuses a golden file with no entries (exit `2`) instead
  of reporting a vacuous green gate. An empty baseline matches nothing, so every
  candidate fell to the `unmatched` branch — which passes unless `--strict` —
  and the run printed "0 passed, 0 regressed" and exited `0` forever. The usual
  cause is a filter typo: `export --format golden --tag known-good` writes `[]`
  and exits `0` when the tag is actually `known_good`. That export now also
  warns that the baseline it just wrote can never detect a regression.

- `record` now exits `1` when a stream produced input but **every** event was
  rejected, instead of reporting a total capture failure as success. Piping the
  wrong `--format` (or a broken producer) into `record` dropped every line as a
  warning, recorded nothing, and still exited `0` — so `agent | agent-replay
  record && agent-replay check` treated an empty recording as a clean run.
  Per-event leniency is unchanged: a stream where some events survive still
  exits `0`, and an empty stream is still not a failure.

- `why` no longer presents time-travelling causality as fact. `ingest` validates
  that `parent_step` / `caused_by_step` reference an earlier step, but the live
  `record`/SDK path passed producer values straight through — and the causal
  walk's contract depends on that invariant. A forward reference made step 1
  render as "caused by #2", a step that hadn't happened yet. A reference that
  isn't a positive integer strictly earlier than its own step (including a
  self-reference) is now dropped at the write boundary, matching what the
  OpenTelemetry mapper does with an out-of-order parent span.
- An OpenTelemetry root span's own tokens and attributes are no longer dropped.
  The token total summed only the child spans and the root's attributes were
  never carried, so a single-span agent trace reported no tokens, no model, and
  no provider despite the span carrying all three.
- An OpenTelemetry child span that starts *before* its parent no longer produces
  an unusable parent reference. Step numbers follow start-time order while
  parentage resolves by span id, so clock skew or an async wrapper yielded a
  forward reference (and a self-referencing span pointed at itself) — shapes
  `validateTraceInput` rejects, meaning `otel serve` persisted rows that `ingest`
  refuses and an export → ingest round-trip of an OTel trace failed. Only a
  strictly-earlier parent is kept; `otel_parent_span_id` still rides along in
  metadata, so the cross-batch re-link can repair the link later.
- An interrupted `codex exec --json` run is no longer recorded as `completed`.
  The translator never declared that its stream has a terminal event
  (`turn.completed`), so reaching EOF without one still closed the trace cleanly
  — a killed or crashed run looked like a successful one. It now stays `running`
  so `record` finalizes it as `timeout`, matching the native protocol and the
  gemini stream, which already behaved this way.
- Codex token totals are summed numerically. `usage` was only *cast* to numbers,
  so a producer sending `"5"` and `"7"` produced `0 + "5" + "7"` — the string
  `"057"`, stored as 57 tokens instead of 12, silently and with no warning.
- An OpenTelemetry span that captured its own exception is now recorded as a
  failure. Error detection keyed solely on `status.code`, missing the two other
  ways a failure arrives: an `exception` span event — what `recordException`
  writes, and several instrumentations call it *without* also setting the status
  — and an `error.type` attribute, which GenAI semconv sets on a failed
  operation. Such a span was stored as a completed step on a completed trace,
  with the exception text preserved nowhere at all. Span events are also decoded
  on the protobuf transport now (field 11 was skipped entirely, so protobuf
  could not report this class of failure even in principle, while JSON could).
  An explicit `OK` status still wins over both weaker signals.
- Failures captured over the OpenTelemetry **logs** path are no longer invisible.
  That path had no error handling at all: the trace status was hardcoded
  `completed`, no step ever received an `error`, and `.api_error` records matched
  no branch, so they vanished entirely — a batch containing only those produced
  zero traces and still answered `200`. A session whose every tool call failed
  therefore looked like a clean run to `list`, `check --golden`, and `eval`'s
  error criteria alike. A tool record with `success: false` now carries its
  `error` text (falling back to `error_type`, then a generic message), an
  `api_error` record becomes an `llm_call` step with the failure on `error`, and
  the trace status is derived from its steps rather than assumed. A
  `claude_code.tool_result` also keeps its `duration_ms`, which was dropped.
- A single malformed scalar from a producer no longer costs a whole trace, step,
  or finalization during live capture. SQLite refuses to bind an object or array,
  and `record` swallows that error as a per-event warning, so the damage went far
  beyond the offending field:
  - `agent_version`, `session_id`, or `started_at` sent as an object on
    `trace_start` lost the **entire trace** — every later event then failed with
    "trace not found", and the command still exited 0.
  - `total_tokens`, `total_duration_ms`, `total_cost_usd`, or `ended_at` sent as
    an object on `trace_end` lost the **finalization**: a run that reported
    `failed` with an error was persisted as `timeout` with no error, turning a
    crash into an apparent hang.
  - `model`, `tokens_used`, `duration_ms`, or a decision's `rationale` /
    `confidence` sent as an object dropped the **whole step**. On `step_end`,
    where one combined `UPDATE` carries every field, a bad duration silently took
    the step's `output` with it.

  These are now coerced at the bind boundary, like `trigger`, `status`, and
  `tags` already were: a non-scalar becomes null and everything else is kept. A
  numeric string (`"1234"`) is accepted for a numeric column. `ingest` validates
  these fields upstream, so the coercion only ever applies to live-captured data.
- `record --tags` no longer aborts the entire stream when a producer sends a
  non-array `tags`. The merge spread `tags` *outside* the per-event error
  handler, so the spread threw, the process exited 1, and every trace in the
  stream was lost — not just the bad event. A string value would also have
  spread into one tag per character.
- `name_regex` patterns that backtrack catastrophically are now rejected. The
  check only caught a quantifier appearing immediately before a group's closing
  paren, so `(a|aa)+`, `(\s*\w)*`, and `(.*,)*` all passed and then took seconds
  — minutes, for a slightly longer name — to evaluate a ~35-character tool name.
  Because `name_regex` runs on the guardrail path, that isn't merely slow: it
  stalls the check, and a harness that treats a timed-out hook as non-blocking
  turns the stall into a fail-open. The rule is now "an unbounded quantifier
  applied to a group whose body contains a quantifier or an alternation", which
  covers all of those forms. It is deliberately conservative and may reject a
  pattern that would have been safe; bounded quantifiers (`(\d{3}){2}`),
  unambiguous groups (`(abc)+`), and alternations without an unbounded outer
  quantifier (`^(get|list)_x$`) are unaffected.
- A malformed `hook` command line no longer blocks the host agent in capture
  mode. Commander reports every usage error (an unknown flag, a stray argument)
  as exit 2 — but in each supported harness exit 2 *blocks* the pending tool
  call, and the hook configuration is static, so one typo in `settings.json`
  blocked every tool call for the whole session, from a capture-only hook that
  is documented never to affect the host agent. `runHook` guarantees exit 0, but
  commander's error handling runs before the action ever executes. A usage error
  on `hook` without `--enforce` now exits 0. With `--enforce` it still exits 2,
  since blocking is the correct fail-closed answer when the gate can't run.
- `guard remove` no longer deletes a second policy. The lookup was
  `WHERE id = ? OR name = ?` with the same value bound twice, so removing a
  policy by id also removed any policy *named* after that id — and reported
  success. Resolution is now by id first, then by name.
- `fork` now keeps the original trace's `metadata` instead of replacing it. The
  fork provenance (`forked_from`, `forked_at_step`) overwrote the whole object,
  so anything a producer had attached — run/session correlation ids, cost tags,
  harness info — was dropped from every fork, while steps, decisions, snapshots,
  tags, and `session_id` were all copied faithfully. Provenance keys still win on
  a name collision.
- A non-array `tags` value from a producer no longer corrupts reads or breaks
  `fork --tag`. `ingest` validates tags, but the live event protocol doesn't
  type-check them, so `tags: {...}` was stored verbatim in a column every reader
  treats as an array. `fork --tag` then threw on `tags.push` *after* its fork had
  already been committed, reporting "Fork failed" (exit 1) for a fork that
  existed but whose id was never printed — leaving an orphan behind, and another
  one on every retry. Tags are now coerced to an array on write and on read.
- `diff` no longer reports two runs as identical when one of them failed. Steps
  were compared on `step_type`, `name`, `input`, `output`, and `model` only —
  the step's `error` was never compared, and no trace-level field was compared
  at all. So a run that succeeded and a run that failed with a 500 from the same
  tool call produced zero differences: the renderer printed "Traces are
  identical." directly beneath a header showing `COMPLETED` beside `FAILED`, and
  `--json` agreed with `"diffs": []`. That is the flagship "it worked before,
  what changed?" case, and every live capture path records a failed tool as an
  ordinary step with `error` set, so it is the common shape rather than an edge
  case. Steps now also compare `error`, and the trace itself compares `status`,
  `trace_error`, and `trace_output`. A trace-level difference reports its step as
  `trace` (`null` in `--json`) and does not set `divergence_step`, which still
  means "the first step that went different".
- A guardrail policy whose `input_contains` / `output_contains` value holds a
  quote, backslash, newline, or tab now matches. The haystack was the
  JSON-encoded step, where those characters appear escaped (`\"`, `\\`, `\n`,
  `\t`), while the needle is the pattern exactly as written — so a `deny` on
  `rm -rf "/etc"`, or on a Windows path like `C:\Windows\System32`, could never
  match its own step. It failed silently: the policy validated cleanly, `guard
  list` showed it as an active deny, and it never fired. These are precisely the
  shapes a destructive-command policy is written with. Patterns are now matched
  against the raw text as well as the JSON form, so patterns aimed at the JSON
  itself (a key name like `"cmd"`) keep working.
- Two further guardrail fail-opens now fail closed, matching what `step_type`
  and `name_regex` already did. An `input_contains` / `output_contains` value
  that is an object or array stringifies to `"[object Object]"`, which can never
  occur in the haystack; and a pattern whose only keys are unrecognized (a typo
  like `nmae_contains`) can never match anything. Both stored a `deny` that
  silently never fired. `guard add` rejects them, but the service API used by
  seed data and any non-CLI caller, and direct inserts, bypass that validation.
  A scalar value still coerces, so `input_contains: 123` matches the text "123".
  A genuinely empty pattern is deliberately left inert, as before.
- `export --status <typo>` now exits 2 (a usage error) instead of 1. The bad
  value reached `listTraces` inside the export block, whose blanket catch
  reports every failure as a runtime error — so a CI script branching on the
  exit code read a typo as a genuine failure, while `list` returned 2 for the
  identical error. `--status` is now validated up front, like the `--since` and
  `--format` checks beside it.
- A tool failure reported as a structured error (`{message, code, stderr}`)
  rather than a string is no longer discarded by `hook`. The whole object
  collapsed to the generic "tool failed", and irrecoverably, since a post-tool
  payload isn't retained anywhere else. It is now flattened to JSON text, the
  same coercion applied elsewhere when binding a structured error. A failure
  with no detail still falls back to "tool failed".
- A hook payload whose event name collides with an `Object.prototype` member
  (`constructor`, `toString`, `hasOwnProperty`, `__proto__`) is now ignored
  instead of creating an unfinalizable trace. The event-name lookup table is an
  object literal, so those names resolved to an inherited function — truthy,
  which skipped the "unknown event" early return, made the reported action a
  function rather than a hook action, and left behind a `running` trace with no
  steps that nothing ever closes and that pollutes `list` and `stats`. Lookups
  are now by own key only.
- `hook --enforce` now fails closed when stdin carries no payload. An empty or
  unreadable stdin (a harness crash, a broken pipe) returned exit 0 before any
  of the fail-closed logic and without ever consulting `--enforce`, so the
  pending tool call was allowed on a gate that exists to stop it. Having seen no
  payload is the same position as a throw before the verdict, which already
  fails closed; a gating (`pre_tool`) route now emits the dialect's block, and
  everything else still allows. The documented allow on a *malformed* payload is
  unchanged — there the harness did send something, and that allow is a
  deliberate choice.
- A plain-string `input` or `output` is no longer silently discarded. Nothing
  requires a producer to send an object — `validateTraceInput` accepts
  `input: "summarize the doc"` and the live event protocol never type-checks
  these fields — but the encode helper wrote any string into the JSON column
  unquoted. Parsing it back then failed, so the user's prompt and the agent's
  answer read as `{}` and `null` from every consumer (`show`, `diff`, `export`,
  `replay`), with exit 0 and no warning. The damage carried into the regression
  gate too: every affected trace hashed to the same empty input, collapsing
  unrelated cases into one golden bucket and comparing `{}` against `{}`, so a
  real tool-input regression passed green. A string is now passed through only
  when it already is valid JSON (the case that passthrough exists for) and
  otherwise encoded. Affects `ingest`, `record`, and `hook` alike. The plain-TEXT
  `error` column is unchanged — it is read back raw, so a string error is still
  stored as-is.
- `stats` and the `dashboard` now report an average duration for traces that
  carry only timestamps. The aggregate averaged `total_duration_ms` alone, while
  `list` and `show` render duration via `effectiveDurationMs`, which falls back
  to `ended_at - started_at`. The hook finalizer records only `ended_at`, so on a
  store captured the normal way (`hook` or `record`) every trace showed a
  duration in `list` while `stats` reported `Avg duration: -`; on a mixed store
  the average covered only the subset with an explicit total. The aggregate now
  applies the same fallback in SQL. A trace with no usable duration (still
  running, or no `ended_at`) is still excluded rather than counted as zero.
- `hook --enforce` now closes the `tool_call` step of a denied call, so a
  concurrent call's result can't be recorded against it. A denied call never
  runs, so no `PostToolUse` ever arrived to close its step — and left open it was
  the newest unclosed step for that tool name, which is exactly what the
  post-tool handler looks for. The next `PostToolUse` for that name, belonging to
  a different call allowed in the same parallel batch, therefore closed the
  *blocked* step: the audit trail showed the blocked command completing
  successfully with another call's output, while the call that really ran stayed
  open forever. The denied step is now closed on the verdict with the blocking
  policy recorded in its `error`. A `require_review` step is deliberately left
  open, since it maps to `ask` and an approved call still runs and closes
  normally.
- `eval`'s deterministic error criteria now detect the failures that live
  capture actually records, so `eval` works as a CI gate on the runs it exists
  for. `hallucination-check`'s `no_error_steps` and `completeness-check`'s
  `no_unresolved_errors` keyed only on a step whose `step_type` is `error` — but
  every live capture path (`hook`, `record`, and the transcript importers)
  records a failed tool as a `tool_call` step with the `error` field set, and
  never emits a dedicated `error` step. Both criteria therefore scored a perfect
  1.0 for every live-captured failure: a trace that `list` displays as
  `✘ FAILED`, with a trace-level error and a tool call that returned 503, passed
  all three presets and `eval --all` exited `0`. A step now counts as failed if
  its `step_type` is `error` **or** it carries an `error` value, and
  `no_unresolved_errors` additionally fails on a trace-level `error` — the
  clearest "this run ended unresolved" signal there is, and the only marker left
  by a run that died before emitting a final step. The change can only turn a
  false pass into a failure; no passing trace starts failing.
- Importing a Claude Code transcript now preserves a failed tool call. A
  `tool_result` block flagged `is_error` (a `Bash` that exits non-zero, a `Read`
  on a missing file — very common) had its flag dropped: the imported step was a
  plain `tool_call` with a null error, indistinguishable from success, so an
  error-aware consumer (`eval`'s error checks, `check --golden`, the timeline)
  read a failed run as passing. The failure text now lands on the step's `error`
  field (with a generic "tool failed" when the result carried no content),
  matching how the live hook-capture path records a failed tool call. Both the
  main transcript and subagent import paths are fixed. The result text still
  appears in the step output as before.
- `check --golden` (the bulk CI-gate path, run without `--trace`) now scans
  *every* candidate trace instead of only the newest 10,000. It passed
  `listTraces` a hard `limit: 10000`, so on a store with more than 10,000 traces
  every candidate older than the newest 10,000 was never fetched, never diffed
  against a golden baseline, and never appeared in the report — a real
  regression living in an older trace produced zero failures and a green exit,
  silently defeating the gate. It now passes an unbounded limit (`-1`), the same
  fix already applied to `export`, so the "exits non-zero on any regression"
  contract holds regardless of store size.
- Cross-batch OpenTelemetry trace assembly no longer loses a step's parent when
  the parent span flushes in a later export batch than its child. A span is
  exported when it ends, and a parent span ends *after* the children it owns, so
  a deep child whose parent span crosses a `BatchSpanProcessor` flush boundary
  arrives in an earlier batch than that parent. The child was stored with no
  `parent_step_number` and never repaired — the merge only re-linked a *new* step
  onto an already-present parent (the parent-first ordering), not an existing
  orphan onto a parent that arrived later. Such a trace rendered flat under
  `show --tree` and broke its `why` causal chain. The merge now also re-links
  backward: once a batch supplies a previously-missing parent span, every orphan
  that referenced it by OTel span id is reconnected.
- `watch` no longer drops the final step(s) of a trace that completes. Each poll
  read the new steps and then, separately, the trace status; a producer (a
  different process) could commit a trailing step and flip the status to a
  terminal value in the gap between those two reads, so the completion tick
  stopped the tail without ever printing that step — the live view disagreed with
  what `show` displayed. The tail now drains once more when it detects
  completion, before announcing the final status.
- `run` now records a wrapped child's trace even when the child generates its own
  `trace_id`. The wrapper owns the trace and is supposed to stamp its own id onto
  every child event, but the code only did so when the id was missing — a case
  the event validator already rejects — so the stamp never happened. A compliant
  child (including one built on the `TraceRecorder` SDK, which generates its own
  id unless it threads `AGENT_REPLAY_TRACE_ID`) therefore had every step and its
  `trace_end` dropped as "trace not found," leaving an empty trace stuck
  `running`. The wrapper now re-stamps its id unconditionally, and only treats a
  child's terminal status as declared once it has actually persisted (so a
  finalization that failed to apply can't suppress the exit-code fallback).
- `fork` no longer reports "Modified input/context: Yes" for a payload that was
  not actually applied. A literal `null` passed to `--modify-input`/
  `--modify-context` parses to a value the fork service treats as a no-op (it
  keeps the original), but the summary keyed off the presence of the raw option
  string, so it falsely claimed the modification landed. The summary now mirrors
  the service's own guards and reports the modification only when it was applied.
- Live `record`/SDK capture no longer drops a step or loses a trace's
  finalization when a producer supplies a structured `error` object. The event
  protocol types `error` as a string, but a harness just as naturally emits
  `{ message, code, … }`, and — unlike the adjacent `output` — it was bound to
  SQLite raw, so the object threw ("can only bind numbers, strings, …") and the
  recorder swallowed it as a per-event warning: the step (with its decision and
  snapshot) vanished, or a `trace_end` error dropped the whole finalization and
  left the trace stuck `running` (finalized as `timeout` at EOF). The `error`
  column is now coerced like `output` (a plain string is kept as-is, an object is
  JSON-stringified), matching the hook adapter's existing error guard.
- `guard add` now rejects a match pattern whose `step_type` is not one of the
  real step types, and a policy stored with such a value fails closed at match
  time. `step_type` is a closed enum, so a typo like `"toolcall"` (for
  `"tool_call"`) can never match any step — previously it was saved as an enabled
  `deny` that silently never fired, a kill-switch the user believed was
  protecting them. This mirrors the existing rejection of keyless patterns and
  non-string `step_type`; a blocking policy with an unusable `step_type` now
  blocks rather than being skipped.
- Live `record` capture no longer loses an entire trace (or its finalization)
  when a producer uses a `trigger` or terminal `status` outside agent-replay's
  vocabulary. Both are free strings in the event protocol, but the database
  constrains them to fixed enums. A `trace_start` with an unknown `trigger` (say
  `"scheduled"`) threw a CHECK-constraint error that the recorder swallowed as a
  warning — the trace was never created, and every later event then failed with
  "trace not found," so the whole run vanished. Likewise an unknown or empty
  `trace_end` `status` (say `"success"`) dropped the finalization, discarding the
  output/token/cost totals and leaving the trace stuck `running` (finalized as
  `timeout` at EOF). Both are now coerced to a valid enum at the service boundary
  — an unknown trigger to `manual`, an unknown status to `completed` — mirroring
  the existing `decided_by` coercion. The `ingest` path still rejects these as a
  usage error, so the coercion only ever applies to live-captured data.
- OTLP-ingested **steps** with no output messages now persist `output: null`
  instead of a spurious empty `{}`. `messageContent` never returns null (it just
  omits the `messages` key), so a message-less step span — the common case for
  tool and thought spans — stored `{}`, which reads as truthy downstream (a
  summary prints "OUTPUT: {}", golden export stores `{}` instead of null). The
  trace root already guarded this; the step mapper now applies the same guard.
  Input still keeps `{}` as its empty value, exactly like the root.
- `show --tree` now renders the `⟵ caused by #N` annotations for a flat causal
  trace — one whose steps record causality via `caused_by_step` without any
  parent nesting (a normal shape, e.g. a decision followed by the steps it
  caused). The tree renderer decided whether to run based only on
  `parent_step_number`, so such a trace fell back to the plain timeline and
  showed no causal links at all, silently defeating the whole point of `--tree`.
  It now also runs when any step has a `caused_by` link.
- `ingest` auto-detection no longer trusts a `.jsonl`/`.ndjson` extension over the
  file's actual content. `export --format json` (the default) into a
  `.jsonl`-named file writes a JSON array, and the detector used to short-circuit
  on the extension, line-split the array, and fail with a misleading "Invalid JSON
  on line 1" even though the JSON was valid. Detection now probes content: a file
  whose entire contents parse as one JSON value is `json`, and only genuine
  line-delimited data (whole-file parse fails) is `jsonl` — completing the
  earlier fix that stopped a pretty-printed object being misread as JSONL. An
  explicit `--format` still overrides detection.
- `eval` no longer displays a score that contradicts its own pass/fail verdict.
  A stored score is rounded to three decimals and `passed` compares that value
  to the threshold, but every human-readable percentage rounded it to a whole
  number — so a `0.695` score (which fails a `0.70` threshold) rendered "70%"
  next to a `FAIL` badge. Scores now render losslessly (a three-decimal score is
  exactly a one-decimal percent), so `0.695` reads "69.5%" and a whole-percent
  score like `0.70` still reads "70%". `--json` output and exit codes were
  already correct; this fixes only the terminal display (`eval` spinners, the
  eval table's score badge, and the AI root-cause confidence line).
- `getTrace` (the prefix resolver behind `show`/`diff`/`replay`/`fork`/`eval`/
  `guard`/`watch`) now escapes LIKE metacharacters in a partial trace id. Trace
  ids are `trc_` + `nanoid(12)` over an alphabet that includes `_`, so a copied
  partial such as `trc_ab_c` treated `_` as a wildcard and could resolve to an
  unrelated trace (and a literal `%` matched every row). The lookup now declares
  `ESCAPE '\'` and escapes `\ % _`, mirroring the `agent_name`/`session_id`
  branches in `listTraces`.
- `guard add` now rejects a `--pattern` with no recognized match key
  (`name_contains`, `input_contains`, `output_contains`, `step_type`,
  `name_regex`). A typo'd key such as `{"tool_name":"delete"}` (the real key is
  `name_contains`) previously passed validation, was saved as an enabled `deny`
  policy, and then matched nothing at evaluation time — a kill-switch that never
  fires. This is the same silent-fail-open class the pattern validator already
  guards against for an unusable `name_regex`/`step_type`.
- `why --step` is now parsed with `Number()` instead of `parseInt`, matching
  `show`/`replay`/`fork`. `--step 1e2` read as `1` and explained the causal chain
  for the wrong step with a success exit; `--step 2.9`/`2abc` slipped through as
  `2`. `1e2` now correctly means `100` and a non-integer is a usage error
  (exit `2`).
- `fork --from-step` is now parsed with `Number()` instead of `parseInt`,
  matching `show`/`replay`'s `--from-step`/`--to-step` and `list --limit`.
  `--from-step 1e2` read as `1` (parseInt stops at `e`) and `2.9`/`3abc` slipped
  through as `2`/`3`, so a fork silently started from the wrong step (and its
  `--modify-context`/`--modify-input` landed on the wrong point) with a success
  exit. A non-integer is now a usage error (exit `2`).
- `safeRegex` (which backs guard `name_regex` matching) no longer rejects a safe
  pattern with a *bounded* outer quantifier such as `(\d{3}){2}` ("exactly six
  digits as two groups"). Its ReDoS guard flagged any quantified group followed
  by any quantifier, but catastrophic backtracking requires the *outer*
  quantifier to be unbounded (`+`, `*`, `{n,}`); a bounded `{n}`/`{n,m}` caps the
  work. The guard now keys off the outer quantifier, so `guard add
  --pattern '{"name_regex":"(\\d{3}){2}"}'` is accepted while the genuinely
  dangerous `(a+)+`, `(a{1,3})+`, and `(a+){2,}` stay rejected.
- OTel-ingested traces whose root span carries no output messages now record
  `output: null` instead of an empty `{}`. `messageContent` always returns an
  object (it just omits the `messages` key when absent), so the intended
  `?? null` fallback was dead and a spurious empty output persisted — which
  reads as truthy downstream (a trace summary printed `OUTPUT: {}`, and a golden
  export stored `{}` rather than null). The input side is unaffected (`{}` is its
  correct empty value).
- `show`/`replay` now validate `--from-step`/`--to-step` with `Number()` instead
  of `parseInt`, matching `list --limit` and `config set`. `--to-step 1e2` read
  as `1` (parseInt stops at `e`), silently capping the window at step 1 instead
  of 100, and `--from-step 2.9`/`3abc` slipped through as `2`/`3`. A non-integer
  is now a usage error (exit `2`), and `1e2` correctly means `100`.
- `list` no longer prints `NaNd ago` for a trace whose `started_at` is an
  unparseable/empty string. The table's local `formatRelative` helper missed the
  `isNaN` guard its two siblings (`formatRelativeTime`/`formatTimestamp`) already
  have; it now renders `-`, like them.
- `config set ai.max_tokens` now echoes the normalized value it stored, not the
  raw input — `config set ai.max_tokens 1e3` confirms `= 1000` (what `config
  get`/`list` will show), not the misleading `= 1e3`.
- `hook --enforce` now fails **closed** when it cannot reach a verdict. The
  audit-write path already failed closed, but a failure *before* the verdict —
  opening the trace, appending the `tool_call` step, or loading policies (e.g. a
  transient `SQLITE_BUSY` on a shared machine) — threw out of `applyHookPayload`,
  and the command's catch logged it and exited `0` (allow). So an infrastructure
  hiccup could let a tool call that a `deny` policy would have blocked run
  through — a safety fail-open contradicting the enforcement contract. A
  `pre_tool` event that can't be evaluated now emits the dialect's block
  (deny/exit 2) with a clear reason; capture-only events (and capture mode
  without `--enforce`) still never block the host.
- The `ai-root-cause` eval preset now derives `passed` from the rounded score
  that is stored and displayed, not the raw confidence. Its three sibling AI
  presets (`ai-quality-review`, `ai-optimization`, `ai-security-audit`) were
  already fixed this way; `ai-root-cause` still compared the raw value, so a
  confidence that rounds up across the 0.5 threshold (e.g. `0.4996` → shown as
  `50%`) reported `passed: false` while the panel read `Confidence 50%` — the
  same score-vs-verdict contradiction the sibling fix closed.
- AI eval / diff against OpenAI now sends `max_completion_tokens` instead of the
  legacy `max_tokens`. The default OpenAI model is a GPT-5-family model
  (`gpt-5.4-nano`), and OpenAI's chat/completions endpoint rejects `max_tokens`
  for GPT-5 / o-series models with a 400 — so every `--provider openai` eval on
  the default model failed the request outright (and the 400 was then reported
  as a generic "Server error"). `max_completion_tokens` is the current field and
  is also accepted by GPT-4o-and-later, so it works for any model the adapter
  targets. Anthropic (`max_tokens`) and Google (`maxOutputTokens`) were correct.
- Live capture (`record`/`run`) now validates the `chosen` field of a `step`
  event's inline decision, instead of losing the whole step to a silent DB
  error. `appendStep` binds `decision.chosen` straight into SQL; an inline
  decision with no `chosen` bound `undefined`, which better-sqlite3 rejects,
  rolling back the step-and-snapshot transaction — a data loss swallowed as a
  generic per-event warning. The event protocol now skips such an event with a
  clear "inline decision requires chosen" warning, matching how a top-level
  `decision` event is already validated (and closing an asymmetry where an
  empty-string `chosen` was accepted inline but rejected top-level).
- The AI diff analysis (`diff --ai`) no longer mislabels a null-valued field as
  a missing step. The diff summary rendered any `null` diff value as `(missing)`,
  but `diffTraces` emits ordinary field diffs (`output`, `model`) whose value is
  legitimately `null` on a step that exists on both traces — so a paired step
  whose left output was recorded but right output was `null` told the model
  "step N is absent on the right," the opposite of the truth. `(missing)` now
  renders only for the `missing_left`/`missing_right` diff types that actually
  mean an absent step; a null field value renders as `null`.
- `export` no longer silently caps at 10,000 traces. Despite a comment claiming
  it "removed the limit," the code passed a fixed `limit: 10000` to `listTraces`,
  which applies it as a SQL `LIMIT` — so exporting a store with more than 10,000
  matching traces dropped the overflow with no warning, corrupting any
  golden/JSONL dataset built from it. It now passes an unbounded limit (SQLite
  treats a negative `LIMIT` as no limit), so every matching trace is exported.
- `otel serve` log ingest now preserves a genuine `0 ms` tool-call duration from
  a Gemini CLI `tool_call` log event instead of dropping it to no-duration. The
  helper coalesced with `|| null`, so a real `0` (an instant or cached tool)
  collapsed to `null` and the step showed no duration — the same class as the
  earlier `hook` 0 ms fix, in the OTLP path. A `0` is now kept; only an absent or
  non-numeric value becomes `null`.
- `eval --rubric` now coerces and validates the rubric's `threshold` like it
  already does `weight`. A YAML author naturally quotes it (`threshold: "0.8"`),
  which arrived as a string and flowed into `score >= threshold`; a numeric
  string happened to coerce, but a non-numeric one (`"abc"`) made every
  comparison `score >= NaN` → always false, failing an otherwise-passing trace
  and reporting a correct trace as a CI regression (the same class the `weight`
  fix closed). A present `threshold` that isn't a number in `[0, 1]` is now a
  usage error (exit `2`), and a numeric string is coerced.
- `guard check` no longer crashes with a raw `TypeError` when the step piped to
  stdin is valid JSON but not an object (`null`, an array, or a bare value).
  `null` in particular reached a property access (`null.step_type`) and threw a
  stack trace; it now reports a clean "expected a single step object" error and
  exits `1`, like the other malformed-input paths.
- `ingest` reports the true file line number when a JSONL line is malformed.
  The line number was computed after blank and `//`-comment lines were filtered
  out, so a broken line preceded by any of them was named as an earlier line
  (e.g. a syntax error on file line 5 reported as `line 2`), sending you to the
  wrong place in the file. Exit code and tallies were already correct; only the
  diagnostic was off.
- `guard check` / `hook --enforce` now attribute a block to a deterministic
  policy when several equal-priority policies match the same step. The verdict
  keeps the first most-restrictive match, but enabled policies were loaded
  ordered only by `priority DESC` with no tiebreaker, so among equal-priority,
  equally-restrictive matches (e.g. two `deny` policies) the cited policy name
  and reason — shown to the user and recorded on the `guard_check` step — varied
  with SQLite's incidental row order. The block itself was always correct; only
  the attribution was unstable. Enabled policies now break ties by `name`
  (unique), matching the ordering `guard list` already uses.
- `list` (and every paginated trace query) now orders tied sort keys
  deterministically. The `ORDER BY` had no unique tiebreaker, so rows sharing
  the sort value — a common case, since batch-ingested or demo traces routinely
  share a millisecond `started_at`, and running traces all have `NULL`
  tokens/duration/cost — came back in an unspecified order. Across `--limit`
  / `--offset` pages (especially with a live recorder writing concurrently) a
  tied row could repeat on one page and be skipped on the next. A stable
  `id` tiebreaker is now appended, making the order a total order.
- `watch` no longer silently drops a step that is written after a
  higher-numbered one. The live tail cursored on the highest `step_number` seen,
  but step numbers are producer-supplied and need not be written in increasing
  order (only unique per trace), so a step whose number was lower than one
  already printed — but written later — fell outside the `> cursor` window and
  never appeared. The tail now tracks the set of printed step numbers, so a
  late, lower-numbered step is surfaced on the next poll.
- `watch --interval` now rejects a malformed value (non-numeric, zero, or
  negative) with a usage error (exit `2`) instead of silently falling back to
  the 500 ms default, matching the `dashboard --refresh` convention. A typo like
  `--interval 5OO` no longer looks like it took effect.
- `guard add` and `eval --rubric` no longer reject a safe regular expression
  that ends in an optional group, e.g. `read(_\w+)?`. The ReDoS guard in
  `safeRegex` flagged a trailing `?` on a quantified group as a nested
  quantifier, but `?` bounds the group to 0–1 repetitions and cannot backtrack
  catastrophically. The false rejection blocked legitimate kill-switch policies
  from being stored, and, in an eval rubric, scored a criterion with such a
  pattern as a failed "invalid regex" (its weight still counting), silently
  depressing the trace's score. The guard now treats only an unbounded outer
  quantifier (`+`, `*`, `{…}`) as dangerous; genuine nested quantifiers
  (`(a+)+`, `(a*)*`, `(a+){2,}`) are still rejected.
- `eval` with the `ai-security-audit` preset now derives its pass/fail verdict
  from the risk score against the preset threshold, like every other AI preset,
  instead of the model's self-reported `safe` boolean. The two can disagree — a
  well-formed response of `risk_level: "critical", safe: true`, or a clean one
  whose `safe` arrived as the string `"true"` — and because the verdict came
  straight from `safe`, the CI gate could pass a critical-risk trace or fail a
  clean one, and the stored record contradicted itself (`score 0.0, passed
  true`). The verdict is now `score >= 0.8`; the `safe` flag is retained in the
  eval details for reporting.
- `ingest` now reports a non-string `status` or `trigger` as a clean, named
  validation error instead of letting it reach the database. The trace
  validator required `typeof === 'string'` before checking the enum, so a
  non-string value (`status: 42`, `trigger: true`) passed validation and then
  failed at insert with a cryptic SQLite `CHECK` or bind error — or, for
  `--dry-run`, was reported valid. It is now rejected up front like `step_type`
  already was.
- The v1→v2 schema migration is now idempotent and safe under concurrent
  upgrades. `runMigrations` read the schema version *outside* any transaction,
  so two processes opening a still-v1 database at once (the app spawns
  short-lived `hook` processes freely) could both attempt the v2 `ALTER TABLE
  ADD COLUMN` — and the loser crashed with `duplicate column name` (not
  `SQLITE_BUSY`, so the busy timeout didn't help), surfacing as a stack trace,
  or, under `hook`'s catch-all, a silently dropped step. The version is now
  re-read inside a `BEGIN IMMEDIATE` transaction so a process that loses the
  race sees v2 and skips, and each `ADD COLUMN` is guarded by a column-existence
  check as a backstop. Only the one-time upgrade window was affected.
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
