import { resolve } from 'node:path';
import chalk from 'chalk';
import { getTrace } from '../services/trace-service.js';
import { diffTraces, aiDiffAnalysis } from '../services/diff-service.js';
import { loadConfig, resolveProvider } from '../services/config-service.js';
import { ensureDatabase } from '../db/index.js';
import { renderDiff } from '../ui/diff-renderer.js';
import { summaryPanel, aiDiffPanel } from '../ui/boxen-panels.js';
import { startSpinner, successSpinner, failSpinner } from '../ui/spinner.js';
import { errorMessage } from '../utils/json.js';
import { resolveDataDir } from '../utils/paths.js';

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
  const dbPath = resolve(resolveDataDir(opts.dir), 'traces.db');
  const db = ensureDatabase(dbPath);

  // Resolve both traces (supports prefix-matching)
  const traceA = getTrace(db, traceIdA);
  if (!traceA) {
    console.error(chalk.red(`  Left trace not found: ${traceIdA}`));
    process.exitCode = 1;
    return;
  }

  const traceB = getTrace(db, traceIdB);
  if (!traceB) {
    console.error(chalk.red(`  Right trace not found: ${traceIdB}`));
    process.exitCode = 1;
    return;
  }

  // Compute diff using resolved IDs
  const diff = diffTraces(db, traceA.id, traceB.id);

  // Optionally filter by fields
  let appliedFields: string[] | undefined;
  if (opts.fields) {
    const allowedFields = opts.fields.split(',').map((f) => f.trim()).filter(Boolean);
    appliedFields = allowedFields;
    // Reject unknown field names so a typo doesn't silently hide real diffs and
    // imply the traces are more similar than they are.
    const comparable = ['step_type', 'name', 'input', 'output', 'model', 'error', 'status', 'trace_input', 'trace_error', 'trace_output'];
    const unknown = allowedFields.filter((f) => !comparable.includes(f));
    if (unknown.length > 0) {
      console.error(chalk.red(`  Unknown --fields value(s): ${unknown.join(', ')}. Comparable fields: ${comparable.join(', ')}`));
      process.exitCode = 2;
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

  // Raw JSON output
  if (opts.json) {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  // Compact mode — just summary stats
  if (opts.compact) {
    console.log('');
    const stats: Record<string, string | number> = {
      'Left trace': `${traceA.agent_name} (${traceA.id.slice(0, 12)})`,
      'Right trace': `${traceB.agent_name} (${traceB.id.slice(0, 12)})`,
      'Left steps': diff.left_step_count,
      'Right steps': diff.right_step_count,
      Differences: appliedFields && appliedFields.length > 0
        ? `${diff.diffs.length} (in ${appliedFields.join(', ')} only)`
        : diff.diffs.length,
      'Divergence at': diff.divergence_step != null ? `Step ${diff.divergence_step}` : 'N/A',
    };
    console.log(summaryPanel('Trace Diff Summary', stats));
    console.log('');
  } else {
    // Full diff view
    console.log('');
    console.log(renderDiff(diff, traceA, traceB, appliedFields));
    console.log('');
  }

  // AI-powered diff analysis
  if (opts.ai) {
    const config = loadConfig(opts.dir);
    const resolved = resolveProvider(config);
    if (!resolved) {
      console.error(chalk.red('  No AI provider configured for --ai flag.'));
      console.error(chalk.dim('  Set an API key: agent-replay config set ai.api_keys.anthropic <key>'));
      process.exitCode = 1;
      return;
    }

    const spinner = startSpinner(`Analyzing diff with ${resolved.provider} (${resolved.model})...`);
    try {
      const analysis = await aiDiffAnalysis(db, traceA.id, traceB.id, {
        provider: resolved.provider,
        api_key: resolved.apiKey,
        model: resolved.model,
      });
      successSpinner(spinner, 'AI analysis complete');
      console.log('');
      console.log(aiDiffPanel(analysis));
      console.log('');
    } catch (err) {
      failSpinner(spinner, `AI analysis failed: ${errorMessage(err)}`);
      process.exitCode = 1;
    }
  }
}
