import { describe, it, expect } from 'vitest';
import { traceTable, evalTable, policyTable } from '../src/ui/table.js';
import { renderTimeline } from '../src/ui/timeline.js';
import { renderDiff } from '../src/ui/diff-renderer.js';
import type { Trace, TraceStep, EvalResult, GuardrailPolicy, TraceDiffResult } from '../src/models/types.js';
import type { StepType } from '../src/models/enums.js';

/**
 * The UI renderers are otherwise only exercised indirectly (by show/list/diff
 * integration tests) with well-formed data. These lock their behavior on the
 * edge inputs that reach real users — null numeric fields, error steps, huge
 * values, and empty collections — where a crash would break the command.
 */

const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

function trace(over: Partial<Trace> = {}): Trace {
  return {
    id: 'trc_x', agent_name: 'a', agent_version: null, trigger: 'manual', status: 'completed',
    input: {}, output: null, started_at: new Date().toISOString(), ended_at: null,
    total_duration_ms: null, total_tokens: null, total_cost_usd: null, error: null,
    tags: [], metadata: {}, parent_trace_id: null, forked_from_step: null,
    session_id: null, created_at: new Date().toISOString(), ...over,
  };
}
function step(over: Partial<TraceStep> & { step_type: StepType }): TraceStep {
  return {
    id: '', trace_id: '', step_number: 1, name: 's', input: {}, output: null,
    started_at: '', ended_at: null, duration_ms: null, tokens_used: null, model: null,
    error: null, metadata: {}, parent_step_number: null, caused_by_step_number: null, ...over,
  };
}

describe('traceTable', () => {
  it('renders traces with all-null numeric fields without crashing', () => {
    const out = noAnsi(traceTable([trace({ agent_name: 'nully' })]));
    expect(out).toContain('nully');
    expect(out).toContain('-'); // null duration/tokens shown as dashes
  });

  it('handles an empty trace list', () => {
    expect(() => traceTable([])).not.toThrow();
  });

  it('flags an abandoned running trace', () => {
    const stale = trace({ status: 'running', started_at: '2020-01-01T00:00:00Z' });
    expect(noAnsi(traceTable([stale]))).toContain('abandoned');
  });
});

describe('evalTable / policyTable', () => {
  it('evalTable shows a friendly message when empty', () => {
    expect(noAnsi(evalTable([]))).toMatch(/No evaluations/i);
  });

  it('evalTable renders a result', () => {
    const e: EvalResult = { id: 'e', trace_id: 't', evaluator_type: 'rubric', evaluator_name: 'r', score: 0.9, passed: true, details: {}, evaluated_at: '' };
    expect(noAnsi(evalTable([e]))).toContain('r');
  });

  it('policyTable renders a policy', () => {
    const p: GuardrailPolicy = { id: 'p', name: 'no-delete', description: null, action: 'deny', priority: 0, enabled: true, match_pattern: {}, action_params: null, tags: [], created_at: '', updated_at: '' };
    expect(noAnsi(policyTable([p]))).toContain('no-delete');
  });
});

describe('renderTimeline edge cases', () => {
  it('reports no steps for an empty trace', () => {
    expect(noAnsi(renderTimeline([]))).toMatch(/No steps/i);
  });

  it('renders an error step without crashing', () => {
    const out = noAnsi(renderTimeline([step({ step_type: 'error', name: 'boom', error: 'kaboom' })]));
    expect(out).toContain('boom');
    expect(out).toContain('kaboom');
  });

  it('omits null duration/tokens and shows present ones', () => {
    const out = noAnsi(renderTimeline([
      step({ step_type: 'tool_call', name: 'a', duration_ms: null, tokens_used: null }),
      step({ step_number: 2, step_type: 'llm_call', name: 'b', duration_ms: 1500, tokens_used: 999, model: 'gpt-x' }),
    ]));
    expect(out).toContain('999');
    expect(out).toContain('gpt-x');
  });

  it('truncates a huge output instead of dumping it', () => {
    const big = 'x'.repeat(100000);
    const out = renderTimeline([step({ step_type: 'output', name: 'o', output: { text: big } })]);
    expect(out).toContain('...');
    expect(out.length).toBeLessThan(big.length); // truncated, not the full blob
  });
});

describe('renderDiff', () => {
  const diffResult = (over: Partial<TraceDiffResult> = {}): TraceDiffResult => ({
    left_trace_id: 'trc_l', right_trace_id: 'trc_r', divergence_step: null,
    left_step_count: 2, right_step_count: 2, diffs: [], ...over,
  });

  it('reports identical traces', () => {
    const out = noAnsi(renderDiff(diffResult(), trace(), trace()));
    expect(out).toMatch(/identical/i);
  });

  it('renders divergences with null, object, and model values without crashing', () => {
    const diff = diffResult({
      divergence_step: 1,
      diffs: [
        { step_number: 1, field: 'output', left_value: null, right_value: { text: 'x' } },
        { step_number: 1, field: 'model', left_value: 'gpt-4', right_value: 'gpt-5.4-nano' },
        { step_number: 2, field: 'input', left_value: { a: 1 }, right_value: null },
      ],
    });
    let out = '';
    expect(() => { out = noAnsi(renderDiff(diff, trace({ agent_name: 'L' }), trace({ agent_name: 'R' }))); }).not.toThrow();
    expect(out).toContain('3 difference');
    expect(out).toContain('model');
    expect(out).toContain('gpt-5.4-nano');
  });

  it('handles differing step counts (a missing-step divergence)', () => {
    const diff = diffResult({
      divergence_step: 2, left_step_count: 3, right_step_count: 1,
      diffs: [{ step_number: 2, field: 'missing_right', left_value: 'b', right_value: null }],
    });
    expect(() => renderDiff(diff, trace(), trace())).not.toThrow();
  });
});
