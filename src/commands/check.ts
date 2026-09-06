import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { ensureDatabase } from '../db/index.js';
import { getTrace, listTraces } from '../services/trace-service.js';
import { checkGolden, KNOWN_FIELDS } from '../services/check-service.js';
import type { GoldenEntry } from '../services/export-service.js';
import type { TraceWithDetails } from '../models/types.js';
import { heading, safeText } from '../ui/theme.js';
import { parseSinceToIso } from '../utils/time.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse } from '../utils/refuse.js';
import { escapeForMessage, truncate } from '../utils/json.js';

export interface CheckOptions {
  golden?: string;
  trace?: string;
  agent?: string;
  agentExact?: string;
  since?: string;
  fields?: string;
  strict?: boolean;
  /** Accept a run with no candidate traces (a quiet window) instead of failing. */
  allowEmpty?: boolean;
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay check --golden <file>` — CI regression check comparing traces
 * against a golden dataset on a structural field allowlist. Exits non-zero when
 * any matched trace regresses.
 */
export function runCheck(opts: CheckOptions = {}): void {
  // Every refusal below has to answer in the shape the caller asked for. `check
  // --json | jq -r .ok` is the documented CI form, and printing only a red line
  // on stderr turned a "the gate could not run" case into a jq parse error —
  // breaking the --json contract instead of reporting the verdict.
  // The SAME helper the other --json commands use, so the refusal shape is one
  // shape. This kept its own copy and emitted a singular `hint` STRING where
  // every sibling emits a `hints` ARRAY — so `check --json | jq -r '.hints[]'`,
  // the CI pipeline this command exists for, silently yielded nothing on the
  // refusal path. A second copy of a contract is how the contract splits.
  const refuse = makeRefuse(opts.json);
  const fail = (code: number, message: string, hint?: string): void => {
    refuse(code, message, hint ? [hint] : []);
  };

  if (!opts.golden) {
    fail(2, '--golden <file> is required.');
    return;
  }

  // `--agent` is a SUBSTRING match, which is right for browsing and wrong for a
  // gate: `--agent assistant` selects `travel-assistant` and `research-assistant`
  // too, and under --strict those unrelated candidates make the run red. So a
  // gate can name one agent exactly instead. Both at once is a usage error
  // rather than a silent precedence rule.
  if (opts.agent && opts.agentExact) {
    fail(2, '--agent and --agent-exact are mutually exclusive.', 'Use --agent for a substring match, --agent-exact to name one agent.');
    return;
  }

  // An EMPTY value is a usage error, not "no filter". `--agent-exact "$AGENT"`
  // with an unset shell variable would otherwise silently widen a gate from one
  // agent to every agent and report green — the same silent scope-widening this
  // command already refuses for an empty `--fields` list, and for the same
  // reason: a narrowing flag that quietly stops narrowing hides the mistake.
  for (const [flag, value] of [['--agent', opts.agent], ['--agent-exact', opts.agentExact]] as const) {
    if (value != null && value.trim() === '') {
      fail(2, `${flag} was given an empty value.`, 'Pass an agent name, or omit the flag to check every agent.');
      return;
    }
  }
  // `--since` narrows the same way and was left out of the loop above, so
  // `check --since "$WINDOW"` with the variable unset gated over the whole
  // store instead of the window — green for the same reason.
  if (opts.since != null && opts.since.trim() === '') {
    fail(2, '--since was given an empty value.', 'Pass a window, or omit the flag to check every trace.');
    return;
  }

