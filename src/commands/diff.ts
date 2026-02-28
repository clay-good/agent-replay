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
  const dbPath = resolve(opts.dir ?? '.agent-replay', 'traces.db');
  const db = ensureDatabase(dbPath);

  // Resolve both traces (supports prefix-matching)
  const traceA = getTrace(db, traceIdA);
  if (!traceA) {
    console.error(chalk.red(`  Left trace not found: ${traceIdA}`));
    return;
  }

  const traceB = getTrace(db, traceIdB);
  if (!traceB) {
    console.error(chalk.red(`  Right trace not found: ${traceIdB}`));
    return;
  }

  // Compute diff using resolved IDs
  const diff = diffTraces(db, traceA.id, traceB.id);

  // Optionally filter by fields
  if (opts.fields) {
    const allowedFields = opts.fields.split(',').map((f) => f.trim());
    diff.diffs = diff.diffs.filter(
      (d) =>
        allowedFields.includes(d.field) ||
        d.field === 'missing_left' ||
        d.field === 'missing_right',
    );
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
      'Differences': diff.diffs.length,
      'Divergence at': diff.divergence_step != null ? `Step ${diff.divergence_step}` : 'N/A',
    };
    console.log(summaryPanel('Trace Diff Summary', stats));
    console.log('');
  } else {
    // Full diff view
    console.log('');
    console.log(renderDiff(diff, traceA, traceB));
    console.log('');
  }

  // AI-powered diff analysis
  if (opts.ai) {
    const config = loadConfig(opts.dir);
    const resolved = resolveProvider(config);
    if (!resolved) {
      console.error(chalk.red('  No AI provider configured for --ai flag.'));
      console.error(chalk.dim('  Set an API key: agent-replay config set ai.api_keys.anthropic <key>'));
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
    }
  }
}
