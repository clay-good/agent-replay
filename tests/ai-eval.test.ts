import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { applySchemaV1 } from '../src/db/schema.js';
import { ingestTrace, createEval, getTrace } from '../src/services/trace-service.js';
import {
  AI_PRESETS,
  AI_PRESET_NAMES,
  estimateAiEvalCost,
  extractJson,
} from '../src/services/eval-service.js';
import { summarizeTrace, summarizeDiffForLlm } from '../src/services/trace-summarizer.js';
import { estimateCost, COST_TABLE, LlmError } from '../src/services/llm-client.js';
import type { IngestTraceInput } from '../src/models/types.js';

function createTestDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applySchemaV1(db);
  return db;
}

function makeTrace(overrides: Partial<IngestTraceInput> = {}): IngestTraceInput {
  return {
    agent_name: 'test-agent',
    agent_version: '1.0',
    trigger: 'manual',
    status: 'failed',
    input: { task: 'write a function' },
    output: { result: 'error' },
    started_at: new Date().toISOString(),
    error: 'write_file targeted wrong path',
    tags: ['test'],
    steps: [
      { step_number: 1, step_type: 'thought', name: 'plan', input: { plan: 'Read, Write, Test' } },
      { step_number: 2, step_type: 'tool_call', name: 'read_file', input: { path: '/src/index.ts' }, output: { content: 'export {}' }, duration_ms: 100, tokens_used: 200 },
      { step_number: 3, step_type: 'tool_call', name: 'write_file', input: { path: '/tsconfig.json' }, output: { bytes: 100 }, duration_ms: 50, error: 'Wrong path' },
      { step_number: 4, step_type: 'error', name: 'abort', error: 'write_file targeted wrong path' },
    ],
    ...overrides,
  };
}

describe('extractJson', () => {
  it('parses raw JSON', () => {
    const result = extractJson('{"score": 0.8, "details": "good"}');
    expect(result.score).toBe(0.8);
  });

  it('parses JSON from markdown code block', () => {
    const text = 'Here is my analysis:\n```json\n{"score": 0.9}\n```\nDone.';
    const result = extractJson(text);
    expect(result.score).toBe(0.9);
  });

  it('parses JSON from bare code block', () => {
    const text = '```\n{"score": 0.7}\n```';
    const result = extractJson(text);
    expect(result.score).toBe(0.7);
  });

  it('extracts JSON from mixed text', () => {
    const text = 'Analysis: {"root_cause": "wrong path", "confidence": 0.85} end.';
    const result = extractJson(text);
    expect(result.root_cause).toBe('wrong path');
  });

  it('throws on invalid text', () => {
    expect(() => extractJson('no json here')).toThrow('Could not extract JSON');
  });
});

describe('AI presets', () => {
  it('has 4 AI presets', () => {
    expect(AI_PRESET_NAMES).toHaveLength(4);
    expect(AI_PRESET_NAMES).toContain('ai-root-cause');
    expect(AI_PRESET_NAMES).toContain('ai-quality-review');
    expect(AI_PRESET_NAMES).toContain('ai-security-audit');
    expect(AI_PRESET_NAMES).toContain('ai-optimization');
  });

  describe('ai-root-cause', () => {
    const preset = AI_PRESETS['ai-root-cause'];

    it('is applicable to failed traces', () => {
      expect(preset.applicable!({
        input: {}, output: null, error: 'fail', steps: [],
      })).toBe(true);
    });

    it('is applicable to traces with error steps', () => {
      expect(preset.applicable!({
        input: {}, output: null, error: null,
        steps: [{ step_type: 'error' } as any],
      })).toBe(true);
    });

    it('is not applicable to clean traces', () => {
      expect(preset.applicable!({
        input: {}, output: { result: 'ok' }, error: null,
        steps: [{ step_type: 'output' } as any],
      })).toBe(false);
    });

    it('parses valid response', () => {
      const parsed = preset.parse_response(JSON.stringify({
        root_cause: 'wrong file path',
        failing_step: 3,
        contributing_factors: ['no validation'],
        suggested_fix: 'add path check',
        confidence: 0.85,
        severity: 'high',
      }));
      expect(parsed.score).toBe(0.85);
      expect(parsed.passed).toBe(true);
      expect(parsed.details.root_cause).toBe('wrong file path');
    });
  });

  describe('ai-quality-review', () => {
    const preset = AI_PRESETS['ai-quality-review'];

    it('parses valid response', () => {
      const parsed = preset.parse_response(JSON.stringify({
        relevance: 8, completeness: 7, coherence: 9, accuracy: 6,
        overall_assessment: 'Good quality',
        issues: ['minor accuracy issue'],
      }));
      expect(parsed.score).toBeCloseTo(0.75, 1);
      expect(parsed.passed).toBe(true);
      expect(parsed.details.issues).toHaveLength(1);
    });

    it('fails for low scores', () => {
      const parsed = preset.parse_response(JSON.stringify({
        relevance: 2, completeness: 3, coherence: 2, accuracy: 1,
        overall_assessment: 'Poor',
        issues: [],
      }));
      expect(parsed.passed).toBe(false);
    });
  });

  describe('ai-security-audit', () => {
    const preset = AI_PRESETS['ai-security-audit'];

    it('parses safe response', () => {
      const parsed = preset.parse_response(JSON.stringify({
        risk_level: 'none', findings: [], recommendations: [], safe: true,
      }));
      expect(parsed.score).toBe(1.0);
      expect(parsed.passed).toBe(true);
    });

    it('parses high risk response', () => {
      const parsed = preset.parse_response(JSON.stringify({
        risk_level: 'high',
        findings: [{ type: 'injection', description: 'found', step: 2, severity: 'high' }],
        recommendations: ['fix it'],
        safe: false,
      }));
      expect(parsed.score).toBe(0.2);
      expect(parsed.passed).toBe(false);
    });
  });

  describe('ai-optimization', () => {
    const preset = AI_PRESETS['ai-optimization'];

    it('parses valid response', () => {
      const parsed = preset.parse_response(JSON.stringify({
        efficiency_score: 7,
        total_waste_estimate_pct: 20,
        optimizations: [{ step: 2, type: 'redundant', description: 'unnecessary read', estimated_savings: '200 tokens' }],
        summary: 'Mostly efficient',
      }));
      expect(parsed.score).toBe(0.7);
      expect(parsed.passed).toBe(true);
    });
  });
});