  // Validate --fields BEFORE reading the baseline or touching the store. It was
  // checked inside checkGolden, after every candidate had been fetched, so a
  // plain typo was reported as whatever the data layer complained about first
  // ("No traces matched...", exit 2 — never naming the bad field) or as exit 1
  // from a store-open failure. `watch` already validates --interval before
  // resolving a trace; usage errors belong before the work — including before
  // the baseline-shape refusals below, so a typo'd field name is still the
  // answer when the golden file is ALSO unusable.
  const fields = opts.fields != null
    ? opts.fields.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  // A list that names nothing silently reverted to the DEFAULT field set, so a
  // script meaning to narrow the comparison got the full one instead — the same
  // hole `diff --fields` had.
  if (fields != null && fields.length === 0) {
    fail(2, `--fields listed no field names: ${JSON.stringify(opts.fields)}`, `Known fields: ${KNOWN_FIELDS.join(', ')}`);
    return;
  }
  const unknownFields = (fields ?? []).filter((f) => !(KNOWN_FIELDS as readonly string[]).includes(f));
  if (unknownFields.length > 0) {
    fail(
      2,
      `Unknown --fields value(s): ${unknownFields.join(', ')}.`,
      `Known fields: ${KNOWN_FIELDS.join(', ')}`,
    );
    return;
  }

  let golden: GoldenEntry[];
  try {
    const parsed = JSON.parse(readFileSync(resolve(opts.golden), 'utf-8'));
    golden = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    fail(2, `Failed to read golden file: ${errorMessage(err)}`);
    return;
  }

  // A baseline with no entries cannot gate anything: every candidate falls to
  // the `unmatched` branch, which passes unless --strict, so the run reports
  // "0 passed, 0 regressed" in green and exits 0 — forever. `export --format
  // golden` writes `[]` happily when its filter matches nothing (a mistyped
  // --tag is enough), so this is a mistake a user can make silently and never
  // hear about again. Refuse it, like an unreadable file.
  // `export --format json` and `export --format golden` differ by one flag and
  // produce files that look alike, so feeding the wrong one is an easy mistake.
  // Without this the run died inside the comparison on `steps_summary.length`
  // with a bare "Cannot read properties of undefined", naming neither the file
  // nor the problem — and one bad entry in a hand-edited baseline aborted the
  // whole check rather than being reported.
  const bad = golden.findIndex((g) => !g || !Array.isArray((g as GoldenEntry).steps_summary));
  if (bad !== -1) {
    fail(
      2,
      `Not a golden dataset: ${opts.golden} (entry ${bad + 1} has no steps_summary).`,
      'Golden files come from "agent-replay export --format golden"; "--format json" exports full traces, which this gate cannot compare.',
    );
    return;
  }
  // The ELEMENTS too, not just the array. The guard above checks the shape one
  // level down, so a hand-edited or merged baseline holding a null or a bare
  // string in `steps_summary` still reached the comparison and died there on
  // `.step_type` — reporting "Cannot read properties of null", which names
  // neither the file nor the entry. That is the same diagnostic failure this
  // guard exists to prevent, one level deeper.
  const badStep = golden.findIndex((g) =>
    (g as GoldenEntry).steps_summary.some((st) => !st || typeof st !== 'object'),
  );
  if (badStep !== -1) {
    fail(
      2,
      `Not a golden dataset: ${opts.golden} (entry ${badStep + 1} has a steps_summary entry that is not an object).`,
      'Golden files come from "agent-replay export --format golden"; a hand-edited or merged baseline can lose an entry this way.',
    );
    return;
  }

  // `status` is the field that catches "this run now fails", and the comparison
  // reads it from `metadata.status` — skipping the check entirely when it is
  // absent. So a baseline whose `metadata` block was pruned (the block a human
  // is most likely to trim when hand-editing or merging a baseline for review)
  // silently turned that comparison OFF and reported a green pass on a run that
  // had started failing. `export --format golden` writes `status` into every
  // entry's metadata without exception, so a missing one means the file is
  // damaged, not old — refuse it like any other unusable baseline rather than
  // degrading to a check that compares less than the caller asked for.
  const noStatus = golden.findIndex((g) => {
    const meta = (g as GoldenEntry).metadata;
    return !meta || typeof meta !== 'object' || Array.isArray(meta) || typeof (meta as { status?: unknown }).status !== 'string';
  });
  if (noStatus !== -1) {
    fail(
      2,
      `Not a golden dataset: ${opts.golden} (entry ${noStatus + 1} has no metadata.status).`,
      'Every entry from "agent-replay export --format golden" carries metadata.status; without it the status comparison silently passes. Re-export the baseline.',
    );
    return;
  }

