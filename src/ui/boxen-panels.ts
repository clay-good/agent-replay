import boxen from 'boxen';
import chalk from 'chalk';
import type { Trace } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { statusBadge, colors, label } from './theme.js';

/**
 * Trace metadata header panel (shown at top of `show` command).
 */
export function traceHeaderPanel(trace: Trace): string {
  const lines: string[] = [];

  lines.push(
    `${label('Agent:')}     ${chalk.whiteBright.bold(trace.agent_name)}${trace.agent_version ? chalk.dim(` v${trace.agent_version}`) : ''}`,
  );
  lines.push(`${label('Trace ID:')}  ${chalk.dim(trace.id)}`);
  lines.push(`${label('Status:')}    ${statusBadge(trace.status as TraceStatus)}`);
  lines.push(`${label('Trigger:')}   ${chalk.white(trace.trigger)}`);

  if (trace.total_duration_ms != null) {
    lines.push(`${label('Duration:')}  ${chalk.white(formatDuration(trace.total_duration_ms))}`);
  }
  if (trace.total_tokens != null) {
    lines.push(`${label('Tokens:')}    ${chalk.white(trace.total_tokens.toLocaleString())}`);
  }
  if (trace.total_cost_usd != null) {
    lines.push(`${label('Cost:')}      ${chalk.white('$' + trace.total_cost_usd.toFixed(4))}`);
  }

  lines.push(`${label('Started:')}   ${chalk.white(trace.started_at)}`);
  if (trace.ended_at) {
    lines.push(`${label('Ended:')}     ${chalk.white(trace.ended_at)}`);
  }
  if (trace.tags.length > 0) {
    lines.push(
      `${label('Tags:')}      ${trace.tags.map((t) => colors.info(`[${t}]`)).join(' ')}`,
    );
  }
  if (trace.error) {
    lines.push(`${label('Error:')}     ${chalk.redBright(trace.error)}`);
  }
  if (trace.parent_trace_id) {
    lines.push(`${label('Fork of:')}   ${chalk.dim(trace.parent_trace_id)} ${chalk.dim(`(step ${trace.forked_from_step})`)}`);
  }

  return boxen(lines.join('\n'), {
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round',
  });
}

/**
 * Welcome panel shown after `agent-replay init`.
 */
export function welcomePanel(dbPath: string): string {
  const content = [
    chalk.whiteBright.bold('agent-replay initialized!'),
    '',
    `${label('Database:')}  ${chalk.dim(dbPath)}`,
    '',
    `${colors.primary('Next steps:')}`,
    `  ${chalk.white('agent-replay demo')}     ${chalk.dim('Load sample data & walkthrough')}`,
    `  ${chalk.white('agent-replay ingest')}   ${chalk.dim('Import your own traces')}`,
    `  ${chalk.white('agent-replay --help')}   ${chalk.dim('See all commands')}`,
  ].join('\n');

  return boxen(content, {
    title: 'agent-replay',
    titleAlignment: 'center',
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round',
  });
}

/**
 * Generic summary stats panel.
 */
export function summaryPanel(
  title: string,
  stats: Record<string, string | number>,
): string {
  const lines = Object.entries(stats).map(
    ([k, v]) => `${label(k + ':')}  ${chalk.white(String(v))}`,
  );

  return boxen(lines.join('\n'), {
    title,
    titleAlignment: 'center',
    padding: 1,
    borderColor: 'cyan',
    borderStyle: 'round',
  });
}

/**
 * AI evaluation result panel — renders detailed AI analysis.
 */
