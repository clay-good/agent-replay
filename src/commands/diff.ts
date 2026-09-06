import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import { diffTraces, aiDiffAnalysis } from '../services/diff-service.js';
import { loadConfig, resolveProvider } from '../services/config-service.js';
import { ensureDatabase } from '../db/index.js';
import { renderDiff, describeFilteredCount } from '../ui/diff-renderer.js';
import { summaryPanel, aiDiffPanel } from '../ui/boxen-panels.js';
import { safeText } from '../ui/theme.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';
import { makeRefuse, openStoreOr } from '../utils/refuse.js';

export interface DiffOptions {
  compact?: boolean;
  json?: boolean;
  fields?: string;
  ai?: boolean;
  dir?: string;
}

/**
 * `agent-replay diff <trace-a> <trace-b>` — side-by-side comparison
 * of two traces with divergence detection and optional AI analysis.
 */
export async function runDiff(
  traceIdA: string,
  traceIdB: string,
  opts: DiffOptions = {},
): Promise<void> {
  const refuse = makeRefuse(opts.json);
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath, opts.dir);
  if (!db) return;

  // Resolve both traces (supports prefix-matching)
  // Resolved one at a time, each with its own guard, so the LEFT id's problem
  // is still reported first — as it was before. An ambiguous prefix is a usage
  // error answered in the requested shape rather than escaping as a bare stack
  // line at exit 1.
  const resolve1 = (id: string, side: string): ReturnType<typeof getTrace> | undefined => {
    try {
      const t = getTrace(db, id);
      if (!t) {
        refuse(1, `${side} trace not found: ${id}`);
        return undefined;
      }
      return t;
    } catch (err) {
      refuse(2, errorMessage(err));
      return undefined;
    }
  };
  const traceA = resolve1(traceIdA, 'Left');
  if (!traceA) return;
  const traceB = resolve1(traceIdB, 'Right');
  if (!traceB) return;

  // Compute diff using resolved IDs
  const diff = diffTraces(db, traceA.id, traceB.id);

  // Optionally filter by fields
  let appliedFields: string[] | undefined;
  // `opts.fields != null`, not truthiness: `--fields ""` is the very case the
  // guard below names (a script interpolating an empty variable), and the empty
  // string skipped the whole block.
  if (opts.fields != null) {
    const allowedFields = opts.fields.split(',').map((f) => f.trim()).filter(Boolean);
    // A list that filters down to NOTHING (`--fields ,` or a script
    // interpolating an empty variable) passed the unknown-name guard vacuously
    // and then removed every field diff, so a pair with seven real differences
    // reported three — with no scope label, since the honest "in <fields>" note
    // keys off a non-empty list. That defeats the guard's whole purpose.
    if (allowedFields.length === 0) {
      refuse(2, `--fields listed no field names: ${JSON.stringify(opts.fields)}`);
      return;
    }
    appliedFields = allowedFields;
    // Reject unknown field names so a typo doesn't silently hide real diffs and
    // imply the traces are more similar than they are.
    const comparable = ['step_type', 'name', 'input', 'output', 'model', 'error', 'decision', 'status', 'trace_input', 'trace_error', 'trace_output'];
    const unknown = allowedFields.filter((f) => !comparable.includes(f));
    if (unknown.length > 0) {
      refuse(2, `Unknown --fields value(s): ${unknown.join(', ')}.`, [`Comparable fields: ${comparable.join(', ')}`]);
      return;
    }
    diff.diffs = diff.diffs.filter(
      (d) =>
        allowedFields.includes(d.field) ||
        d.field === 'missing_left' ||
        d.field === 'missing_right',
    );
    // Recompute the divergence point from the filtered diffs. Otherwise it can
    // still point at a field that --fields removed, so the renderer draws
    // "DIVERGES AT STEP N" directly above "0 difference(s) found" (and --json
    // reports a divergence_step inconsistent with its own diffs). The earliest
    // remaining step is the first visible divergence; none left means none.
    // Only step-level diffs can pin a divergence step; a trace-level one has a
    // null step_number, which Math.min would coerce to 0 and report as step 0.
    const stepNumbers = diff.diffs
      .map((d) => d.step_number)
      .filter((n): n is number => n !== null);
    diff.divergence_step = stepNumbers.length ? Math.min(...stepNumbers) : null;
  }

  // AI analysis, when asked for. Resolved BEFORE the --json early return below:
  // that return came first, so `--ai --json` dropped the flag entirely — no
  // analysis in the payload, nothing on stderr, exit 0. A pipeline reading
  // `diff a b --ai --json | jq .ai_analysis` got null forever, and the
  // "no provider configured" misconfiguration that exits 1 interactively exited
  // 0 in automation. `eval --ai --json` already answered both ways; this is the
  // same contract.
  let aiAnalysis: Awaited<ReturnType<typeof aiDiffAnalysis>> | undefined;
  const analyzeWithAi = async (): Promise<boolean> => {
    // A config file that exists but cannot be parsed is its own failure, and it
    // must not be reported as "No AI provider configured" — that names the
    // wrong problem and points at setting a key that is already in the file.
    // Reported through `refuse` so the --json contract still holds.
    let config;
    try {
      config = loadConfig(opts.dir);
    } catch (err) {
      refuse(1, errorMessage(err), [
        'Fix the file, or start over with: agent-replay init --force',
      ]);
      return false;
    }
    const resolved = resolveProvider(config);
    if (!resolved) {
      refuse(1, 'No AI provider configured for --ai flag.', [
        'Set an API key: agent-replay config set ai.api_keys.anthropic <key>',
      ]);
      return false;
    }
    // The spinner writes to stderr, so it never pollutes a --json stdout.
    const spinner = startSpinner(`Analyzing diff with ${resolved.provider} (${resolved.model})...`);
    try {
      aiAnalysis = await aiDiffAnalysis(db, traceA.id, traceB.id, {
        provider: resolved.provider,
        api_key: resolved.apiKey,
        model: resolved.model,
        // Read the configured ceiling, as `eval` does. Without it this command
        // never even looked at `ai.max_tokens`, so the setting was inert here
        // whatever the service did with it.
        max_tokens: config?.ai?.max_tokens,
      });
      successSpinner(spinner, 'AI analysis complete');
      return true;
    } catch (err) {
      failSpinner(spinner, `AI analysis failed: ${errorMessage(err)}`);
      if (opts.json) refuse(1, `AI analysis failed: ${errorMessage(err)}`);
      else process.exitCode = 1;
      return false;
    }
  };

  // Raw JSON output
  if (opts.json) {
    // `--compact` selects a summary PANEL over the full rendered comparison; it
    // shapes the human view alone, and the JSON document is the same either
    // way. Passing both was silently identical to passing neither, so a caller
    // asking for a smaller payload got the full one with no word of it. The
    // same rule `--with-evals --format golden` and `--steps-only --evals`
    // already follow: name the flag that did nothing. On stderr, so the
    // document on stdout is untouched.
    if (opts.compact) {
      console.error(chalk.yellow('  ⚠ --compact has no effect with --json.'));
      console.error(chalk.dim('    --json always writes the full document; --compact only shapes the human view.'));
    }
    if (opts.ai && !(await analyzeWithAi())) return;
    // Say what was compared. The document carried a `diffs` array and a count
    // with no record of the scope, so `--fields model --json` reporting three
    // differences was byte-for-byte the shape of an UNFILTERED comparison that
    // genuinely found three — and a filter that left nothing produced
    // `"diffs": []`, which reads as "the traces are identical", the one claim
    // the human path is careful never to make. Written on EVERY run, `null`
    // when unfiltered, following the rule the golden `failed` field settled:
    // emitting a key only in one case makes its absence ambiguous between
    // "not narrowed" and "produced by a build that predates the field".
    const document = { ...diff, compared_fields: appliedFields ?? null };
    console.log(JSON.stringify(opts.ai ? { ...document, ai_analysis: aiAnalysis } : document, null, 2));
    return;
  }

  // Compact mode — just summary stats
  if (opts.compact) {
    console.log('');
    const stats: Record<string, string | number> = {
      'Left trace': `${safeText(traceA.agent_name)} (${traceA.id.slice(0, 12)})`,
      'Right trace': `${safeText(traceB.agent_name)} (${traceB.id.slice(0, 12)})`,
      'Left steps': diff.left_step_count,
      'Right steps': diff.right_step_count,
      // Name the scope honestly — `--fields` keeps step-presence rows whatever
      // the allowlist says, so labelling the whole count "in <fields> only"
      // claimed a scope it did not have.
      Differences: appliedFields && appliedFields.length > 0
        ? describeFilteredCount(diff.diffs, appliedFields)
        : diff.diffs.length,
      // The same verdict the full view gives, in the summary's own words: one
      // trace being a PREFIX of the other is not a divergence, and `--compact`
      // is the view a script or a skim reads. Fixing only the full renderer
      // would leave the two views disagreeing about the same pair.
      'Divergence at': diff.common_prefix
        ? `None — ${diff.common_prefix.shorter} stops after step ${diff.common_prefix.last_common_step}`
        : diff.divergence_step != null
          ? `Step ${diff.divergence_step}`
          : 'N/A',
    };
    console.log(summaryPanel('Trace Diff Summary', stats));
    console.log('');
  } else {
    // Full diff view
    console.log('');
    console.log(renderDiff(diff, traceA, traceB, appliedFields));
    console.log('');
  }

  // AI-powered diff analysis. Human mode runs it AFTER the diff view, so the
  // rendered comparison appears before the spinner, as it always has.
  if (opts.ai && (await analyzeWithAi()) && aiAnalysis) {
    console.log('');
    console.log(aiDiffPanel(aiAnalysis));
    console.log('');
  }
}

