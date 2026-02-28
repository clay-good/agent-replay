import Table from 'cli-table3';
import chalk from 'chalk';
import type { Trace, EvalResult, GuardrailPolicy } from '../models/types.js';
import type { TraceStatus } from '../models/enums.js';
import { statusBadge, scoreBadge, passBadge, guardActionBadge, colors } from './theme.js';

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
    table.push([
      chalk.dim(t.id.slice(0, 12)),
      chalk.white(t.agent_name),
      statusBadge(t.status as TraceStatus),
      chalk.white(stepCountStr(t)),
      formatDurationShort(t.total_duration_ms),
      t.total_tokens != null ? chalk.white(t.total_tokens.toLocaleString()) : chalk.dim('-'),
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
      chalk.white(e.evaluator_name),
      chalk.dim(e.evaluator_type),
      scoreBadge(e.score),
      passBadge(e.passed),
      chalk.dim(details),
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
      chalk.dim(p.id.slice(0, 12)),
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

function stepCountStr(trace: Trace): string {
  // We don't have step count on the Trace object directly,
  // so we show '-' unless metadata has it
  const meta = trace.metadata as Record<string, unknown>;
  if (meta?.step_count != null) return String(meta.step_count);
  return chalk.dim('-');
}

function formatDurationShort(ms: number | null): string {
  if (ms == null) return chalk.dim('-');
  if (ms < 1000) return chalk.white(`${ms}ms`);
  if (ms < 60000) return chalk.white(`${(ms / 1000).toFixed(1)}s`);
  return chalk.white(`${(ms / 60000).toFixed(1)}m`);
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
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

  // Deterministic eval: criteria
  const criteria = details.criteria as Array<{ name: string; score: number }> | undefined;
  if (criteria && Array.isArray(criteria)) {
    const failed = criteria.filter((c) => c.score < 0.7);
    if (failed.length === 0) return 'All criteria passed';
    return failed.map((c) => c.name).join(', ');
  }
  return truncate(JSON.stringify(details), 50);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
