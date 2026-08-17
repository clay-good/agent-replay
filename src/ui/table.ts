import Table from 'cli-table3';
import chalk from 'chalk';
import type { Trace, EvalResult, GuardrailPolicy } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { statusBadge, scoreBadge, passBadge, guardActionBadge, colors, safeText } from './theme.js';
import { isPossiblyAbandoned } from '../services/trace-service.js';
import { effectiveDurationMs, formatDuration } from '../utils/time.js';

// ── Generic table factory ─────────────────────────────────────────────────

export function createTable(
  headers: string[],
  colWidths?: number[],
): Table.Table {
  return new Table({
    head: headers.map((h) => colors.primary(h)),
    style: {
      head: [],
      border: ['dim'],
    },
    ...(colWidths ? { colWidths } : {}),
  });
}

// ── Trace list table ──────────────────────────────────────────────────────

export function traceTable(traces: Trace[]): string {
  const table = new Table({
    head: [
      colors.primary('ID'),
      colors.primary('Agent'),
      colors.primary('Status'),
      colors.primary('Steps'),
      colors.primary('Duration'),
      colors.primary('Tokens'),
      colors.primary('Started'),
    ],
    style: { head: [], border: ['dim'] },
  });

  for (const t of traces) {
    const status = isPossiblyAbandoned(t)
      ? `${statusBadge(t.status as TraceStatus)} ${chalk.yellow('⚠ abandoned?')}`
      : statusBadge(t.status as TraceStatus);
    table.push([
      chalk.dim(t.id.slice(0, 12)),
      chalk.white(safeText(t.agent_name)),
      status,
      chalk.white(stepCountStr(t)),
      formatDurationShort(effectiveDurationMs(t)),
      // `effective_tokens` falls back to the steps' own counts; the trace-level
      // column is only set when a producer reports a total, so this column read
      // "-" for every trace whose tokens are recorded per step.
      tokensCell(t),
      formatRelative(t.started_at),
    ]);
  }

  return table.toString();
}

// ── Eval results table ────────────────────────────────────────────────────

export function evalTable(evals: EvalResult[]): string {
  if (evals.length === 0) return chalk.dim('  No evaluations found.');

  const table = new Table({
    head: [
      colors.primary('Evaluator'),
      colors.primary('Type'),
      colors.primary('Score'),
      colors.primary('Result'),
      colors.primary('Details'),
    ],
    style: { head: [], border: ['dim'] },
  });

  for (const e of evals) {
    const details = summarizeDetails(e.details);
    table.push([
      chalk.white(safeText(e.evaluator_name)),
      chalk.dim(e.evaluator_type),
      scoreBadge(e.score),
      passBadge(e.passed),
      chalk.dim(safeText(details)),
    ]);
  }

  return table.toString();
}

// ── Policy table ──────────────────────────────────────────────────────────

export function policyTable(policies: GuardrailPolicy[]): string {
  if (policies.length === 0) return chalk.dim('  No guardrail policies found.');

  const table = new Table({
    head: [
      colors.primary('ID'),
      colors.primary('Name'),
      colors.primary('Action'),
      colors.primary('Priority'),
      colors.primary('Enabled'),
      colors.primary('Pattern'),
    ],
    style: { head: [], border: ['dim'] },
  });

  for (const p of policies) {
    table.push([
      // The FULL id. Truncating it printed a value that `guard disable/enable/
      // remove` then rejected as "not found" — they resolve by exact id or name,
      // with no prefix matching — so copying the id straight out of this table
      // was guaranteed to fail. A policy id is `pol_` + 12 chars, so the whole
      // thing fits.
      chalk.dim(p.id),
      chalk.white(p.name),
      guardActionBadge(p.action),
      chalk.white(String(p.priority)),
      p.enabled ? chalk.green('Yes') : chalk.red('No'),
      chalk.dim(truncate(JSON.stringify(p.match_pattern), 40)),
    ]);
  }

  return table.toString();
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** The trace's token usage as displayed: reported total, else the steps' sum. */
function tokensCell(t: Trace): string {
  const tokens = t.effective_tokens ?? t.total_tokens;
  return tokens != null ? chalk.white(tokens.toLocaleString()) : chalk.dim('-');
}

function stepCountStr(trace: Trace): string {
  // listTraces computes step_count; fall back to metadata, then a dash.
  if (trace.step_count != null) return String(trace.step_count);
  const meta = trace.metadata as Record<string, unknown>;
  if (meta?.step_count != null) return String(meta.step_count);
  return chalk.dim('-');
}

function formatDurationShort(ms: number | null): string {
  // The shared formatter, so `list` cannot disagree with `show`, `replay`,
  // `watch` and `stats` about the same number (2.1m vs 2m 5s) — and so a
  // negative or non-finite stored value renders as "-" here too rather than
  // "-500ms".
  return ms == null ? chalk.dim('-') : chalk.white(formatDuration(ms));
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  // Guard an unparseable/empty started_at: getTime() is NaN, so every `<`
  // comparison below is false and the last branch would print "NaNd ago". Show
  // "-" instead, matching the sibling helpers formatRelativeTime/formatTimestamp.
  if (Number.isNaN(d.getTime())) return chalk.dim('-');
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return chalk.dim('just now');
  if (diffSec < 3600) return chalk.dim(`${Math.floor(diffSec / 60)}m ago`);
  if (diffSec < 86400) return chalk.dim(`${Math.floor(diffSec / 3600)}h ago`);
  return chalk.dim(`${Math.floor(diffSec / 86400)}d ago`);
}

function summarizeDetails(details: Record<string, unknown>): string {
  if (!details) return '';

  // AI eval: skipped
  if (details.skipped) return String(details.reason ?? 'Skipped');

  // AI eval: root cause
  if (details.root_cause) return truncate(String(details.root_cause), 50);

  // AI eval: quality review
  if (details.overall_assessment) return truncate(String(details.overall_assessment), 50);

  // AI eval: security audit
  if (details.risk_level != null) return `Risk: ${details.risk_level}`;

  // AI eval: optimization
  if (details.efficiency_score != null) return `Efficiency: ${details.efficiency_score}/10`;

  // AI eval: parse error
  if (details.parse_error) return 'LLM response parse error';

  // Deterministic eval: criteria. Use the threshold the evaluation actually
  // recorded, not a hardcoded 0.7 — a criterion scoring below a stricter
  // threshold (or a rubric's own) was folded into "All criteria passed" while
  // having cost the eval part of its weight.
  const criteria = details.criteria as Array<{ name: string; score: number }> | undefined;
  if (criteria && Array.isArray(criteria)) {
    const threshold = typeof details.threshold === 'number' ? details.threshold : 0.7;
    const failed = criteria.filter((c) => c.score < threshold);
    if (failed.length === 0) return 'All criteria passed';
    return failed.map((c) => c.name).join(', ');
  }
  return truncate(JSON.stringify(details), 50);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
