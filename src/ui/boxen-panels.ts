import boxen from 'boxen';
import chalk from 'chalk';
import type { Trace } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { statusBadge, colors, label, formatScorePct, formatCostUsd, safeText, safeLine} from './theme.js';
import { effectiveDurationMs, formatDuration } from '../utils/time.js';
import { effectiveTokens } from '../utils/totals.js';
import { truncateToWidth } from './width.js';

/**
 * `boxen`, with a plain-text fallback instead of a crash.
 *
 * boxen reads `process.stdout.columns` itself and subtracts its border width,
 * so at a reported width of 1 or 2 it computes a negative count and throws
 * `RangeError: Invalid count value: -1` out of `String.repeat`. That took down
 * `show`, `init`, `ingest` and `replay` — an uncaught exception from a purely
 * cosmetic concern, and one no caller could reasonably be expected to handle.
 *
 * A terminal that narrow is unusual, but `process.stdout.columns` is not always
 * a real terminal width — it is whatever the environment reports — and a wrong
 * one must degrade the drawing, never stop the command. The content is what the
 * user came for; the border is decoration.
 */
function box(content: string, options: Parameters<typeof boxen>[1]): string {
  try {
    return boxen(content, options);
  } catch {
    return content;
  }
}

/**
 * Trace metadata header panel (shown at top of `show` command).
 *
 * Every value rendered here is escaped unless it is one this tool generates or
 * the schema constrains: `trigger` and `status` are coerced to their enums, and
 * the numerics cannot carry an escape sequence. Everything else is producer
 * output — `validateTraceInput` only checks that `agent_version`, `tags`,
 * `session_id`, `started_at` and `ended_at` are STRINGS, and `record`'s native
 * protocol lets the producer choose the trace `id` — so an ESC/OSC sequence
 * survives `ingest` untouched and reached the terminal of whoever ran `show` or
 * `replay`: setting the window title, leaving a colour or blink attribute set
 * past the command, or (a lone CR) overwriting the line it sits on. It also
 * broke the width math boxen uses, visibly misaligning the box.
 *
 * This list was wrong three times, each time by fixing the fields that had just
 * been reported and not enumerating the rest. Enumerate before editing it again.
 */
/**
 * Panel fields are ONE LINE each, so they use `safeLine` and are bounded.
 *
 * A newline in a producer value inserted an unlabelled line inside the box that
 * the reader has no way to attribute, and an unbounded `agent_name` turned a
 * header into forty wrapped lines of border before the steps the user actually
 * asked for. The prose fields further down (an AI evaluator's explanation,
 * summary, assessment) stay lenient: there a newline is content.
 */