describe('trace summarizer', () => {
  it('summarizes a failed trace', () => {
    const db = createTestDb();
    const trace = ingestTrace(db, makeTrace());
    const full = getTrace(db, trace.id)!;

    const summary = summarizeTrace(full);
    expect(summary.text).toContain('test-agent');
    expect(summary.text).toContain('FAILED');
    expect(summary.text).toContain('write_file');
    expect(summary.estimated_tokens).toBeGreaterThan(0);
  });

  it('respects token budget', () => {
    const db = createTestDb();
    const trace = ingestTrace(db, makeTrace());
    const full = getTrace(db, trace.id)!;

    const small = summarizeTrace(full, 100);
    const big = summarizeTrace(full, 10000);
    // Small budget should produce shorter text
    expect(small.text.length).toBeLessThanOrEqual(big.text.length);
  });
});

describe('cost estimation', () => {
  it('estimates cost for haiku', () => {
    const cost = estimateCost('claude-haiku-4-5-20251001', 1000, 500);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it('estimates cost for gemini flash', () => {
    const cost = estimateCost('gemini-2.0-flash', 1000, 500);
    expect(cost).toBeLessThan(estimateCost('claude-haiku-4-5-20251001', 1000, 500));
  });

  it('returns 0 for unknown model', () => {
    expect(estimateCost('unknown-model', 1000, 500)).toBe(0);
  });

  it('estimateAiEvalCost works', () => {
    const db = createTestDb();
    const trace = ingestTrace(db, makeTrace());
    const full = getTrace(db, trace.id)!;

    const estimate = estimateAiEvalCost(full, ['ai-root-cause'], 'claude-haiku-4-5-20251001');
    expect(estimate.total_estimated_usd).toBeGreaterThan(0);
    expect(estimate.breakdown).toHaveLength(1);
    expect(estimate.breakdown[0].preset).toBe('ai-root-cause');
  });
});

describe('createEval with llm_judge type', () => {
  it('stores and retrieves llm_judge eval', () => {
    const db = createTestDb();
    const trace = ingestTrace(db, makeTrace());

    const evalResult = createEval(db, trace.id, {
      evaluator_type: 'llm_judge',
      evaluator_name: 'ai-root-cause',
      score: 0.85,
      passed: true,
      details: {
        root_cause: 'wrong file path',
        cost_usd: 0.002,
        llm_model: 'claude-haiku-4-5-20251001',
      },
    });

    expect(evalResult.evaluator_type).toBe('llm_judge');
    expect(evalResult.evaluator_name).toBe('ai-root-cause');
    expect(evalResult.score).toBe(0.85);
    expect(evalResult.passed).toBe(true);
    expect(evalResult.details.root_cause).toBe('wrong file path');
  });
});

describe('LlmError', () => {
  it('creates error with type and provider', () => {
    const err = new LlmError('bad key', 'auth', 'anthropic', 401);
    expect(err.message).toBe('bad key');
    expect(err.type).toBe('auth');
    expect(err.provider).toBe('anthropic');
    expect(err.statusCode).toBe(401);
    expect(err.name).toBe('LlmError');
  });
});
