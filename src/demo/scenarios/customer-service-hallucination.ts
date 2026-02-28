import type { IngestTraceInput } from '../../models/types.js';

/**
 * Scenario 1: Customer Service Bot Hallucination (FAILED)
 *
 * A customer asks about the return policy. The RAG retrieval correctly
 * finds the "30-day return policy" document, but context pollution from
 * a previous conversation causes the LLM to hallucinate a "lifetime
 * guarantee" that doesn't exist. The guard check catches it but the
 * response has already been sent.
 *
 * 8 steps, ~12k tokens, 4.5s. Designed as a diff pair with scenario 4.
 */
export function customerServiceHallucination(baseTime: Date): IngestTraceInput {
  const t = (offsetMs: number) => new Date(baseTime.getTime() - offsetMs).toISOString();

  return {
    agent_name: 'customer-service-bot',
    agent_version: '2.1.0',
    trigger: 'api',
    status: 'failed',
    input: {
      conversation_id: 'conv_8812',
      user_message: 'What is your return policy? I bought a laptop last week.',
      session_context: { previous_topic: 'warranty_discussion' },
    },
    output: {
      response: 'Great news! We offer a lifetime guarantee on all electronics, including your laptop. You can return it at any time for a full refund!',
      confidence: 0.92,
    },
    started_at: t(3_600_000), // 1 hour ago
    ended_at: t(3_600_000 - 4_500),
    total_duration_ms: 4500,
    total_tokens: 12000,
    total_cost_usd: 0.048,
    error: 'Response contained hallucinated policy information (lifetime guarantee)',
    tags: ['customer-service', 'hallucination', 'production'],
    metadata: { environment: 'production', region: 'us-east-1' },
    steps: [
      {
        step_number: 1,
        step_type: 'thought',
        name: 'analyze_intent',
        input: { user_message: 'What is your return policy? I bought a laptop last week.' },
        output: { intent: 'return_policy_inquiry', product: 'laptop', urgency: 'medium' },
        started_at: t(3_600_000),
        duration_ms: 150,
        tokens_used: 800,
        metadata: {},
        snapshot: {
          context_window: { messages: 1, total_tokens: 800 },
          environment: { session: 'conv_8812' },
          tool_state: {},
          token_count: 800,
        },
      },
      {
        step_number: 2,
        step_type: 'retrieval',
        name: 'search_knowledge_base',
        input: { query: 'return policy electronics laptop', top_k: 5 },
        output: {
          documents: [
            { id: 'doc_101', title: '30-Day Return Policy', relevance: 0.95 },
            { id: 'doc_102', title: 'Warranty Information', relevance: 0.72 },
            { id: 'doc_103', title: 'Lifetime Membership Benefits', relevance: 0.45 },
          ],
        },
        started_at: t(3_600_000 - 150),
        duration_ms: 320,
        tokens_used: 1200,
        metadata: { source: 'vector_db' },
        snapshot: {
          context_window: { messages: 1, total_tokens: 2000, retrieved_docs: 3 },
          environment: { session: 'conv_8812' },
          tool_state: { vector_db: 'connected' },
          token_count: 2000,
        },
      },
      {
        step_number: 3,
        step_type: 'thought',
        name: 'evaluate_context',
        input: { retrieved_docs: 3, previous_topic: 'warranty_discussion' },
        output: {
          selected_docs: ['doc_101', 'doc_103'],
          reasoning: 'User mentioned laptop and warranty context from previous conversation. Including lifetime membership doc for completeness.',
        },
        started_at: t(3_600_000 - 470),
        duration_ms: 200,
        tokens_used: 1500,
        metadata: {},
      },
      {
        step_number: 4,
        step_type: 'llm_call',
        name: 'generate_response',
        input: {
          system_prompt: 'You are a helpful customer service agent.',
          context: 'Return policy: 30-day return window. Lifetime Membership: exclusive benefits for premium members.',
          user_query: 'What is your return policy?',
          previous_context: 'warranty_discussion',
        },
        output: {
          text: 'Great news! We offer a lifetime guarantee on all electronics, including your laptop. You can return it at any time for a full refund!',
          finish_reason: 'stop',
        },
        started_at: t(3_600_000 - 670),
        duration_ms: 1800,
        tokens_used: 5500,
        model: 'gpt-4-turbo',
        metadata: { temperature: 0.3 },
        snapshot: {
          context_window: {
            messages: 4,
            total_tokens: 7500,
            system_prompt_tokens: 200,
            context_tokens: 3500,
          },
          environment: { session: 'conv_8812', model: 'gpt-4-turbo' },
          tool_state: {},
          token_count: 7500,
        },
      },
      {
        step_number: 5,
        step_type: 'decision',
        name: 'confidence_check',
        input: { response_confidence: 0.92, threshold: 0.7 },
        output: { decision: 'proceed', confidence: 0.92 },
        started_at: t(3_600_000 - 2470),
        duration_ms: 50,
        tokens_used: 200,
        metadata: {},
      },
      {
        step_number: 6,
        step_type: 'output',
        name: 'send_response',
        input: {
          text: 'Great news! We offer a lifetime guarantee on all electronics...',
          channel: 'chat_widget',
        },
        output: { delivered: true, message_id: 'msg_4421' },
        started_at: t(3_600_000 - 2520),
        duration_ms: 80,
        tokens_used: 100,
        metadata: {},
      },
      {
        step_number: 7,
        step_type: 'guard_check',
        name: 'fact_verification',
        input: {
          claim: 'lifetime guarantee on all electronics',
          source_docs: ['doc_101', 'doc_103'],
        },
        output: {
          passed: false,
          violations: [
            {
              claim: 'lifetime guarantee',
              evidence: 'Policy doc_101 states 30-day return window only',
              severity: 'high',
            },
          ],
        },
        started_at: t(3_600_000 - 2600),
        duration_ms: 1500,
        tokens_used: 2200,
        metadata: {},
        snapshot: {
          context_window: { messages: 6, total_tokens: 11500 },
          environment: { session: 'conv_8812' },
          tool_state: { guard: 'fact_check_v2' },
          token_count: 11500,
        },
      },
      {
        step_number: 8,
        step_type: 'error',
        name: 'post_send_alert',
        input: { violation_type: 'hallucination', severity: 'high' },
        output: { alert_sent: true, ticket_id: 'INC-2847' },
        started_at: t(3_600_000 - 4100),
        duration_ms: 400,
        tokens_used: 500,
        error: 'Response contained hallucinated policy information (lifetime guarantee)',
        metadata: { escalated: true },
      },
    ],
  };
}