export function aiEvalPanel(evalResult: { evaluator_name: string; score: number; passed: boolean; details: Record<string, unknown> }): string {
  const d = evalResult.details;
  const lines: string[] = [];

  if (evalResult.evaluator_name === 'ai-root-cause') {
    lines.push(`${label('Root cause:')}  ${chalk.white(String(d.root_cause ?? 'Unknown'))}`);
    if (d.failing_step != null) {
      lines.push(`${label('Failing step:')} ${chalk.white(String(d.failing_step))}`);
    }
    const factors = d.contributing_factors as string[] | undefined;
    if (factors && factors.length > 0) {
      lines.push(`${label('Factors:')}`);
      for (const f of factors) lines.push(`  ${chalk.dim('-')} ${chalk.white(f)}`);
    }
    if (d.suggested_fix) {
      lines.push(`${label('Suggested fix:')} ${chalk.white(String(d.suggested_fix))}`);
    }
    lines.push(`${label('Severity:')} ${chalk.white(String(d.severity ?? 'medium'))}  ${label('Confidence:')} ${chalk.white(Math.round(evalResult.score * 100) + '%')}`);

  } else if (evalResult.evaluator_name === 'ai-quality-review') {
    const dims = ['relevance', 'completeness', 'coherence', 'accuracy'] as const;
    for (const dim of dims) {
      const val = Number(d[dim] ?? 0);
      const bar = scoreBar(val, 10);
      lines.push(`${label(dim + ':')}  ${bar} ${chalk.white(String(val) + '/10')}`);
    }
    if (d.overall_assessment) {
      lines.push('');
      lines.push(chalk.white(String(d.overall_assessment)));
    }
    const issues = d.issues as string[] | undefined;
    if (issues && issues.length > 0) {
      lines.push('');
      lines.push(`${label('Issues:')}`);
      for (const issue of issues) lines.push(`  ${chalk.dim('-')} ${chalk.yellow(issue)}`);
    }

  } else if (evalResult.evaluator_name === 'ai-security-audit') {
    const risk = String(d.risk_level ?? 'unknown');
    const riskColor = risk === 'none' || risk === 'low' ? chalk.green : risk === 'medium' ? chalk.yellow : chalk.red;
    lines.push(`${label('Risk level:')} ${riskColor(risk.toUpperCase())}  ${label('Safe:')} ${d.safe ? chalk.green('YES') : chalk.red('NO')}`);
    const findings = d.findings as Array<{ type: string; description: string; step?: number; severity?: string }> | undefined;
    if (findings && findings.length > 0) {
      lines.push('');
      lines.push(`${label('Findings:')}`);
      for (const f of findings) {
        const sev = f.severity ? chalk.dim(` [${f.severity}]`) : '';
        const step = f.step != null ? chalk.dim(` (step ${f.step})`) : '';
        lines.push(`  ${chalk.dim('-')} ${chalk.white(f.description)}${step}${sev}`);
      }
    }
    const recs = d.recommendations as string[] | undefined;
    if (recs && recs.length > 0) {
      lines.push('');
      lines.push(`${label('Recommendations:')}`);
      for (const r of recs) lines.push(`  ${chalk.dim('-')} ${chalk.white(r)}`);
    }

  } else if (evalResult.evaluator_name === 'ai-optimization') {
    lines.push(`${label('Efficiency:')} ${chalk.white(String(d.efficiency_score ?? 0) + '/10')}  ${label('Est. waste:')} ${chalk.white(String(d.total_waste_estimate_pct ?? 0) + '%')}`);
    const opts = d.optimizations as Array<{ step: number; type: string; description: string; estimated_savings?: string }> | undefined;
    if (opts && opts.length > 0) {
      lines.push('');
      lines.push(`${label('Optimizations:')}`);
      for (const o of opts) {
        const savings = o.estimated_savings ? chalk.dim(` (save ~${o.estimated_savings})`) : '';
        lines.push(`  ${chalk.dim('-')} Step ${o.step}: ${chalk.white(o.description)}${savings}`);
      }
    }
    if (d.summary) {
      lines.push('');
      lines.push(chalk.white(String(d.summary)));
    }
  } else {
    lines.push(chalk.dim(JSON.stringify(d, null, 2).slice(0, 500)));
  }

  // Cost footer
  if (d.cost_usd != null) {
    lines.push('');
    lines.push(chalk.dim(`Cost: ${d.input_tokens ?? '?'} in + ${d.output_tokens ?? '?'} out tokens = $${Number(d.cost_usd).toFixed(6)} (${d.llm_provider}/${d.llm_model})`));
  }

  const title = evalResult.evaluator_name.replace('ai-', 'AI ').replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return boxen(lines.join('\n'), {
    title: ` ${title} `,
    titleAlignment: 'center',
    padding: 1,
    borderColor: evalResult.passed ? 'green' : 'red',
    borderStyle: 'round',
  });
}

/**
 * AI diff analysis panel.
 */
export function aiDiffPanel(analysis: {
  explanation: string;
  better_trace: string;
  reasoning: string;
  key_differences: string[];
  cost: { tokens_used: number; cost_usd: number };
}): string {
  const lines: string[] = [];

  lines.push(chalk.white(analysis.explanation));
  lines.push('');
  lines.push(`${label('Better trace:')} ${chalk.whiteBright(analysis.better_trace)}`);
  lines.push(`${label('Reasoning:')} ${chalk.white(analysis.reasoning)}`);

  if (analysis.key_differences.length > 0) {
    lines.push('');
    lines.push(`${label('Key differences:')}`);
    for (const diff of analysis.key_differences) {
      lines.push(`  ${chalk.dim('-')} ${chalk.white(diff)}`);
    }
  }

  lines.push('');
  lines.push(chalk.dim(`Cost: ${analysis.cost.tokens_used} tokens = $${analysis.cost.cost_usd.toFixed(6)}`));

  return boxen(lines.join('\n'), {
    title: ' AI Diff Analysis ',
    titleAlignment: 'center',
    padding: 1,
    borderColor: 'magenta',
    borderStyle: 'round',
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function scoreBar(value: number, max: number): string {
  if (!max || !Number.isFinite(max) || max <= 0) return chalk.dim('\u2591'.repeat(10));
  const ratio = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * 10);
  const empty = 10 - filled;
  const color = ratio >= 0.7 ? chalk.green : ratio >= 0.4 ? chalk.yellow : chalk.red;
  return color('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'N/A';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