  if (golden.length === 0) {
    fail(
      2,
      `Golden file has no entries: ${opts.golden}`,
      'An empty baseline can never detect a regression. Re-export it with a filter that matches.',
    );
    return;
  }

  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  let db;
  try {
    db = ensureDatabase(dbPath);
  } catch (err) {
    // "The gate could not run" is exit 2 answered in the requested shape, like
    // every other refusal here. Letting this escape to the top-level catch gave
    // a bare stderr line and exit 1 — so `check --json | jq -r .ok` died on a
    // parse error, and a CI script that separates "regression" (1) from "gate
    // broken" (2) read an unopenable store as a regression. Reachable from a
    // `--dir` typo landing on a file, a read-only workspace, or a locked store.
    fail(2, `Could not open the store: ${errorMessage(err)}`, `Store path: ${dbPath}`);
    return;
  }

  // Gather candidate traces.
  const candidates: TraceWithDetails[] = [];
  // Traces that matched the filters but are not comparable runs (see below), so
  // a zero-candidate refusal can say which of the two things happened.
  let excluded = 0;
  if (opts.trace) {
    // `--trace` names one trace and the filters below are never consulted, so
    // passing both gets the named trace whatever the filters said. Silently, and
    // the contradiction is the interesting case: `--trace X --since 1d` reads as
    // "check X if it is recent" and actually checks X regardless.
    //
    // `export` treats the same combination as a usage error ("a trace id can't
    // be combined with filter flags"). This one only warns, because checking a
    // named trace whatever its lineage or status is documented behaviour that a
    // script may already rely on -- so say the filter did nothing rather than
    // start rejecting a command that used to work. stderr, so a `--json`
    // document is untouched.
    const inertFlags = [
      opts.agent && '--agent',
      opts.agentExact && '--agent-exact',
      opts.since && '--since',
    ].filter(Boolean) as string[];
    if (inertFlags.length > 0) {
      const inert = inertFlags.join(' and ');
      console.error(chalk.yellow(`  ⚠ ${inert} ${inertFlags.length === 1 ? 'has' : 'have'} no effect with --trace.`));
      console.error(chalk.dim('    --trace checks exactly that trace; drop it to check a filtered set.'));
    }
    let t;
    try {
      t = getTrace(db, opts.trace);
    } catch (err) {
      fail(2, errorMessage(err));
      return;
    }
    if (!t) {
      // Exit 1, not 2: the README's table lists "trace not found" under 1, and
      // `diff` already answers 1 for the same condition. A CI script that
      // splits 1 (a regression) from 2 (the gate itself is broken) otherwise
      // read a typo'd --trace id as a broken gate.
      fail(1, `Trace not found: ${opts.trace}`);
      return;
    }
    candidates.push(t);
  } else {
    // Gather EVERY matching candidate — a regression gate that silently stops
    // at the newest N traces can pass green while a real regression sits in an
    // older trace it never fetched. `listTraces` always emits `LIMIT ? OFFSET ?`;
    // SQLite treats a negative LIMIT as unbounded, so -1 returns all matches.
    // Mirrors `exportTraces`, which was moved off a fixed 10000 cap for the same
    // reason (a truncated scan corrupts the very datasets built from it).
    const filter: Record<string, unknown> = { limit: -1 };
    if (opts.agentExact) filter.agent_name_exact = opts.agentExact;
    else if (opts.agent) filter.agent_name = opts.agent;
    if (opts.since) {
      try {
        filter.since = parseSinceToIso(opts.since);
      } catch (err) {
        fail(2, errorMessage(err));
        return;
      }
    }
    try {
      const { items } = listTraces(db, filter);
      for (const item of items) {
        // A FORK is a never-executed copy: `fork` duplicates a step prefix under
        // the same agent name and input, so it matches its own baseline's key and
        // then diverges on step_count and status — reported as REGRESSED, at exit
        // 1, the code reserved for a real regression. One `fork` (the debugging
        // feature this tool leads with) would turn a CI gate permanently red on a
        // shared store, indistinguishably from a genuine failure. Every other
        // consumer already excludes forks by lineage: the hook's open-trace
        // lookup, the OTel merge target, and the running-trace lookup `watch` uses.
        //
        // A RUNNING trace is excluded for the same reason: it is mid-flight, so
        // its partial shape is not a regression. A run that HANGS is refused
        // rather than compared: nothing transitions an abandoned `running` trace
        // to `timeout` on its own, so it simply never becomes a candidate — the
        // gate answers exit 2, never a false green.
        if (item.parent_trace_id != null || item.status === 'running') {
          excluded++;
          continue;
        }
        const full = getTrace(db, item.id);
        // Count a candidate that vanished between the list and the fetch (a
        // concurrent delete or prune) as excluded too, so it cannot fall to the
        // "nothing matched — widen --agent/--since" advice, which would be wrong.
        if (full) candidates.push(full);
        else excluded++;
      }
    } catch (err) {
      fail(2, `Could not read candidate traces: ${errorMessage(err)}`);
      return;
    }
  }

