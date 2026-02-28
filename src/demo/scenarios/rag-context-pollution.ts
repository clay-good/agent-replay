import type { IngestTraceInput } from '../../models/types.js';

/**
 * Scenario 3: RAG Context Window Overflow (TIMEOUT)
 *
 * A research assistant performs 4 successive RAG retrievals, each adding
 * thousands of tokens to the context window. By retrieval #4 the context
 * has blown up to 16k+ tokens and the LLM call times out at 35s.
 *
 * 9 steps, ~16k tokens, 35s timeout.
 */
export function ragContextPollution(baseTime: Date): IngestTraceInput {
  const t = (offsetMs: number) => new Date(baseTime.getTime() - offsetMs).toISOString();

  return {
    agent_name: 'research-assistant',
    agent_version: '3.0.1',
    trigger: 'api',
    status: 'timeout',
    input: {
      research_query: 'Compare renewable energy adoption rates across G7 nations in the last decade',
      max_sources: 10,
      output_format: 'structured_report',
    },
    output: null,
    started_at: t(1_800_000), // 30 min ago
    ended_at: t(1_800_000 - 35_000),
    total_duration_ms: 35000,
    total_tokens: 16800,
    total_cost_usd: 0.084,
    error: 'LLM call timed out after 30s — context window exceeded practical limit',
    tags: ['research', 'timeout', 'context-overflow'],
    metadata: { model_max_tokens: 128000, practical_limit: 12000 },
    steps: [
      {
        step_number: 1,
        step_type: 'thought',
        name: 'decompose_query',
        input: { query: 'Compare renewable energy adoption rates across G7 nations' },
        output: {
          sub_queries: [
            'renewable energy statistics USA 2015-2025',
            'EU renewable energy adoption timeline',
            'Japan renewable energy policy changes',
            'G7 renewable energy comparison data',
          ],
        },
        started_at: t(1_800_000),
        duration_ms: 400,
        tokens_used: 1000,
        metadata: {},
        snapshot: {
          context_window: { messages: 1, total_tokens: 1000 },
          environment: {},
          tool_state: {},
          token_count: 1000,
        },
      },
      {
        step_number: 2,
        step_type: 'retrieval',
        name: 'search_usa_energy',
        input: { query: 'renewable energy statistics USA 2015-2025', top_k: 8 },
        output: {
          documents: [
            { title: 'US Energy Information Administration Report 2024', tokens: 2400 },
            { title: 'DOE Renewable Portfolio Standards', tokens: 1800 },
            { title: 'State-by-state renewable adoption data', tokens: 1200 },
          ],
          total_tokens_retrieved: 5400,
        },
        started_at: t(1_800_000 - 400),
        duration_ms: 800,
        tokens_used: 2200,
        metadata: { source: 'academic_db' },
        snapshot: {
          context_window: { messages: 2, total_tokens: 3200, retrieved_chunks: 3 },
          environment: {},
          tool_state: { retrieval_count: 1 },
          token_count: 3200,
        },
      },
      {
        step_number: 3,
        step_type: 'retrieval',
        name: 'search_eu_energy',
        input: { query: 'EU renewable energy adoption timeline', top_k: 8 },
        output: {
          documents: [
            { title: 'European Green Deal Progress Report', tokens: 2100 },
            { title: 'Eurostat Energy Statistics 2024', tokens: 1600 },
            { title: 'REPowerEU Implementation Review', tokens: 1400 },
          ],
          total_tokens_retrieved: 5100,
        },
        started_at: t(1_800_000 - 1200),
        duration_ms: 750,
        tokens_used: 2000,
        metadata: { source: 'academic_db' },
        snapshot: {
          context_window: { messages: 3, total_tokens: 5200, retrieved_chunks: 6 },
          environment: {},
          tool_state: { retrieval_count: 2 },
          token_count: 5200,
        },
      },
      {
        step_number: 4,
        step_type: 'retrieval',
        name: 'search_japan_energy',
        input: { query: 'Japan renewable energy policy changes', top_k: 8 },
        output: {
          documents: [
            { title: 'Japan 6th Strategic Energy Plan', tokens: 1900 },
            { title: 'METI Renewable Energy Targets', tokens: 1500 },
          ],
          total_tokens_retrieved: 3400,
        },
        started_at: t(1_800_000 - 1950),
        duration_ms: 600,
        tokens_used: 1800,
        metadata: { source: 'academic_db' },
        snapshot: {
          context_window: { messages: 4, total_tokens: 7000, retrieved_chunks: 8 },
          environment: {},
          tool_state: { retrieval_count: 3 },
          token_count: 7000,
        },
      },
      {
        step_number: 5,
        step_type: 'retrieval',
        name: 'search_g7_comparison',
        input: { query: 'G7 renewable energy comparison data', top_k: 8 },
        output: {
          documents: [
            { title: 'IEA Global Energy Review 2024', tokens: 3200 },
            { title: 'IRENA Renewable Capacity Statistics', tokens: 2800 },
            { title: 'G7 Climate Action Tracker', tokens: 2100 },
            { title: 'World Bank Energy Indicators', tokens: 1700 },
          ],
          total_tokens_retrieved: 9800,
        },
        started_at: t(1_800_000 - 2550),
        duration_ms: 900,
        tokens_used: 2500,
        metadata: { source: 'academic_db' },
        snapshot: {
          context_window: { messages: 5, total_tokens: 9500, retrieved_chunks: 12 },
          environment: {},
          tool_state: { retrieval_count: 4 },
          token_count: 9500,
        },
      },
      {
        step_number: 6,
        step_type: 'thought',
        name: 'prepare_synthesis_prompt',
        input: {
          total_retrieved_docs: 12,
          total_context_tokens: 9500,
          warning: 'Context approaching practical limit',
        },
        output: {
          decision: 'proceed_with_full_context',
          reasoning: 'All sources are relevant, proceeding with synthesis',
        },
        started_at: t(1_800_000 - 3450),
        duration_ms: 300,
        tokens_used: 1500,
        metadata: {},
        snapshot: {
          context_window: { messages: 6, total_tokens: 11000 },
          environment: {},
          tool_state: { retrieval_count: 4 },
          token_count: 11000,
        },
      },
      {
        step_number: 7,
        step_type: 'llm_call',
        name: 'synthesize_report',
        input: {
          instruction: 'Synthesize a structured comparison report from all retrieved sources',
          context_tokens: 11000,
          max_output_tokens: 4000,
        },
        output: null,
        started_at: t(1_800_000 - 3750),
        duration_ms: 30000,
        tokens_used: 3800,
        model: 'gpt-4-turbo',
        error: 'Request timed out after 30000ms — context window too large for efficient processing',
        metadata: { timeout_ms: 30000, temperature: 0.4 },
        snapshot: {
          context_window: { messages: 7, total_tokens: 14800, status: 'exceeded_practical_limit' },
          environment: {},
          tool_state: {},
          token_count: 14800,
        },
      },
      {
        step_number: 8,
        step_type: 'thought',
        name: 'assess_timeout',
        input: { timeout_step: 7, context_tokens: 14800 },
        output: {
          analysis: 'Context window exceeded practical processing limit',
          recommendation: 'Reduce to top 6 sources and retry',
        },
        started_at: t(1_800_000 - 33750),
        duration_ms: 200,
        tokens_used: 800,
        metadata: {},
      },
      {
        step_number: 9,
        step_type: 'error',
        name: 'timeout_abort',
        input: { reason: 'LLM synthesis call exceeded 30s timeout' },
        output: { partial_result: null, tokens_consumed: 16800, wasted_cost_usd: 0.084 },
        started_at: t(1_800_000 - 33950),
        duration_ms: 1050,
        tokens_used: 200,
        error: 'LLM call timed out after 30s — context window exceeded practical limit',
        metadata: {},
      },
    ],
  };
}
