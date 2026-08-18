import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import {
  runEval,
  runCustomRubric,
  runAiEval,
  estimateAiEvalCost,
  PRESET_NAMES,
  AI_PRESET_NAMES,
} from '../services/eval-service.js';
import { loadConfig, resolveProvider } from '../services/config-service.js';
import { ensureDatabase } from '../db/index.js';
import { evalTable } from '../ui/table.js';
import { aiEvalPanel } from '../ui/boxen-panels.js';
import { heading, formatScorePct, safeText } from '../ui/theme.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage, safeRegex } from '../utils/json.js';
import type { EvalResult } from '../models/types.js';
import { resolveDataDir } from '../utils/paths.js';
import { openStoreOr } from '../utils/refuse.js';

export interface EvalOptions {
  rubric?: string;
  preset?: string;
  all?: boolean;
  ai?: boolean;
  maxCost?: string;
  json?: boolean;
  dir?: string;
}

/**
 * `agent-replay eval <trace-id>` — run evaluations against a trace
 * using built-in presets, custom rubric files, or AI-powered analysis.
 */
export async function runEvalCommand(traceId: string, opts: EvalOptions = {}): Promise<void> {
  // Every refusal has to answer in the shape the caller asked for. `eval --json`
  // printed nothing at all on stdout for a missing trace, an unknown preset, no
  // configured provider, or a budget refusal, so a `| jq` pipeline got a parse
  // error where it expected a document it could read a verdict from.
  const refuse = (code: number, message: string, hints: string[] = []): void => {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: message, ...(hints.length ? { hints } : {}) }, null, 2));
    } else {
      console.error(chalk.red(`  ${message}`));
      for (const h of hints) console.error(chalk.dim(`  ${h}`));
    }
    process.exitCode = code;
  };

  // --max-cost is the spend cap for paid AI calls, so a malformed value must
  // fail loudly rather than fall back to Infinity (an unlimited budget). A typo
  // like "0.O5" would otherwise silently disable the cap.
  //
  // Validated for EVERY run, not only one that reaches the provider: it sat
  // inside the `--ai` branch, so a CI job whose --max-cost is a typo'd or empty
  // shell variable passed silently until the first run that happened to enable
  // AI — the run where the cap was already load-bearing. A usage error belongs
  // at the point of use, not at the point of consequence.
  let maxCost = Infinity;
  if (opts.maxCost != null) {
    const c = Number(opts.maxCost);
    if (!Number.isFinite(c) || c < 0) {
      refuse(2, `Invalid --max-cost: ${opts.maxCost} (must be a non-negative number in USD).`);
      return;
    }
    // Consume the value we just validated. Re-parsing with safeParseFloat later
    // would disagree with Number() on inputs like "" (Number → 0, parseFloat →
    // NaN → the Infinity fallback) or "0x10", silently restoring the unlimited
    // budget this check exists to prevent.
    maxCost = c;
  }

  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = openStoreOr(refuse, () => ensureDatabase(dbPath), dbPath);
  if (!db) return;

  // Resolve trace
  let trace;
  try {
    trace = getTrace(db, traceId);
  } catch (err) {
    refuse(2, errorMessage(err));
    return;
  }
  if (!trace) {
    refuse(1, `Trace not found: ${traceId}`);
    return;
  }

  const results: EvalResult[] = [];

  // Custom rubric file
  if (opts.rubric) {
    const spinner = startSpinner(`Loading rubric from ${opts.rubric}...`);
    let rubric: Awaited<ReturnType<typeof parseRubric>>;
    try {
      const raw = readFileSync(resolve(opts.rubric), 'utf-8');
      rubric = await parseRubric(raw, opts.rubric);
    } catch (err) {
      // A malformed or unreadable rubric must fail the command, not exit 0 —
      // otherwise a broken CI gate silently reads as "passed". Treat a bad
      // rubric file as a usage error (exit 2), like a malformed --max-cost.
      failSpinner(spinner, '');
      refuse(2, `Rubric error: ${errorMessage(err)}`);
      return;
    }
    successSpinner(spinner, `Loaded rubric: ${rubric.name}`);

    const evalSpinner = startSpinner(`Running rubric "${rubric.name}"...`);
    try {
      const result = runCustomRubric(db, trace.id, rubric);
      results.push(result);
      successSpinner(evalSpinner, `Rubric "${rubric.name}" complete.`);
    } catch (err) {
      // Answer in the shape that was asked for. These two execution failures
      // returned before the `results.length === 0` JSON fallback below, so
      // `eval --rubric … --json | jq` got a parse error on stdout — the same
      // broken contract the sibling `refuse()` paths were introduced to fix.
      // The human path is unchanged.
      const msg = `Rubric error: ${errorMessage(err)}`;
      if (opts.json) {
        evalSpinner.stop();
        refuse(1, msg);
      } else {
        failSpinner(evalSpinner, msg);
        process.exitCode = 1;
      }
      return;
    }
  }

  // Built-in deterministic presets
  const isAiPreset = opts.preset && AI_PRESET_NAMES.includes(opts.preset);

  if (opts.all) {
    for (const preset of PRESET_NAMES) {
      const spinner = startSpinner(`Running ${preset}...`);
      try {
        const result = runEval(db, trace.id, preset);
        results.push(result);
        const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
        successSpinner(spinner, `${preset}: ${icon} ${formatScorePct(result.score)}`);
      } catch (err) {
        failSpinner(spinner, `${preset}: ${errorMessage(err)}`);
        // A preset that throws is a run failure, not a pass — set a non-zero
        // exit (and it never reached `results`, so the pass/fail gate below
        // can't account for it otherwise).
        process.exitCode = 1;
      }
    }
  } else if (opts.preset && !isAiPreset) {
    if (!PRESET_NAMES.includes(opts.preset)) {
      refuse(2, `Unknown preset: ${opts.preset}`, [
        `Deterministic: ${PRESET_NAMES.join(', ')}`,
        `AI-powered:    ${AI_PRESET_NAMES.join(', ')}`,
      ]);
      return;
    }

    const spinner = startSpinner(`Running ${opts.preset}...`);
    try {
      const result = runEval(db, trace.id, opts.preset);
      results.push(result);
      const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
      successSpinner(spinner, `${opts.preset}: ${icon} ${formatScorePct(result.score)}`);
    } catch (err) {
      const msg = `${opts.preset}: ${errorMessage(err)}`;
      if (opts.json) {
        spinner.stop();
        refuse(1, msg);
      } else {
        failSpinner(spinner, msg);
        process.exitCode = 1;
      }
      return;
    }
  }

  // AI-powered evaluation
  if (opts.ai || isAiPreset) {
    const config = loadConfig(opts.dir);
    const resolved = resolveProvider(config);
    if (!resolved) {
      refuse(1, 'No AI provider configured.', [
        'Set an API key: agent-replay config set ai.api_keys.anthropic <key>',
        'Or set env var: ANTHROPIC_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY',
      ]);
      return;
    }

    const llmOpts = {
      provider: resolved.provider,
      api_key: resolved.apiKey,
      model: resolved.model,
      // `config set ai.max_tokens` was validated, stored, and then read by
      // nothing: the eval path always sent a hard 1024, which takes precedence
      // in callLlm. 1024 output tokens is tight for a security audit or
      // optimization reply with several findings, and a truncated reply fails
      // JSON extraction and is stored as score 0 / passed false — a hard CI
      // failure on a good trace, billed in full, with no supported way to
      // raise the ceiling.
      max_tokens: config?.ai?.max_tokens,
    };

    const presetsToRun = isAiPreset ? [opts.preset!] : AI_PRESET_NAMES;

    // Show cost estimate
    const estimate = estimateAiEvalCost(trace, presetsToRun, resolved.model, llmOpts.max_tokens);
    if (!opts.json) {
      console.log('');
      console.log(
        chalk.dim(`  Estimated cost: ~$${estimate.total_estimated_usd.toFixed(4)} (${resolved.model} via ${resolved.provider})`),
      );
      if (maxCost < Infinity) {
        console.log(chalk.dim(`  Budget limit: $${maxCost.toFixed(4)}`));
      }
      console.log('');
    }

    // Fail CLOSED on an unusable estimate. `NaN > maxCost` is false, so a cost
    // that could not be computed sailed past the only spend guard on paid calls
    // — `--max-cost 0` ran the whole evaluation. The estimate is now required to
    // be a finite number before it can clear a budget.
    if (!Number.isFinite(estimate.total_estimated_usd)) {
      refuse(2, `Could not estimate the cost of this run (got ${estimate.total_estimated_usd}), so --max-cost cannot be honored.`);
      return;
    }
    if (estimate.total_estimated_usd > maxCost) {
      refuse(1, `Estimated cost $${estimate.total_estimated_usd.toFixed(4)} exceeds budget $${maxCost.toFixed(4)}`);
      return;
    }

    let cumulativeCost = 0;

    for (const [presetIndex, presetName] of presetsToRun.entries()) {
      if (cumulativeCost > maxCost) {
        // Same reasoning as the catch below: the remaining presets never reach
        // `results`, so the pass/fail gate can't account for them — a run that
        // stopped early would otherwise report green for evaluators that never
        // ran. The pre-run estimate check already exits 1 for the same reason.
        // stderr, not stdout, so this can't corrupt --json output.
        console.error(
          chalk.yellow(
            `  Budget limit reached ($${cumulativeCost.toFixed(4)}). Stopping with ${presetsToRun.length - presetIndex} evaluator(s) unrun.`,
          ),
        );
        process.exitCode = 1;
        break;
      }

      const spinner = startSpinner(`Running ${presetName}...`);
      try {
        const result = await runAiEval(db, trace.id, presetName, llmOpts);
        results.push(result);
        const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
        successSpinner(spinner, `${presetName}: ${icon} ${formatScorePct(result.score)}`);

        cumulativeCost += Number(result.details?.cost_usd ?? 0);

        // Show detailed AI panel (unless --json)
        if (!opts.json && !result.details?.skipped) {
          console.log('');
          console.log(aiEvalPanel(result));
        }
      } catch (err) {
        failSpinner(spinner, `${presetName}: ${errorMessage(err)}`);
        // An AI preset that throws (provider/network error) is a run failure,
        // not a pass; it also never reached `results`, so the pass/fail gate
        // below can't account for it — set a non-zero exit here.
        process.exitCode = 1;
      }
    }
  }

  // If no options specified, run all deterministic presets
  if (!opts.rubric && !opts.preset && !opts.all && !opts.ai) {
    // stdout is the --json document; these notes belong on stderr there, or the
    // default `eval <id> --json | jq` — the most common invocation — parses
    // three lines of prose before reaching the array.
    const note = opts.json ? console.error : console.log;
    note(chalk.yellow('  No evaluator specified. Running all built-in presets.'));
    note(chalk.dim('  Tip: Use --ai for AI-powered analysis'));
    if (!opts.json) console.log('');
    for (const preset of PRESET_NAMES) {
      const spinner = startSpinner(`Running ${preset}...`);
      try {
        const result = runEval(db, trace.id, preset);
        results.push(result);
        const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
        successSpinner(spinner, `${preset}: ${icon} ${formatScorePct(result.score)}`);
      } catch (err) {
        failSpinner(spinner, `${preset}: ${errorMessage(err)}`);
        // A preset that throws is a run failure, not a pass — set a non-zero
        // exit (and it never reached `results`, so the pass/fail gate below
        // can't account for it otherwise).
        process.exitCode = 1;
      }
    }
  }

  if (results.length === 0) {
    // Still answer in the requested shape: every evaluator throwing (a provider
    // outage, say) printed NOTHING on stdout while exiting 1, so a --json
    // consumer got an empty document rather than a readable "nothing ran".
    if (opts.json) console.log(JSON.stringify([], null, 2));
    return;
  }

  // A failing evaluation (a rubric that misses its threshold, or a built-in
  // preset that fails) is a non-zero exit, so `eval` works as a CI gate — the
  // whole point of "build regression tests" and the README's exit-code table.
  // Set this before any output path so `--json` gates too.
  if (results.some((r) => !r.passed)) {
    process.exitCode = 1;
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log('');
  console.log(heading(`  Evaluation Results for ${safeText(trace.id.slice(0, 12))}`));
  console.log('');
  console.log(evalTable(results));
  console.log('');

  // Overall summary.
  //
  // A preset whose `applicable` predicate said no is stored with score 1.0 and
  // passed:true so it doesn't fail a gate — but it measured NOTHING, and
  // counting it as a pass reported "1 passed, avg score: 100%" for a run in
  // which no evaluator ever looked at the trace. Report those separately.
  const skipped = results.filter((r) => r.details?.skipped === true);
  const measured = results.filter((r) => r.details?.skipped !== true);
  const passed = measured.filter((r) => r.passed).length;
  const failed = measured.length - passed;
  const avgScore = measured.length
    ? measured.reduce((sum, r) => sum + r.score, 0) / measured.length
    : 0;

  const totalCost = results.reduce(
    (sum, r) => sum + (Number(r.details?.cost_usd) || 0),
    0,
  );
  const costStr = totalCost > 0 ? chalk.dim(`  AI cost: $${totalCost.toFixed(6)}`) : '';

  const skippedStr = skipped.length ? chalk.dim(`  ${skipped.length} not applicable`) : '';
  const avgStr = measured.length ? chalk.dim(`avg score: ${Math.round(avgScore * 100)}%`) : chalk.dim('nothing measured');
  console.log(
    `  ${chalk.greenBright(`${passed} passed`)}  ${failed > 0 ? chalk.redBright(`${failed} failed`) : ''}  ` +
      avgStr + skippedStr + costStr,
  );
  console.log('');
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function parseRubric(raw: string, path: string): Promise<{
  name: string;
  threshold?: number;
  criteria: Array<{
    name: string;
    pattern: string;
    expected: boolean;
    weight?: number;
  }>;
}> {
  let parsed: Record<string, unknown>;

  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    try {
      const { parse } = await import('yaml');
      parsed = parse(raw) as Record<string, unknown>;
    } catch (err) {
      // Report what actually went wrong. This claimed a missing package for any
      // throw, and `yaml` is a hard dependency — so the one message a YAML
      // author needs (the parse error's line and column) was discarded in
      // favour of advice that is never right.
      throw new Error(`Failed to parse YAML rubric: ${errorMessage(err)}`);
    }
  } else {
    parsed = JSON.parse(raw);
  }

  // An empty file parses to null, and a bare list or scalar parses to a
  // non-object — both then failed on `parsed.name` with a raw TypeError
  // ("Cannot read properties of null"), which names JavaScript rather than the
  // file the user wrote.
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Rubric must be a JSON/YAML object with "name" and "criteria"');
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Rubric must have a "name" field');
  }
  if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
    throw new Error('Rubric must have a non-empty "criteria" array');
  }

  // Coerce/validate the pass threshold for the same reason as `weight` below: a
  // YAML author naturally quotes it ("threshold: '0.8'"), which arrives as a
  // string. A non-numeric value flows through to `score >= threshold` as
  // `score >= NaN` → always false, silently failing an otherwise-passing trace
  // (a false CI regression on a correct trace); an out-of-range value can never
  // pass or always passes. Reject anything that isn't a number in [0, 1].
  if (parsed.threshold != null) {
    const t = Number(parsed.threshold);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      throw new Error('Rubric "threshold", if set, must be a number between 0 and 1');
    }
    parsed.threshold = t;
  }

  // Validate individual criteria
  for (let i = 0; i < parsed.criteria.length; i++) {
    const c = parsed.criteria[i] as Record<string, unknown>;
    if (!c.name || typeof c.name !== 'string') {
      throw new Error(`criteria[${i}] must have a "name" string`);
    }
    if (!c.pattern || typeof c.pattern !== 'string') {
      throw new Error(`criteria[${i}] must have a "pattern" string`);
    }
    if (typeof c.expected !== 'boolean') {
      throw new Error(`criteria[${i}] must have an "expected" boolean`);
    }
    // A YAML author naturally quotes numbers ("weight: '2'"), which arrives as a
    // string. Left unchecked it would later hit `totalWeight += weight` as string
    // concatenation and corrupt the aggregate score. Coerce a numeric weight to a
    // real number here and reject anything that isn't a non-negative number.
    if (c.weight != null) {
      const w = Number(c.weight);
      if (!Number.isFinite(w) || w < 0) {
        throw new Error(`criteria[${i}] "weight", if set, must be a non-negative number`);
      }
      c.weight = w;
    }
    // Compile it here, where a bad pattern is still a USAGE error. The scorer
    // pushes an uncompilable pattern as score 0 carrying its full weight, and the
    // human table prints only the criterion NAME — indistinguishable from a
    // genuine non-match. So a rubric whose pattern the (deliberately
    // conservative) ReDoS filter rejects reported a quality FAILURE of the trace,
    // exit 1, on a correct run.
    if (!safeRegex(String(c.pattern), 'i')) {
      throw new Error(
        `criteria[${i}] "pattern" could not be used: ${JSON.stringify(c.pattern)}. ` +
          'Either it is not a valid regular expression, or it was refused as a backtracking risk — ' +
          'a quantified group containing alternation (`(a|b)+`) or nested quantifiers. ' +
          'The check is deliberately conservative, so a safe pattern of that shape is refused too; ' +
          'rewrite it (for example as a character class) if so.',
      );
    }
  }

  // A rubric whose criteria all weigh 0 divides by zero: the scorer returns 0,
  // so the run reported "0% FAIL" (exit 1) directly beside "All criteria
  // passed" — a false CI regression on a correct trace, with the report
  // contradicting itself. Zeroing a weight is normal authoring ("disable this
  // one for now"), so the rubric as a whole must still be able to score.
  const criteria = parsed.criteria as Array<Record<string, unknown>>;
  if (!criteria.some((c) => Number(c.weight ?? 1) > 0)) {
    throw new Error('Rubric must have at least one criterion with a weight greater than 0');
  }

  // Two criteria under one name collapse in `details.criteria`, so a consumer
  // keying by name gets an arbitrary one of them and the human table prints two
  // identical-looking rows with different verdicts.
  const names = new Set<string>();
  for (const c of criteria) {
    const name = String(c.name);
    if (names.has(name)) {
      throw new Error(`Rubric has two criteria named ${JSON.stringify(name)} — names must be unique`);
    }
    names.add(name);
  }

  return parsed as Awaited<ReturnType<typeof parseRubric>>;
}
