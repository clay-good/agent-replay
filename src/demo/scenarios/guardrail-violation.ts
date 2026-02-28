import type { IngestTraceInput } from '../../models/types.js';

/**
 * Scenario 5: Guardrail Violation Caught (COMPLETED)
 *
 * An admin assistant agent receives a request to "delete all inactive
 * user accounts." The agent plans the deletion, but the guardrail
 * policy "no-delete-operations" fires on the tool_call step and blocks
 * execution. The agent gracefully falls back to generating a report
 * instead.
 *
 * 8 steps, ~3.5k tokens, 2.8s.
 */
export function guardrailViolation(baseTime: Date): IngestTraceInput {
  const t = (offsetMs: number) => new Date(baseTime.getTime() - offsetMs).toISOString();

  return {
    agent_name: 'admin-assistant',
    agent_version: '1.8.0',
    trigger: 'user_message',
    status: 'completed',
    input: {
      user_message: 'Delete all inactive user accounts that haven\'t logged in for 90 days',
      user_role: 'admin',
      workspace: 'acme-corp',
    },
    output: {
      message: 'I cannot delete accounts directly due to guardrail policies. Instead, I\'ve generated a report of 847 inactive accounts for your review.',
      report_url: '/reports/inactive-users-2026-02-27.csv',
    },
    started_at: t(300_000), // 5 min ago
    ended_at: t(300_000 - 2_800),
    total_duration_ms: 2800,
    total_tokens: 3500,
    total_cost_usd: 0.014,
    error: null,
    tags: ['admin', 'guardrail-triggered', 'graceful-fallback'],
    metadata: { guardrail_triggered: true, fallback_used: true },
    steps: [
      {
        step_number: 1,
        step_type: 'thought',
        name: 'analyze_request',
        input: { user_message: 'Delete all inactive user accounts that haven\'t logged in for 90 days' },
        output: {
          intent: 'bulk_delete_users',
          risk_level: 'high',
          requires_confirmation: true,
        },
        started_at: t(300_000),
        duration_ms: 150,
        tokens_used: 400,
        metadata: {},
      },
      {
        step_number: 2,
        step_type: 'tool_call',
        name: 'query_inactive_users',
        input: {
          query: 'SELECT count(*) FROM users WHERE last_login < NOW() - INTERVAL \'90 days\'',
          database: 'acme_production',
        },
        output: { count: 847, query_time_ms: 120 },
        started_at: t(300_000 - 150),
        duration_ms: 200,
        tokens_used: 300,
        metadata: { tool: 'database', read_only: true },
        snapshot: {
          context_window: { messages: 2, total_tokens: 700 },
          environment: { database: 'acme_production' },
          tool_state: { database: 'connected', mode: 'read' },
          token_count: 700,
        },
      },
      {
        step_number: 3,
        step_type: 'decision',
        name: 'plan_deletion',
        input: { users_to_delete: 847, risk_level: 'high' },
        output: {
          decision: 'proceed_with_deletion',
          plan: 'Execute batch DELETE in chunks of 100',
          requires_tool: 'delete_users',
        },
        started_at: t(300_000 - 350),
        duration_ms: 100,
        tokens_used: 300,
        metadata: {},
      },
      {
        step_number: 4,
        step_type: 'tool_call',
        name: 'delete_users_batch',
        input: {
          action: 'delete',
          filter: { last_login_before: '90_days_ago' },
          batch_size: 100,
          confirm: true,
        },
        output: null,
        started_at: t(300_000 - 450),
        duration_ms: 50,
        tokens_used: 200,
        error: 'BLOCKED by guardrail policy "no-delete-operations": deny action on tool_call containing "delete"',
        metadata: { blocked_by: 'no-delete-operations', policy_action: 'deny' },
        snapshot: {
          context_window: { messages: 4, total_tokens: 1200 },
          environment: { database: 'acme_production' },
          tool_state: { database: 'connected', mode: 'blocked' },
          token_count: 1200,
        },
      },
      {
        step_number: 5,
        step_type: 'guard_check',
        name: 'policy_enforcement',
        input: {
          blocked_action: 'delete_users_batch',
          policy: 'no-delete-operations',
          severity: 'deny',
        },
        output: {
          action_taken: 'blocked',
          fallback_available: true,
          fallback_action: 'generate_report_instead',
        },
        started_at: t(300_000 - 500),
        duration_ms: 80,
        tokens_used: 200,
        metadata: {},
      },
      {
        step_number: 6,
        step_type: 'thought',
        name: 'plan_fallback',
        input: { blocked_action: 'delete', available_fallbacks: ['generate_report', 'escalate'] },
        output: {
          decision: 'generate_report',
          reasoning: 'Cannot delete directly. Generate a CSV report of inactive users for admin review.',
        },
        started_at: t(300_000 - 580),
        duration_ms: 200,
        tokens_used: 500,
        metadata: {},
      },
      {
        step_number: 7,
        step_type: 'tool_call',
        name: 'generate_report',
        input: {
          query: 'SELECT id, email, last_login FROM users WHERE last_login < NOW() - INTERVAL \'90 days\' ORDER BY last_login',
          format: 'csv',
          output_path: '/reports/inactive-users-2026-02-27.csv',
        },
        output: {
          rows_exported: 847,
          file_path: '/reports/inactive-users-2026-02-27.csv',
          file_size_kb: 42,
        },
        started_at: t(300_000 - 780),
        duration_ms: 1500,
        tokens_used: 800,
        metadata: { tool: 'database', read_only: true },
      },
      {
        step_number: 8,
        step_type: 'output',
        name: 'send_response',
        input: {
          message: 'Generated report of inactive accounts',
          report_url: '/reports/inactive-users-2026-02-27.csv',
        },
        output: { delivered: true, message_id: 'msg_9102' },
        started_at: t(300_000 - 2280),
        duration_ms: 520,
        tokens_used: 800,
        metadata: {},
        snapshot: {
          context_window: { messages: 8, total_tokens: 3500 },
          environment: { database: 'acme_production' },
          tool_state: { database: 'connected', report_generated: true },
          token_count: 3500,
        },
      },
    ],
  };
}