  // Zero candidates is the empty-baseline failure from the other side, and just
  // as silent: nothing to compare means `0 passed, 0 regressed`, `ok: true`,
  // exit 0 — even under --strict, which only counts candidates that were
  // actually fetched. A mistyped --agent, a --since window that outran the
  // recording step, or a --dir typo (ensureDatabase creates a fresh empty store
  // on the spot) all land here, and the gate then stays green forever.
  if (candidates.length === 0 && !opts.allowEmpty) {
    // Say which of the two things happened. "No traces matched" sent the reader
    // to widen --agent/--since when traces DID match and were then excluded as
    // not-comparable — advice that cannot work.
    fail(
      2,
      excluded > 0
        ? `No comparable runs — ${excluded} matching trace(s) were excluded (forks, still running, or gone from the store).`
        : 'No traces matched — nothing to check against the baseline.',
      excluded > 0
        ? 'A fork is a never-executed copy, a running trace is mid-flight, and a trace deleted while this ran is gone, so none can show a regression — and `--trace` compares whatever it names, so pointing it at one of these turns the gate red on a run that never executed. Wait for the run to finish, check the store the runs actually record into with --dir, or pass --allow-empty if this window is expected to have no comparable runs.'
        : 'A check with no candidates cannot detect a regression. Widen --agent/--since, confirm --dir points at the store the run recorded into, or pass --allow-empty if a run with no traces is expected (a quiet nightly window, a matrix job where this agent did not run).',
    );
    return;
  }

  let report;
  try {
    report = checkGolden(golden, candidates, { fields, strict: opts.strict });
  } catch (err) {
    fail(2, errorMessage(err));
    return;
  }