export function traceHeaderPanel(trace: Trace): string {
  const lines: string[] = [];

  lines.push(
    `${label('Agent:')}     ${chalk.whiteBright.bold(safeLine(truncateToWidth(trace.agent_name, 60)))}${trace.agent_version ? chalk.dim(` v${safeLine(truncateToWidth(trace.agent_version, 30))}`) : ''}`,
  );
  // The id too: `record`'s native protocol lets the PRODUCER choose it
  // (`trace_start.trace_id` is only checked for being a non-empty string), so it
  // is no more trustworthy than the fields beside it.
  lines.push(`${label('Trace ID:')}  ${chalk.dim(safeLine(trace.id))}`);
  lines.push(`${label('Status:')}    ${statusBadge(trace.status as TraceStatus)}`);
  lines.push(`${label('Trigger:')}   ${chalk.white(trace.trigger)}`);

  const durationMs = effectiveDurationMs(trace);
  if (durationMs != null) {
    lines.push(`${label('Duration:')}  ${chalk.white(formatDuration(durationMs))}`);
  }
  // Fall back to the steps' own counts. The trace-level column is set only when
  // a producer reports a total, so `show` omitted the Tokens line entirely for a
  // trace whose tokens are recorded per step — while `replay` of the same trace
  // printed a total and `stats` counted it in the store roll-up.
  const tokens = effectiveTokens(trace as Parameters<typeof effectiveTokens>[0]);
  if (tokens != null) {
    lines.push(`${label('Tokens:')}    ${chalk.white(tokens.toLocaleString())}`);
  }
  if (trace.total_cost_usd != null) {
    lines.push(`${label('Cost:')}      ${chalk.white(formatCostUsd(trace.total_cost_usd))}`);
  }

  lines.push(`${label('Started:')}   ${chalk.white(safeLine(trace.started_at))}`);
  if (trace.ended_at) {
    lines.push(`${label('Ended:')}     ${chalk.white(safeLine(trace.ended_at))}`);
  }
  if (trace.tags.length > 0) {
    lines.push(
      `${label('Tags:')}      ${trace.tags.map((t) => colors.info(`[${safeLine(truncateToWidth(t, 40))}]`)).join(' ')}`,
    );
  }
  if (trace.error) {
    lines.push(`${label('Error:')}     ${chalk.redBright(safeLine(truncateToWidth(trace.error, 200)))}`);
  }
  if (trace.parent_trace_id) {
    lines.push(`${label('Fork of:')}   ${chalk.dim(safeLine(trace.parent_trace_id))} ${chalk.dim(`(step ${trace.forked_from_step})`)}`);
  }
  if (trace.session_id) {
    lines.push(`${label('Session:')}   ${chalk.white(safeLine(trace.session_id))}`);
  }

  return box(lines.join('\n'), {
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

  return box(content, {
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
  // Escape the VALUES: the keys are literals at every call site, but the values
  // are not — `import` puts the transcript file's own `session_id` here, and a
  // transcript is producer output like any other. Escaping a number or one of our
  // own ids is a no-op, so this costs nothing at the call sites that are already
  // safe, and it covers the ones added later.
  const lines = Object.entries(stats).map(
    ([k, v]) => `${label(k + ':')}  ${chalk.white(safeLine(String(v)))}`,
  );

  return box(lines.join('\n'), {
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
    lines.push(`${label('Root cause:')}  ${chalk.white(safeText(String(d.root_cause ?? 'Unknown')))}`);
    if (d.failing_step != null) {
      lines.push(`${label('Failing step:')} ${chalk.white(safeText(String(d.failing_step)))}`);
    }
    const factors = d.contributing_factors as string[] | undefined;
    if (factors && factors.length > 0) {
      lines.push(`${label('Factors:')}`);
      for (const f of factors) lines.push(`  ${chalk.dim('-')} ${chalk.white(safeText(String(f)))}`);
    }
    if (d.suggested_fix) {
      lines.push(`${label('Suggested fix:')} ${chalk.white(safeText(String(d.suggested_fix)))}`);
    }
    lines.push(`${label('Severity:')} ${chalk.white(safeText(String(d.severity ?? 'medium')))}  ${label('Confidence:')} ${chalk.white(formatScorePct(evalResult.score))}`);

  } else if (evalResult.evaluator_name === 'ai-quality-review') {
    const dims = ['relevance', 'completeness', 'coherence', 'accuracy'] as const;
    for (const dim of dims) {
      const val = Number(d[dim] ?? 0);
      const bar = scoreBar(val, 10);
      lines.push(`${label(dim + ':')}  ${bar} ${chalk.white(String(val) + '/10')}`);
    }
    if (d.overall_assessment) {
      lines.push('');
      lines.push(chalk.white(safeText(String(d.overall_assessment))));
    }
    const issues = d.issues as string[] | undefined;
    if (issues && issues.length > 0) {
      lines.push('');
      lines.push(`${label('Issues:')}`);
      for (const issue of issues) lines.push(`  ${chalk.dim('-')} ${chalk.yellow(safeText(String(issue)))}`);
    }

  } else if (evalResult.evaluator_name === 'ai-security-audit') {
    const risk = safeText(String(d.risk_level ?? 'unknown'));
    const riskColor = risk === 'none' || risk === 'low' ? chalk.green : risk === 'medium' ? chalk.yellow : chalk.red;
    lines.push(`${label('Risk level:')} ${riskColor(risk.toUpperCase())}  ${label('Safe:')} ${d.safe ? chalk.green('YES') : chalk.red('NO')}`);
    const findings = d.findings as Array<{ type: string; description: string; step?: number; severity?: string }> | undefined;
    if (findings && findings.length > 0) {
      lines.push('');
      lines.push(`${label('Findings:')}`);
      for (const f of findings) {
        const sev = f.severity ? chalk.dim(` [${safeText(String(f.severity))}]`) : '';
        const step = f.step != null ? chalk.dim(` (step ${safeText(String(f.step))})`) : '';
        lines.push(`  ${chalk.dim('-')} ${chalk.white(safeText(String(f.description)))}${step}${sev}`);
      }
    }
    const recs = d.recommendations as string[] | undefined;
    if (recs && recs.length > 0) {
      lines.push('');
      lines.push(`${label('Recommendations:')}`);
      for (const r of recs) lines.push(`  ${chalk.dim('-')} ${chalk.white(safeText(String(r)))}`);
    }

  } else if (evalResult.evaluator_name === 'ai-optimization') {
    lines.push(`${label('Efficiency:')} ${chalk.white(safeText(String(d.efficiency_score ?? 0)) + '/10')}  ${label('Est. waste:')} ${chalk.white(safeText(String(d.total_waste_estimate_pct ?? 0)) + '%')}`);
    const opts = d.optimizations as Array<string | { step: number; type: string; description: string; estimated_savings?: string }> | undefined;
    if (opts && opts.length > 0) {
      lines.push('');
      lines.push(`${label('Optimizations:')}`);
      for (const o of opts) {
        // An entry the model wrote as a bare string has no step/description to
        // read; printing the object template anyway rendered "Step undefined:
        // undefined".
        if (typeof o === 'string') {
          lines.push(`  ${chalk.dim('-')} ${chalk.white(safeText(o))}`);
          continue;
        }
        const savings = o.estimated_savings ? chalk.dim(` (save ~${safeText(String(o.estimated_savings))})`) : '';
        lines.push(`  ${chalk.dim('-')} Step ${safeText(String(o.step))}: ${chalk.white(safeText(String(o.description)))}${savings}`);
      }
    }
    if (d.summary) {
      lines.push('');
      lines.push(chalk.white(safeText(String(d.summary))));
    }
  } else {
    // The whole details blob is producer-controlled — this is the fallback for
    // a shape the branches above don't recognize, so it is exactly where an
    // unmapped field reaches the terminal.
    lines.push(chalk.dim(safeText(JSON.stringify(d, null, 2).slice(0, 500))));
  }

  // Cost footer
  if (d.cost_usd != null) {
    lines.push('');
    // The token counts are escaped too. They sit on the same line as two values
    // that already were, and they are only NUMBERS when the model sent numbers
    // — this object is whatever the provider replied with.
    lines.push(chalk.dim(`Cost: ${safeText(String(d.input_tokens ?? '?'))} in + ${safeText(String(d.output_tokens ?? '?'))} out tokens = $${Number(d.cost_usd).toFixed(6)} (${safeText(String(d.llm_provider ?? '?'))}/${safeText(String(d.llm_model ?? '?'))})`));
  }

  // The title is derived from a stored evaluator name, and boxen measures the
  // string to draw the border — so an escape sequence in it both reached the
  // terminal and made the box misalign by its byte length.
  const title = safeText(evalResult.evaluator_name).replace('ai-', 'AI ').replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return box(lines.join('\n'), {
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

  lines.push(chalk.white(safeText(analysis.explanation)));
  lines.push('');
  lines.push(`${label('Better trace:')} ${chalk.whiteBright(safeText(analysis.better_trace))}`);
  lines.push(`${label('Reasoning:')} ${chalk.white(safeText(analysis.reasoning))}`);

  if (analysis.key_differences.length > 0) {
    lines.push('');
    lines.push(`${label('Key differences:')}`);
    for (const diff of analysis.key_differences) {
      lines.push(`  ${chalk.dim('-')} ${chalk.white(safeText(String(diff)))}`);
    }
  }

  lines.push('');
  lines.push(chalk.dim(`Cost: ${analysis.cost.tokens_used} tokens = $${analysis.cost.cost_usd.toFixed(6)}`));

  return box(lines.join('\n'), {
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

