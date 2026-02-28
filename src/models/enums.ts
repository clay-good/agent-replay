// ── Trace Status ──────────────────────────────────────────────────────────

export const TRACE_STATUSES = ['running', 'completed', 'failed', 'timeout'] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

// ── Step Type ─────────────────────────────────────────────────────────────

export const STEP_TYPES = [
  'thought',
  'tool_call',
  'llm_call',
  'retrieval',
  'output',
  'decision',
  'error',
  'guard_check',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

// ── Eval Type ─────────────────────────────────────────────────────────────

export const EVAL_TYPES = ['rubric', 'llm_judge', 'policy_check'] as const;
export type EvalType = (typeof EVAL_TYPES)[number];

// ── Trigger Type ──────────────────────────────────────────────────────────

export const TRIGGER_TYPES = ['manual', 'user_message', 'cron', 'webhook', 'api', 'event'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

// ── Guard Action ──────────────────────────────────────────────────────────

export const GUARD_ACTIONS = ['allow', 'deny', 'warn', 'require_review'] as const;
export type GuardAction = (typeof GUARD_ACTIONS)[number];

// ── Step Type Icons ───────────────────────────────────────────────────────
// Unicode symbols for cross-platform terminal display

export const STEP_TYPE_ICONS: Record<StepType, string> = {
  thought:     '\u{1F4AD}', // 💭 thought bubble (fallback: ○)
  tool_call:   '\u{1F527}', // 🔧 wrench
  llm_call:    '\u{1F916}', // 🤖 robot
  retrieval:   '\u{1F50D}', // 🔍 magnifying glass
  output:      '\u{27A1}',  // ➡ right arrow
  decision:    '\u{25C6}',  // ◆ diamond
  error:       '\u{2718}',  // ✘ cross
  guard_check: '\u{1F6E1}', // 🛡 shield
};

// Plain ASCII fallback icons for terminals without Unicode support
export const STEP_TYPE_ICONS_ASCII: Record<StepType, string> = {
  thought:     'o',
  tool_call:   'T',
  llm_call:    'L',
  retrieval:   '?',
  output:      '>',
  decision:    '<>',
  error:       'x',
  guard_check: '#',
};

// ── Display labels ────────────────────────────────────────────────────────

export const STEP_TYPE_LABELS: Record<StepType, string> = {
  thought:     'Thought',
  tool_call:   'Tool Call',
  llm_call:    'LLM Call',
  retrieval:   'Retrieval',
  output:      'Output',
  decision:    'Decision',
  error:       'Error',
  guard_check: 'Guard Check',
};

export const TRACE_STATUS_LABELS: Record<TraceStatus, string> = {
  running:   'Running',
  completed: 'Completed',
  failed:    'Failed',
  timeout:   'Timeout',
};