  // Candidates that match NO baseline compare exactly as much as no candidates
  // at all — nothing — yet an unmatched candidate is a pass by default while
  // zero candidates is refused above. So a change that alters every goldenKey
  // (adding `--no-input` to a hook registration blanks every trace's input;
  // renaming an agent; editing an input template) left the gate green forever,
  // on runs it had stopped comparing. Refuse it as the same class of failure,
  // with the same opt-out.
  //
  // NOT under --strict or --trace, which already have defined verdicts for an
  // unmatched candidate: --strict is the user declaring unmatched a REGRESSION
  // (exit 1), and --trace names one specific trace whose unmatched report is the
  // documented answer (exit 0). Preempting either with exit 2 would break the
  // regression-vs-broken-gate split this refusal exists to serve.
  if (
    candidates.length > 0 &&
    report.passed + report.failed === 0 &&
    !opts.allowEmpty &&
    !opts.strict &&
    !opts.trace
  ) {
    // When the candidates recorded no input at all, say so instead of listing
    // guesses. An empty input is never matched, deliberately (see
    // `isMatchable`), and the generic advice below is actively wrong for it:
    // re-exporting the baseline cannot help, because neither side has an
    // identity to pair on. The capture has to start recording an input.
    const noInput = report.unmatched_no_input;
    const hint =
      noInput === candidates.length
        ? `All ${candidates.length} recorded no input, and an empty input is never matched — it is the absence of an identity, not one that happens to be blank, so every input-less run would otherwise pair with every other. Re-exporting the baseline will not change this; the capture has to record an input. Common causes: \`hook --no-input\`, \`record --format codex-exec\`/\`gemini-stream\` (those translators record no input), or OpenTelemetry spans carrying no prompt attribute. Pass --allow-empty if this is expected.`
        : noInput > 0
          ? `${noInput} of ${candidates.length} recorded no input, which is never matched (an empty input is the absence of an identity). For those, the capture has to record an input — re-exporting the baseline will not help. The rest are matched by agent name and a hash of the input, so check for a renamed agent or a changed input template. Pass --allow-empty if this is expected.`
          : 'A check that matches nothing cannot detect a regression. Candidates are matched by agent name and a hash of the trace input, so this usually means the agent was renamed or the input template changed. Re-export the baseline from current runs, or pass --allow-empty if this is expected.';
    fail(
      2,
      `No candidate matched the baseline — ${candidates.length} trace(s) checked, none compared.`,
      hint,
    );
    return;
  }

  // A field named on --fields that no baseline could exercise compared NOTHING
  // and reported a pass. `--fields model` on a baseline captured without
  // per-step models is the common case: every comparison is skipped, the run
  // reports "1 passed", and a CI job that added the flag specifically to catch
  // model swaps is an unconditional green. Unknown field names are already
  // refused for exactly this reason; a valid field with no data behind it is
  // the same false green with a subtler cause. Exit 2 (gate broken), not 1
  // (regression) — nothing regressed, the gate could not run as asked.
  if (report.uncompared.length > 0) {
    fail(
      2,
      `Nothing to compare for --fields ${report.uncompared.join(', ')} — no baseline entry carries that data.`,
      uncomparedHint(report.uncompared),
    );
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  console.log('');
  console.log(heading('  Golden regression check'));
  console.log('');

  for (const r of report.results) {
    if (!r.matched) {
      console.log(`  ${chalk.dim('○')} ${chalk.dim(escapeForMessage(r.trace_id.slice(0, 12)))} ${escapeForMessage(r.agent_name)} — ${chalk.yellow('unmatched')}${opts.strict ? chalk.red(' (strict: fail)') : ''}`);
      continue;
    }
    if (r.passed) {
      console.log(`  ${chalk.green('✔')} ${chalk.dim(escapeForMessage(r.trace_id.slice(0, 12)))} ${escapeForMessage(r.agent_name)} — ${chalk.green('pass')}`);
    } else {
      console.log(`  ${chalk.redBright('✘')} ${chalk.dim(escapeForMessage(r.trace_id.slice(0, 12)))} ${escapeForMessage(r.agent_name)} — ${chalk.redBright('REGRESSED')}`);
      for (const d of r.divergences) {
        const at = d.step_number != null ? chalk.dim(` @step ${d.step_number}`) : '';
        console.log(`      ${chalk.white(d.field)}${at}: golden ${chalk.green(short(d.golden))} → got ${chalk.redBright(short(d.candidate))}`);
      }
    }
  }

  console.log('');
  const uncovered = report.uncovered > 0
    ? `, ${report.uncovered} baseline${report.uncovered === 1 ? '' : 's'} not exercised${opts.strict ? ' (strict: fail)' : ''}`
    : '';
  const summary = `${report.passed} passed, ${report.failed} regressed, ${report.unmatched} unmatched${uncovered}`;
  console.log(report.ok ? chalk.green(`  ${summary}`) : chalk.redBright(`  ${summary}`));
  console.log('');

  process.exitCode = report.ok ? 0 : 1;
}

/**
 * Divergence values are agent-authored (a step name, a tool input) and reach
 * here from trace data OR from a golden baseline file that may have been
 * shared or downloaded, so they are escaped like every other rendered
 * producer string. A lone carriage return in one of them could overwrite the
 * `REGRESSED` line above it and make this gate misreport its own verdict.
 */
/**
 * A divergence value, trimmed for a ONE-LINE gate row.
 *
 * `escapeForMessage`, not `safeText`: the renderer's escaper deliberately keeps
 * newline and tab, which is right for a multi-line block and wrong here. These
 * rows are what a human scans a CI log for, so a value carrying a newline —
 * and this value comes from agent data or a downloaded golden file — could
 * forge an extra `✔ … — pass` line into the verdict.
 */
function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  // `truncate`, not a bare slice: the cut is at an arbitrary code-unit offset
  // over agent data, so it can land between the halves of an astral character
  // and leave a lone surrogate — which the terminal draws as U+FFFD, and only
  // at some values, since whether it happens depends on the exact offset.
  const out = s != null ? truncate(s, 60) : String(s);
  return escapeForMessage(out);
}

