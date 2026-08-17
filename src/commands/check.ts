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

export interface CheckOptions {
  golden?: string;
  trace?: string;
  agent?: string;
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
  const fail = (code: number, message: string, hint?: string): void => {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: message, ...(hint ? { hint } : {}) }, null, 2));
    } else {
      console.error(chalk.red(`  ${message}`));
      if (hint) console.error(chalk.dim(`  ${hint}`));
    }
    process.exitCode = code;
  };

  if (!opts.golden) {
    fail(2, '--golden <file> is required.');
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

  if (golden.length === 0) {
    fail(
      2,
      `Golden file has no entries: ${opts.golden}`,
      'An empty baseline can never detect a regression. Re-export it with a filter that matches.',
    );
    return;
  }

  // Validate --fields BEFORE touching the store. It was checked inside
  // checkGolden, after every candidate had been fetched, so a plain typo was
  // reported as whatever the data layer complained about first ("No traces
  // matched...", exit 2 — never naming the bad field) or as exit 1 from a
  // store-open failure. `watch` already validates --interval before resolving a
  // trace; usage errors belong before the work.
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
    const t = getTrace(db, opts.trace);
    if (!t) {
      fail(2, `Trace not found: ${opts.trace}`);
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
    if (opts.agent) filter.agent_name = opts.agent;
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
    fail(
      2,
      `No candidate matched the baseline — ${candidates.length} trace(s) checked, none compared.`,
      'A check that matches nothing cannot detect a regression. Candidates are matched by agent name and a hash of the trace input, so this usually means the agent was renamed, the input template changed, or capture stopped recording the input (`hook --no-input`). Re-export the baseline from current runs, or pass --allow-empty if this is expected.',
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
      console.log(`  ${chalk.dim('○')} ${chalk.dim(safeText(r.trace_id.slice(0, 12)))} ${safeText(r.agent_name)} — ${chalk.yellow('unmatched')}${opts.strict ? chalk.red(' (strict: fail)') : ''}`);
      continue;
    }
    if (r.passed) {
      console.log(`  ${chalk.green('✔')} ${chalk.dim(safeText(r.trace_id.slice(0, 12)))} ${safeText(r.agent_name)} — ${chalk.green('pass')}`);
    } else {
      console.log(`  ${chalk.redBright('✘')} ${chalk.dim(safeText(r.trace_id.slice(0, 12)))} ${safeText(r.agent_name)} — ${chalk.redBright('REGRESSED')}`);
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
function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const out = s != null && s.length > 60 ? `${s.slice(0, 57)}...` : String(s);
  return safeText(out);
}
