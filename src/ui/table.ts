import Table from 'cli-table3';
import chalk from 'chalk';
import type { Trace, EvalResult, GuardrailPolicy } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { statusBadge, scoreBadge, passBadge, guardActionBadge, colors, safeText, safeLine } from './theme.js';
import { formatRelativeTime } from '../utils/time.js';
import { isPossiblyAbandoned } from '../services/trace-service.js';
import { effectiveDurationMs, formatDuration } from '../utils/time.js';
import { truncateToWidth } from './width.js';

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

  // An agent name is producer-controlled and unbounded. cli-table3 sizes a
  // column to its widest cell, so ONE trace with a 5,000-character name widened
  // EVERY row to over 15,000 columns and made the whole listing unreadable —
  // including the traces the user was actually looking for. The neighbouring
  // renderers already bound this (the dashboard at 18 chars, policyTable's
  // pattern at 40); the main listing did not.
  const AGENT_NAME_MAX = 40;

  for (const t of traces) {
    const status = isPossiblyAbandoned(t)
      ? `${statusBadge(t.status as TraceStatus)} ${chalk.yellow('⚠ abandoned?')}`
      : statusBadge(t.status as TraceStatus);
    table.push([
      chalk.dim(safeText(t.id.slice(0, 12))),
      chalk.white(safeLine(truncateToWidth(t.agent_name, AGENT_NAME_MAX))),
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
      chalk.white(safeLine(e.evaluator_name)),
      chalk.dim(e.evaluator_type),
      scoreBadge(e.score),
      passBadge(e.passed),
      chalk.dim(safeLine(details)),
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
      chalk.white(safeLine(p.name)),
      guardActionBadge(p.action),
      chalk.white(String(p.priority)),
      p.enabled ? chalk.green('Yes') : chalk.red('No'),
      // The only unescaped cell in this table: a policy's match pattern is
      // author-supplied JSON, and JSON.stringify leaves C1 controls intact.
      chalk.dim(safeText(truncateToWidth(JSON.stringify(p.match_pattern), 40))),
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
  // Producer JSON: unreachable today because listTraces always supplies
  // step_count, but the fallback exists for a reason and would otherwise put an
  // unescaped producer value in a table cell.
  if (meta?.step_count != null) return safeText(String(meta.step_count));
  return chalk.dim('-');
}

function formatDurationShort(ms: number | null): string {
  // The shared formatter, so `list` cannot disagree with `show`, `replay`,
  // `watch` and `stats` about the same number (2.1m vs 2m 5s) — and so a
  // negative or non-finite stored value renders as "-" here too rather than
  // "-500ms".
  return ms == null ? chalk.dim('-') : chalk.white(formatDuration(ms));
}

/**
 * The SHARED formatter, so `list` cannot disagree with `dashboard` about the
 * same timestamp — the drift `formatDurationShort` above was consolidated to
 * stop. The private copy this replaces had no month bucket ("45d ago" where the
 * dashboard said "1mo ago") and no future guard, so a skewed future timestamp
 * rendered as "just now" while sorting to the top of the list.
 */
function formatRelative(iso: string): string {
  return chalk.dim(formatRelativeTime(iso));
}

function summarizeDetails(details: Record<string, unknown>): string {
  if (!details) return '';

  // AI eval: skipped
  if (details.skipped) return String(details.reason ?? 'Skipped');

  // AI eval: root cause
  if (details.root_cause) return truncateToWidth(String(details.root_cause), 50);

  // AI eval: quality review
  if (details.overall_assessment) return truncateToWidth(String(details.overall_assessment), 50);

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
  return truncateToWidth(JSON.stringify(details), 50);
}