/**
 * Why the named fields had nothing to compare, and what actually fixes each.
 *
 * One generic sentence used to cover every field, and it named causes belonging
 * to two of them: `--fields decisions` was explained as "a store captured
 * without per-step models, or a baseline with no tool_call steps", neither of
 * which has anything to do with decisions. Worse, it prescribed one cure —
 * "re-export the baseline from runs that exercise the field" — that cannot work
 * for `model` on a HOOK-captured store: the harness's hook payload does not name
 * the model, so no re-export of those runs will ever carry one. A refusal that
 * names a cause but prescribes the wrong cure is worse than a vague one, because
 * the reader exhausts the suggestion and concludes the tool is broken.
 *
 * Each cause below is the actual condition `entryExercises` tests for that field.
 */
function uncomparedHint(fields: string[]): string {
  const explained = new Set(['model', 'decisions', 'tool_inputs', 'step_errors', 'step_types', 'step_names']);
  const parts: string[] = [];

  if (fields.includes('model')) {
    parts.push(
      'model: no baseline step recorded one. Not every capture path does — a HOOK-captured session cannot, because the harness\'s hook payload does not name the model, so re-exporting those runs will never help. A model comes from an imported Claude Code transcript or Codex rollout, an OpenTelemetry capture (spans carrying a model attribute, or a Gemini CLI / Claude Code log session), or your own agent via the SDK or `record`.',
    );
  }
  if (fields.includes('decisions')) {
    parts.push(
      'decisions: no baseline step recorded a decision. A baseline exported before decisions were comparable carries none, so re-export it from current runs — but if the agent records no decisions, no baseline ever will.',
    );
  }
  if (fields.includes('tool_inputs')) {
    parts.push('tool_inputs: no baseline entry has a tool_call step carrying an input.');
  }
  if (fields.includes('step_errors')) {
    parts.push('step_errors: no baseline step records whether it failed, which means the baseline predates the field — re-export it from current runs.');
  }
  const shapeless = fields.filter((f) => f === 'step_types' || f === 'step_names');
  if (shapeless.length > 0) {
    parts.push(`${shapeless.join(', ')}: the matched baseline entries record no steps at all.`);
  }
  const rest = fields.filter((f) => !explained.has(f));
  if (rest.length > 0) {
    parts.push(`${rest.join(', ')}: the baseline was exported from runs that never recorded it — re-export it from runs that exercise the field.`);
  }

  parts.push('Or drop the field from --fields.');
  return parts.join(' ');
}

