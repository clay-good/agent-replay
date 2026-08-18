import chalk, { type ChalkInstance } from 'chalk';
import type { TraceStatus, StepType } from '../models/enums.js';
import { STEP_TYPE_ICONS, STEP_TYPE_LABELS } from '../models/enums.js';
import { escapeControlChars } from '../utils/json.js';

// ── Color palette ─────────────────────────────────────────────────────────

export const colors = {
  primary: chalk.cyanBright,
  secondary: chalk.magentaBright,
  success: chalk.green,
  error: chalk.redBright,
  warning: chalk.yellow,
  muted: chalk.dim,
  info: chalk.blue,
  highlight: chalk.whiteBright.bold,
};

// ── Text helpers ──────────────────────────────────────────────────────────

export function heading(text: string): string {
  return chalk.bold(colors.primary(text));
}

export function subheading(text: string): string {
  return chalk.bold(colors.secondary(text));
}

export function label(text: string): string {
  return chalk.dim(text);
}

export function value(text: string): string {
  return chalk.white(text);
}

// ── Status badge ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<TraceStatus, ChalkInstance> = {
  running: chalk.yellowBright,
  completed: chalk.greenBright,
  failed: chalk.redBright,
  timeout: chalk.red.dim,
};

const STATUS_SYMBOLS: Record<TraceStatus, string> = {
  running: '\u25CF', // ●
  completed: '\u2714', // ✔
  failed: '\u2718',    // ✘
  timeout: '\u29D6',   // ⧖
};

export function statusBadge(status: TraceStatus): string {
  const color = STATUS_COLORS[status] ?? chalk.white;
  const sym = STATUS_SYMBOLS[status] ?? ' ';
  return color(`${sym} ${status.toUpperCase()}`);
}

// ── Score badge (red→green gradient) ──────────────────────────────────────

/**
 * Render an eval score as a percentage that never rounds across a whole-percent
 * boundary the verdict respects. Stored scores are rounded to 3 decimals (see
 * eval-service `runEval`), so a score is exactly a one-decimal percent; showing
 * that lossless value means a 0.695 score reads "69.5%" — below a 70% threshold
 * it fails — rather than "70%", which would contradict its own `passed: false`.
 * A whole-percent score (0.7 → "70%", 1 → "100%") is shown without a decimal.
 */
export function formatScorePct(score: number): string {
  const pct = Math.round(score * 1000) / 10; // per-mille → one-decimal percent
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * A dollar amount, widening past four decimals only when four would round real
 * spend to "$0.0000". Agent runs routinely cost a fraction of a cent, so a flat
 * toFixed(4) reported zero for a store that had genuinely spent money — and
 * `stats` said "$0.0000" for the same trace `show` displayed as "$0.00002000".
 */
export function formatCostUsd(cost: number): string {
  return cost > 0 && cost < 0.0001 ? `$${cost.toFixed(8)}` : `$${cost.toFixed(4)}`;
}

/**
 * Escape terminal control sequences in text that came from a trace.
 *
 * Step names, errors, models, decision rationales and agent names are producer
 * output: tool stderr, an HTTP error body, a sub-agent's reply. Echoed raw, an
 * ESC sequence in any of them can recolor or clear the terminal of the operator
 * reading the run, or set the window title via OSC — the same threat the live
 * event protocol already escapes for a rejected event line, and the reason the
 * AI-eval prompt fences trace content. ESC bytes also break the width math
 * boxen uses, so a panel with one in it drew misaligned borders.
 *
 * Newline and tab survive: they carry real formatting for multi-line errors and
 * cannot move the cursor or address the terminal. A CRLF pair — what any
 * Windows or PowerShell child writes — is normalized to a newline rather than
 * having its `\r` escaped mid-line. A LONE carriage return is still escaped: it
 * returns the cursor to column 0, which lets text overwrite what was already
 * printed. Everything else in C0, plus DEL, is rendered visibly as `\xNN`.
 */
export function safeText(text: string): string {
  // Delegates, so the renderer and the service-layer warnings cannot disagree
  // about what a control character is — they had, with the protocol's line
  // preview stopping at DEL while this covered C1 too.
  return escapeControlChars(text);
}

export function scoreBadge(score: number): string {
  const display = formatScorePct(score);
  if (score >= 0.8) return chalk.greenBright.bold(display);
  if (score >= 0.6) return chalk.yellow(display);
  if (score >= 0.4) return chalk.rgb(255, 165, 0)(display); // orange
  return chalk.redBright(display);
}

export function passBadge(passed: boolean): string {
  return passed
    ? chalk.bgGreen.black.bold(' PASS ')
    : chalk.bgRed.white.bold(' FAIL ');
}

// ── Step icon ─────────────────────────────────────────────────────────────

const STEP_COLORS: Record<StepType, ChalkInstance> = {
  thought: chalk.blueBright,
  tool_call: chalk.yellowBright,
  llm_call: chalk.magentaBright,
  retrieval: chalk.cyanBright,
  output: chalk.greenBright,
  decision: chalk.whiteBright,
  error: chalk.redBright,
  guard_check: chalk.rgb(255, 165, 0), // orange
};

export function stepIcon(stepType: StepType): string {
  const icon = STEP_TYPE_ICONS[stepType] ?? '?';
  const color = STEP_COLORS[stepType] ?? chalk.white;
  return color(icon);
}

export function stepLabel(stepType: StepType): string {
  const lbl = STEP_TYPE_LABELS[stepType] ?? stepType;
  const color = STEP_COLORS[stepType] ?? chalk.white;
  return color(lbl);
}

// ── Separator ─────────────────────────────────────────────────────────────

export function separator(width?: number): string {
  const w = Math.max(1, width ?? (process.stdout.columns || 80));
  return chalk.dim('\u2500'.repeat(Math.min(w, 120)));
}

// ── Guard action colors ───────────────────────────────────────────────────

export function guardActionBadge(action: string): string {
  switch (action) {
    case 'deny':
      return chalk.bgRed.white.bold(` DENY `);
    case 'warn':
      return chalk.bgYellow.black.bold(` WARN `);
    case 'allow':
      return chalk.bgGreen.black.bold(` ALLOW `);
    case 'require_review':
      return chalk.bgMagenta.white.bold(` REVIEW `);
    default:
      return chalk.dim(action);
  }
}
