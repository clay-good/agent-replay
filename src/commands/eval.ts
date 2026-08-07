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
import { heading } from '../ui/theme.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';
import type { EvalResult } from '../models/types.js';

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
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // Resolve trace
  const trace = getTrace(db, traceId);
  if (!trace) {
    console.error(chalk.red(`  Trace not found: ${traceId}`));
    process.exitCode = 1;
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
      failSpinner(spinner, `Rubric error: ${errorMessage(err)}`);
      process.exitCode = 2;
      return;
    }
    successSpinner(spinner, `Loaded rubric: ${rubric.name}`);

    const evalSpinner = startSpinner(`Running rubric "${rubric.name}"...`);
    try {
      const result = runCustomRubric(db, trace.id, rubric);
      results.push(result);
      successSpinner(evalSpinner, `Rubric "${rubric.name}" complete.`);
    } catch (err) {
      failSpinner(evalSpinner, `Rubric error: ${errorMessage(err)}`);
      process.exitCode = 1;
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
        successSpinner(spinner, `${preset}: ${icon} ${Math.round(result.score * 100)}%`);
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
      console.error(chalk.red(`  Unknown preset: ${opts.preset}`));
      console.error(chalk.dim(`  Deterministic: ${PRESET_NAMES.join(', ')}`));
      console.error(chalk.dim(`  AI-powered:    ${AI_PRESET_NAMES.join(', ')}`));
      process.exitCode = 2;
      return;
    }

    const spinner = startSpinner(`Running ${opts.preset}...`);
    try {
      const result = runEval(db, trace.id, opts.preset);
      results.push(result);
      const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
      successSpinner(spinner, `${opts.preset}: ${icon} ${Math.round(result.score * 100)}%`);
    } catch (err) {
      failSpinner(spinner, `${opts.preset}: ${errorMessage(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  // AI-powered evaluation
  if (opts.ai || isAiPreset) {
    // --max-cost is the spend cap for paid AI calls, so a malformed value must
    // fail loudly rather than fall back to Infinity (an unlimited budget). A
    // typo like "0.O5" would otherwise silently disable the cap. Validate before
    // touching the provider so the message is about the actual mistake.
    let maxCost = Infinity;
    if (opts.maxCost != null) {
      const c = Number(opts.maxCost);
      if (!Number.isFinite(c) || c < 0) {
        console.error(chalk.red(`  Invalid --max-cost: ${opts.maxCost} (must be a non-negative number in USD).`));
        process.exitCode = 2;
        return;
      }
      // Consume the value we just validated. Re-parsing with safeParseFloat below
      // would disagree with Number() on inputs like "" (Number → 0, parseFloat →
      // NaN → the Infinity fallback) or "0x10", silently restoring the unlimited
      // budget this check exists to prevent.
      maxCost = c;
    }

    const config = loadConfig(opts.dir);
    const resolved = resolveProvider(config);
    if (!resolved) {
      console.error(chalk.red('  No AI provider configured.'));
      console.error(chalk.dim('  Set an API key: agent-replay config set ai.api_keys.anthropic <key>'));
      console.error(chalk.dim('  Or set env var: ANTHROPIC_API_KEY, GOOGLE_API_KEY, or OPENAI_API_KEY'));
      process.exitCode = 1;
      return;
    }

    const llmOpts = {
      provider: resolved.provider,
      api_key: resolved.apiKey,
      model: resolved.model,
    };

    const presetsToRun = isAiPreset ? [opts.preset!] : AI_PRESET_NAMES;

    // Show cost estimate
    const estimate = estimateAiEvalCost(trace, presetsToRun, resolved.model);
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

    if (estimate.total_estimated_usd > maxCost) {
      console.error(chalk.red(`  Estimated cost $${estimate.total_estimated_usd.toFixed(4)} exceeds budget $${maxCost.toFixed(4)}`));
      process.exitCode = 1;
      return;
    }

    let cumulativeCost = 0;

    for (const presetName of presetsToRun) {
      if (cumulativeCost > maxCost) {
        console.log(chalk.yellow(`  Budget limit reached ($${cumulativeCost.toFixed(4)}). Stopping.`));
        break;
      }

      const spinner = startSpinner(`Running ${presetName}...`);
      try {
        const result = await runAiEval(db, trace.id, presetName, llmOpts);
        results.push(result);
        const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
        successSpinner(spinner, `${presetName}: ${icon} ${Math.round(result.score * 100)}%`);

        cumulativeCost += Number(result.details?.cost_usd ?? 0);

        // Show detailed AI panel (unless --json)
        if (!opts.json && !result.details?.skipped) {
          console.log('');
          console.log(aiEvalPanel(result));
        }
      } catch (err) {
        failSpinner(spinner, `${presetName}: ${errorMessage(err)}`);
      }
    }
  }

  // If no options specified, run all deterministic presets
  if (!opts.rubric && !opts.preset && !opts.all && !opts.ai) {
    console.log(chalk.yellow('  No evaluator specified. Running all built-in presets.'));
    console.log(chalk.dim('  Tip: Use --ai for AI-powered analysis'));
    console.log('');
    for (const preset of PRESET_NAMES) {
      const spinner = startSpinner(`Running ${preset}...`);
      try {
        const result = runEval(db, trace.id, preset);
        results.push(result);
        const icon = result.passed ? chalk.greenBright('\u2714') : chalk.redBright('\u2718');
        successSpinner(spinner, `${preset}: ${icon} ${Math.round(result.score * 100)}%`);
      } catch (err) {
        failSpinner(spinner, `${preset}: ${errorMessage(err)}`);
        // A preset that throws is a run failure, not a pass — set a non-zero
        // exit (and it never reached `results`, so the pass/fail gate below
        // can't account for it otherwise).
        process.exitCode = 1;
      }
    }
  }

  if (results.length === 0) return;

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
  console.log(heading(`  Evaluation Results for ${trace.id.slice(0, 12)}`));
  console.log('');
  console.log(evalTable(results));
  console.log('');

  // Overall summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;

  const totalCost = results.reduce(
    (sum, r) => sum + (Number(r.details?.cost_usd) || 0),
    0,
  );
  const costStr = totalCost > 0 ? chalk.dim(`  AI cost: $${totalCost.toFixed(6)}`) : '';

  console.log(
    `  ${chalk.greenBright(`${passed} passed`)}  ${failed > 0 ? chalk.redBright(`${failed} failed`) : ''}  ` +
      chalk.dim(`avg score: ${Math.round(avgScore * 100)}%`) + costStr,
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
    } catch {
      throw new Error('Failed to parse YAML rubric. Ensure the yaml package is available.');
    }
  } else {
    parsed = JSON.parse(raw);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Rubric must have a "name" field');
  }
  if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
    throw new Error('Rubric must have a non-empty "criteria" array');
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
  }

  return parsed as Awaited<ReturnType<typeof parseRubric>>;
}
