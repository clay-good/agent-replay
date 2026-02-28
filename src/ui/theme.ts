import chalk, { type ChalkInstance } from 'chalk';
import type { TraceStatus, StepType } from '../models/enums.js';
import { STEP_TYPE_ICONS, STEP_TYPE_LABELS } from '../models/enums.js';

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

export function scoreBadge(score: number): string {
  const pct = Math.round(score * 100);
  const display = `${pct}%`;
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
