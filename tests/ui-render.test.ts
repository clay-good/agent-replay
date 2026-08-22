import { describe, it, expect } from 'vitest';
import { traceTable, evalTable, policyTable } from '../src/ui/table.js';
import { traceHeaderPanel, summaryPanel } from '../src/ui/boxen-panels.js';
import { formatScorePct, formatCostUsd, safeText, safeLine } from '../src/ui/theme.js';
import { formatDuration } from '../src/utils/time.js';
import { renderTimeline, renderTree } from '../src/ui/timeline.js';
import stringWidth from 'string-width';
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

  it('formats the duration column with the same formatter every other view uses', () => {
    // One formatter across list/show/replay/watch/stats: four copies existed and
    // disagreed above a minute, so `list` said "1.5m" where `watch` said
    // "1m 30s" for the very same number, and a single `replay` screen printed
    // both forms of one duration four lines apart.
    const out = noAnsi(traceTable([
      trace({ id: 'trc_a', agent_name: 'fast', total_duration_ms: 500 }),
      trace({ id: 'trc_b', agent_name: 'mid', total_duration_ms: 5000 }),
      trace({ id: 'trc_c', agent_name: 'slow', total_duration_ms: 90000 }),
      // A negative stored value is not a duration; the shared formatter refuses
      // it, where the column's own copy printed "-500ms".
      trace({ id: 'trc_d', agent_name: 'bad', total_duration_ms: -500 }),
    ]));
    expect(out).toContain('500ms');
    expect(out).toContain('5.0s');
    expect(out).toContain(formatDuration(90000));
    expect(out).not.toContain('-500ms');
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

  it('evalTable summarizes deterministic criteria (failed names, or all-passed)', () => {
    const withFailure: EvalResult = {
      id: 'e1', trace_id: 't', evaluator_type: 'rubric', evaluator_name: 'quality', score: 0.5, passed: false,
      details: { criteria: [{ name: 'grounded', score: 0.9 }, { name: 'no_hedging', score: 0.2 }] }, evaluated_at: '',
    };
    // Only the sub-threshold criterion is named in the summary.
    const failOut = noAnsi(evalTable([withFailure]));
    expect(failOut).toContain('no_hedging');
    expect(failOut).not.toContain('grounded');

    const allPass: EvalResult = {
      id: 'e2', trace_id: 't', evaluator_type: 'rubric', evaluator_name: 'safety', score: 1, passed: true,
      details: { criteria: [{ name: 'no_pii', score: 1 }] }, evaluated_at: '',
    };
    expect(noAnsi(evalTable([allPass]))).toContain('All criteria passed');
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

describe('renderTree — causal annotations', () => {
  it('shows "caused by" links for a flat trace with no parent nesting', () => {
    // A decision followed by the steps it caused: every parent_step is null but
    // caused_by_step is set. --tree must still render here (not fall back to the
    // plain timeline) so its causal annotations actually appear.
    const out = noAnsi(renderTree([
      step({ step_number: 1, step_type: 'decision', name: 'pick' }),
      step({ step_number: 2, step_type: 'tool_call', name: 'call', caused_by_step_number: 1 }),
      step({ step_number: 3, step_type: 'output', name: 'done', caused_by_step_number: 2 }),
    ]));
    expect(out).toContain('caused by #1');
    expect(out).toContain('caused by #2');
  });

  it('nests children under a parent and annotates their causal links', () => {
    const out = noAnsi(renderTree([
      step({ step_number: 1, step_type: 'decision', name: 'root' }),
      step({ step_number: 2, step_type: 'tool_call', name: 'child', parent_step_number: 1, caused_by_step_number: 1 }),
    ]));
    expect(out).toContain('root');
    expect(out).toContain('child');
    expect(out).toContain('caused by #1');
  });

  it('falls back to a plain timeline only when there is no causal structure', () => {
    const out = noAnsi(renderTree([
      step({ step_number: 1, step_type: 'output', name: 'lonely' }),
    ]));
    expect(out).toContain('lonely');
    expect(out).not.toContain('caused by');
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

  it('shows the value of a step that exists on only one side', () => {
    // A right-only step (missing_left) must display its value in the Right
    // column, not blank it out as "(none)".
    const diff = diffResult({
      divergence_step: 3, left_step_count: 2, right_step_count: 3,
      diffs: [{ step_number: 3, field: 'missing_left', left_value: null, right_value: 'extra_step_xyz' }],
    });
    const out = noAnsi(renderDiff(diff, trace(), trace()));
    expect(out).toContain('extra_step_xyz');
    expect(out).toContain('Right only');
  });
});

describe('renderDiff verdict and value windowing', () => {
  const trace = (id: string, status: string): Trace => ({
    id, agent_name: 'a', agent_version: null, trigger: 'manual', status,
    input: {}, output: null, started_at: '2026-08-17T00:00:00Z', ended_at: null,
    total_duration_ms: null, total_tokens: null, total_cost_usd: null, error: null,
    tags: [], metadata: {}, parent_trace_id: null, forked_from_step: null,
    session_id: null, created_at: '2026-08-17T00:00:00Z',
  } as unknown as Trace);

  it('does not claim two traces are identical over a filtered comparison', () => {
    // With --fields narrowing the diff to nothing, the renderer printed a flat
    // "Traces are identical." under a header showing COMPLETED beside FAILED.
    const empty = {
      diffs: [], divergence_step: null,
      left_trace_id: 'trc_left0000', right_trace_id: 'trc_right000',
      left_step_count: 2, right_step_count: 2,
    } as unknown as TraceDiffResult;
    const unfiltered = noAnsi(renderDiff(empty, trace('l', 'completed'), trace('r', 'failed')));
    expect(unfiltered).toContain('Traces are identical.');

    const filtered = noAnsi(renderDiff(empty, trace('l', 'completed'), trace('r', 'failed'), ['model']));
    expect(filtered).not.toContain('Traces are identical.');
    expect(filtered).toContain('No differences in the selected field(s): model.');
  });

  it('does not cut a surrogate pair when windowing', () => {
    // `start` is a UTF-16 index, so slicing could land between the halves of an
    // astral character (an emoji in a prompt is enough), leaving a lone
    // surrogate that renders as U+FFFD — in BOTH columns, so the mojibake looked
    // like the difference.
    const lead = 'A'.repeat(20) + '😀' + 'C'.repeat(7);
    const diff = {
      diffs: [{
        step_number: 1, field: 'input',
        left_value: { p: `${lead}1${'T'.repeat(40)}` },
        right_value: { p: `${lead}2${'T'.repeat(40)}` },
      }],
      divergence_step: 1,
      left_trace_id: 'trc_left0000', right_trace_id: 'trc_right000',
      left_step_count: 1, right_step_count: 1,
    } as unknown as TraceDiffResult;
    const out = noAnsi(renderDiff(diff, trace('l', 'completed'), trace('r', 'completed')));
    expect(out).not.toContain('\uFFFD');
  });

  it('shows the differing region of two values that share a long prefix', () => {
    // Truncating both sides from position 0 rendered a real difference as two
    // byte-identical cells under "1 difference(s) found" — the normal shape for
    // agent payloads, which share a long JSON prefix.
    const shared = 'A'.repeat(40);
    const diff = {
      diffs: [{ step_number: 1, field: 'input', left_value: { blob: `${shared}-LEFT` }, right_value: { blob: `${shared}-RIGHT` } }],
      divergence_step: 1,
      left_trace_id: 'trc_left0000', right_trace_id: 'trc_right000',
      left_step_count: 1, right_step_count: 1,
    } as unknown as TraceDiffResult;
    const out = noAnsi(renderDiff(diff, trace('l', 'completed'), trace('r', 'completed')));
    expect(out).toContain('LEFT');
    expect(out).toContain('RIGHT');
  });
});

describe('formatCostUsd — never reports real spend as zero', () => {
  it('widens past four decimals only for sub-cent amounts', () => {
    // `stats` printed "$0.0000" for a store where `show` displayed the same
    // trace as "$0.00002000": a flat toFixed(4) rounds real spend to zero.
    expect(formatCostUsd(0.00002)).toBe('$0.00002000');
    expect(formatCostUsd(0)).toBe('$0.0000');
    expect(formatCostUsd(0.1234)).toBe('$0.1234');
    expect(formatCostUsd(12.5)).toBe('$12.5000');
  });
});

describe('formatScorePct — display never contradicts the verdict', () => {
  it('shows whole percents without a decimal', () => {
    expect(formatScorePct(0.7)).toBe('70%');
    expect(formatScorePct(1)).toBe('100%');
    expect(formatScorePct(0)).toBe('0%');
    expect(formatScorePct(0.85)).toBe('85%');
  });

  it('renders a sub-threshold score below the threshold, not rounded up to it', () => {
    // The bug: `passed` derives from the 3-decimal score (0.695 < 0.7 → fail),
    // but the badge rounded 0.695 to a whole "70%" that appeared to *meet* a 70%
    // threshold. A 3-decimal score is exactly a one-decimal percent, so showing
    // it losslessly keeps display and verdict consistent.
    expect(formatScorePct(0.695)).toBe('69.5%');
    expect(formatScorePct(0.695)).not.toBe('70%');
    expect(formatScorePct(0.667)).toBe('66.7%');
    expect(formatScorePct(0.001)).toBe('0.1%');
  });

  it('evalTable shows a failing boundary score honestly next to its FAIL badge', () => {
    // 0.695 fails a 0.7 threshold; the row must read "69.5%", never "70%".
    const boundary: EvalResult = {
      id: 'e', trace_id: 't', evaluator_type: 'preset', evaluator_name: 'completeness-check',
      score: 0.695, passed: false, details: { threshold: 0.7, criteria: [] }, evaluated_at: '',
    };
    const out = noAnsi(evalTable([boundary]));
    expect(out).toContain('69.5%');
    expect(out).not.toContain('70%');
    expect(out).toContain('FAIL');
  });
});

// ── the renderer must not hide data the store holds ────────────────────────

describe('renderTimeline / renderTree fidelity', () => {
  it('renders a falsy or scalar input/output instead of dropping it', () => {
    // Regression: the output guard was a bare truthiness test and the input
    // guard was `Object.keys(...).length > 0`. Both fields hold arbitrary JSON,
    // so a step whose output was `false` or `0` — a failed check, a "not
    // found", a boolean guard result — rendered with no Output line at all,
    // indistinguishable from a step that produced nothing, while `show --json`
    // showed the value. A scalar input vanished the same way, and the two
    // guards disagreed with each other about `{}`.
    const out = noAnsi(renderTimeline([
      step({ step_type: 'tool_call', step_number: 1, name: 'false_out', input: { a: 1 }, output: false as never }),
      step({ step_type: 'tool_call', step_number: 2, name: 'zero_out', input: 42 as never, output: 0 as never }),
      step({ step_type: 'tool_call', step_number: 3, name: 'empty', input: {}, output: {} as never }),
    ]));

    expect(out).toMatch(/Output: false/);
    expect(out).toMatch(/Output: 0/);
    expect(out).toMatch(/Input: 42/);
    // An empty object still carries nothing, and now both guards agree on that.
    expect(out).not.toMatch(/Input: \{\}/);
    expect(out).not.toMatch(/Output: \{\}/);
  });

  it('shows a step error in the tree view', () => {
    // The tree is only reached when a trace HAS causal structure, so on a
    // failed trace — the case it exists for — it was hiding the failure
    // message that the default timeline prints.
    const out = noAnsi(renderTree([
      step({ step_type: 'tool_call', step_number: 1, name: 'fetch' }),
      step({ step_type: 'error', step_number: 2, name: 'boom', caused_by_step_number: 1, error: 'RATE_LIMIT: upstream rejected' }),
    ]));
    expect(out).toMatch(/caused by #1/);
    expect(out).toMatch(/RATE_LIMIT: upstream rejected/);
  });
});

/**
 * Step names, errors, models and decision text are producer output — tool
 * stderr, an HTTP error body, a sub-agent's reply. Rendered raw, an ESC sequence
 * in any of them retargets the terminal of the operator reading the run (recolor,
 * clear, or set the window title via OSC) and breaks the width math boxen uses.
 * The live event protocol already escapes a rejected line for exactly this
 * reason; these are its sibling render paths.
 */
describe('terminal control sequences in trace text', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const payload = `inj${ESC}[31mRED${ESC}[0m${ESC}]0;PWNED${BEL}`;
  const hasControls = (out: string) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(noAnsi(out));

  it('escapes them in the timeline, the tree and the header panel', () => {
    const evil = step({
      step_type: 'llm_call', name: payload, model: payload,
      error: `${ESC}[2Kboom`,
      decision: { chosen: payload, rationale: payload, confidence: null, decided_by: 'model' },
    } as Partial<TraceStep> & { step_type: StepType });

    for (const out of [
      renderTimeline([evil], { showInput: true, showOutput: true }),
      renderTree([evil]),
      traceHeaderPanel(trace({ agent_name: payload, error: `child${ESC}[31m died` })),
    ]) {
      expect(hasControls(out)).toBe(false);
      // The text itself is still shown, with the sequence made visible.
      expect(noAnsi(out)).toMatch(/\\x1b/);
    }
  });

  it('keeps a newline in a multi-line error', () => {
    const out = renderTimeline([step({ step_type: 'error', name: 'x', error: 'line one\nline two' })]);
    expect(noAnsi(out)).toContain('line two');
  });

  it('keeps CRLF line breaks (a Windows child) but escapes a lone carriage return', () => {
    // A CR that ends a line is formatting; a LONE CR returns the cursor to
    // column 0, which lets later text overwrite what was already printed.
    const crlf = noAnsi(renderTimeline([step({ step_type: 'error', name: 'x', error: 'line1\r\nline2' })]));
    expect(crlf).toContain('line2');
    expect(crlf).not.toContain('\\x0d');

    const lone = noAnsi(renderTimeline([step({ step_type: 'error', name: 'x', error: 'real\roverwrite' })]));
    expect(lone).toContain('\\x0d');
  });

  it('escapes them in list, why and diff too', () => {
    // `list` is the most-run command in the tool and was missed by the first pass.
    const rendered = noAnsi(traceTable([trace({ agent_name: payload })]));
    expect(hasControls(rendered)).toBe(false);
    expect(rendered).toMatch(/\\x1b/);
  });
});

describe('traceHeaderPanel cost precision', () => {
  it('does not render a real sub-cent cost as $0.0000', () => {
    // Regression: toFixed(4) turned anything under $0.00005 into "$0.0000" —
    // zero where real spend exists. A per-trace cost is routinely that small.
    const small = noAnsi(traceHeaderPanel(trace({ total_cost_usd: 1.23e-6 })));
    expect(small).toMatch(/\$0\.00000123/);
    expect(small).not.toMatch(/\$0\.0000\b/);
    // The ordinary case keeps its familiar 4-decimal form.
    expect(noAnsi(traceHeaderPanel(trace({ total_cost_usd: 0.1972 })))).toMatch(/\$0\.1972/);
  });
});

describe('the trace header escapes every producer field, not just some', () => {
  it('escapes agent_version, tags and session_id', () => {
    // `validateTraceInput` only checks these are strings, so an ESC/OSC sequence
    // survives `ingest` untouched and reached the terminal of whoever ran `show`
    // or `replay`: setting the window title, leaving an attribute set past the
    // command, or (a lone CR) overwriting the line it sits on. agent_name and
    // error on the same panel were already escaped.
    const panel = traceHeaderPanel({
      ...trace(),
      agent_version: '1\u001b[5m',
      tags: ['t\u001b[31mRED', 'aaa\rbbb'],
      session_id: 's\u001b]0;PWNED\u0007',
      // Held to the same "must be a string" check as the rest, so a first pass
      // that fixed the other three and left these was still injectable.
      started_at: '2026-08-17T00:00:00Z\u001b]0;TITLE\u0007',
      ended_at: '2026-08-17T00:00:01Z\u001b[5m',
      // `record`'s native protocol lets the PRODUCER choose the trace id, so it
      // is no more trustworthy than the fields beside it.
      id: 'trc_\u001b]0;PWNED_ID\u0007x',
      // `fork` copies the parent's id verbatim into this column, so it is the
      // same untrusted value under a different name — the copy three lines below
      // the field that was just escaped.
      parent_trace_id: 'trc_\u001b]0;PWNED_PARENT\u0007y',
      forked_from_step: 1,
    });
    expect(panel).not.toContain('\u001b[5m');
    expect(panel).not.toContain('\u001b[31m');
    expect(panel).not.toContain('\u001b]0;');
    expect(panel).not.toContain('\u0007');
    expect(panel).not.toMatch(/\r(?!\n)/);
    // The content is still shown, just neutralized.
    expect(panel).toContain('PWNED');
    expect(panel).toContain('TITLE');
    expect(panel).toContain('PWNED_PARENT');
    expect(panel).toContain('RED');
  });
});

describe('summaryPanel escapes its values', () => {
  it('does not echo raw control bytes from an imported session id', () => {
    // The keys are literals at every call site; the values are not. `import`
    // puts the transcript file's own session_id here, and a transcript is
    // producer output like any other — so the shared panel escapes values.
    const panel = summaryPanel('Import Summary', {
      'Trace ID': 'trc_x',
      Session: 's\u001b]0;IMPORTPWN\u0007',
      Steps: 3,
    });
    expect(panel).not.toContain('\u001b]0;');
    expect(panel).not.toContain('\u0007');
    expect(panel).toContain('IMPORTPWN');
    expect(panel).toContain('3'); // a number still renders as itself
  });
});

describe('the trace table escapes the id it renders', () => {
  it('does not echo control bytes from a producer-chosen id', () => {
    // `record`'s native protocol lets the producer choose the trace id, and
    // `list` is the most-run command in the tool. The id is truncated to 12
    // chars, which is not a defense: a short payload survives the slice intact.
    const rows = traceTable([{ ...trace(), id: 't\u001b]0;AB\u0007' }] as never);
    expect(rows).not.toContain('\u001b]0;');
    expect(rows).not.toContain('\u0007');
  });
});

describe('safeText covers C1, not only C0', () => {
  it('escapes U+009B, which terminals decode as CSI', () => {
    // The write guard already refused U+007F-U+009F; the renderer stopped at
    // U+007F, so the two disagreed about what a control character is and the
    // class stayed open through a second alphabet on any un-guarded stored
    // string (an agent name, a step name). xterm, VTE and iTerm2 read U+009B
    // as CSI.
    const out = safeText('AA\u009b31mRED\u001b[32mG');
    expect(out).not.toContain('\u009b');
    expect(out).not.toContain('\u001b');
    expect(out).toContain('\\x9b');
    // Text either side survives, and normal characters are untouched.
    expect(out).toContain('RED');
    expect(safeText('plain café 😀')).toBe('plain café 😀');
  });
});


describe('step payloads cannot address the terminal', () => {
  // JSON.stringify escapes C0 controls but NOT C1 (U+0080-U+009F), and
  // xterm/VTE/iTerm2 decode U+009B as CSI — so a tool result or model output
  // carrying one re-coloured or addressed the operator's terminal from `show`,
  // `show --tree` and `replay`. Step payloads are producer-controlled and,
  // unlike a trace id, are not constrained at the write, so escaping at render
  // is the only place this can be handled. It is applied in the shared
  // stringify helper rather than at each call site — the rule this codebase
  // arrived at after patching individual render sites four times and still
  // missing one.
  const C1 = '\u009b';

  it('escapes C1 in a step input and output, without dropping the text', () => {
    const s = step({
      step_type: 'tool_call',
      name: 'tool',
      input: { prompt: `A${C1}31mINJECT` },
      output: { text: `out${C1}5m` },
    });
    const out = renderTimeline([s], { showInput: true, showOutput: true });
    expect(out).not.toContain(C1);
    expect(out).toContain('INJECT');
    expect(out).toContain('out');
  });

  it('escapes it in the tree view too', () => {
    const s = step({ step_type: 'tool_call', name: 'tool', output: { text: `x${C1}31m` } });
    expect(renderTree([s])).not.toContain(C1);
  });
});

describe('a deeply nested tree still renders', () => {
  // The tree walk recursed one JS frame per level of nesting, so a trace whose
  // steps form a long parent chain blew the stack — measured, fine at depth
  // 4,000 and "Maximum call stack size exceeded" before 8,000. That is
  // reachable: a step's parent is the step before it in any run that threads
  // causality linearly, and `--tree` is exactly the view someone opens to
  // understand a long session. It failed with a one-line error and no tree.
  //
  // The indent was a second, quadratic limit: it grows three characters per
  // level, so a 20,000-deep chain summed to ~600 MB of leading whitespace and
  // threw "Invalid string length" while building the output.
  function chain(depth: number): TraceStep[] {
    return Array.from({ length: depth }, (_, i) => step({
      step_number: i + 1,
      step_type: 'thought',
      name: 's' + (i + 1),
      parent_step_number: i === 0 ? null : i,
    }));
  }

  it.each([1000, 8000, 20000])('renders a %i-deep chain without throwing', (depth) => {
    const out = renderTree(chain(depth));
    // Every step appears, exactly once.
    expect(out.split('\n')).toHaveLength(depth);
    expect(out).toContain('s1');
    expect(out).toContain('s' + depth);
  });

  // Past the cap the indent no longer distinguishes levels — a step at depth 60
  // draws the same 122 spaces as one at depth 41 — so the depth is stated
  // instead. Capping without this would trade a crash for a quietly wrong
  // picture of the nesting.
  it('names the depth once the indent stops growing', () => {
    const out = renderTree(chain(60));
    const lines = out.split('\n');
    // Shallow levels are drawn, not annotated.
    expect(lines[0]).not.toContain('[depth');
    expect(lines[30]).not.toContain('[depth');
    // Deep ones say where they are.
    expect(lines[44]).toContain('[depth 45]');
    expect(lines[59]).toContain('[depth 60]');
  });

  it('keeps the output linear in step count by capping the indent', () => {
    // Quadratic indent growth would make this ratio blow up; capped, it is flat.
    const small = renderTree(chain(2000)).length / 2000;
    const large = renderTree(chain(20000)).length / 20000;
    expect(large).toBeLessThan(small * 2);
  });
});


describe('a producer cannot forge a line on a single-line row', () => {
  /**
   * A trace is written by the agent under test, so every rendered string is
   * untrusted. `safeText` deliberately keeps `\n` so a rendered BLOCK holds its
   * shape — but on a one-line row a newline emits a line the renderer never
   * accounted for, and the reader has no way to tell it from real output.
   */
  const FORGED_ROW = 'safe\n  |- 99  -> Output  "NOTHING TO SEE"';
  const FORGED_OUTPUT = 'line1\nagent-replay: all checks passed';

  it('does not let a newline in a step name fabricate a second step row', () => {
    // A step NAME is single-line by construction, so the newline is escaped
    // outright: the payload stays visible and readable, on one row.
    const plain = noAnsi(renderTimeline([step({ step_type: 'tool_call', name: FORGED_ROW })]));
    expect(plain).toContain('\\x0a');
    // One step in, one step row out. The forgery's whole point was the second.
    const stepRows = plain.split('\n').filter((l) => /^\s*[┌├└]─/.test(l));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]).toContain('99'); // inline on the real row, not its own
  });

  it('draws a multi-line error inside the gutter, not at column 0', () => {
    // Errors deliberately KEEP their line breaks (a stack trace, a Windows
    // child's CRLF), so escaping is the wrong tool here. The forgery worked
    // because a continuation line was emitted raw at column 0 and so read as
    // agent-replay's own output. Keep the break, draw it in the gutter.
    const plain = noAnsi(renderTimeline([step({ step_type: 'error', name: 'boom', error: FORGED_OUTPUT })]));
    expect(plain).toContain('agent-replay: all checks passed'); // still shown
    const forged = plain.split('\n').find((l) => l.includes('agent-replay: all'))!;
    expect(forged.startsWith('agent-replay:')).toBe(false);
    expect(forged).toMatch(/^\s+/); // indented into the step's column
  });

  it('escapes a forged name in the compact tree view too', () => {
    const plain = noAnsi(renderTree([step({ step_type: 'error', name: FORGED_ROW, error: FORGED_OUTPUT })]));
    expect(plain).toContain('\\x0a');
    expect(plain.split('\n').some((l) => l.startsWith('agent-replay:'))).toBe(false);
  });

  it('still keeps newlines in a payload block, where they are content', () => {
    // The lenient path must stay lenient: a multi-line tool output is windowed
    // into its own indented block, so its shape is information, not structure.
    const plain = noAnsi(renderTimeline([step({ step_type: 'output', name: 'o', output: { text: 'aaa\nbbb' } })]));
    expect(plain).toContain('aaa');
    expect(plain).toContain('bbb');
  });

  it('safeLine differs from safeText exactly on tab and newline', () => {
    expect(safeText('a\nb\tc')).toBe('a\nb\tc');
    expect(safeLine('a\nb\tc')).toBe('a\\x0ab\\x09c');
    // Every other control character is escaped identically by both.
    const other = 'a' + String.fromCharCode(1) + 'b';
    expect(safeLine(other)).toBe(safeText(other));
  });
});


describe('one hostile trace cannot destroy the view', () => {
  it('bounds an agent name so it does not widen every row of the table', () => {
    // cli-table3 sizes a column to its WIDEST cell, so a single trace with a
    // 5,000-character agent name widened every other row to over 15,000
    // columns — the traces the user was actually looking for became unreadable
    // because of a neighbour. The dashboard already bound this at 18 chars and
    // policyTable bound its pattern at 40; the main listing did not.
    const rows = [trace({ agent_name: 'normal' }), trace({ agent_name: 'A'.repeat(5000) })];
    const widest = Math.max(...noAnsi(traceTable(rows)).split('\n').map((l) => l.length));
    expect(widest).toBeLessThan(200);
    // The normal row must still be fully legible.
    expect(noAnsi(traceTable(rows))).toContain('normal');
  });

  it('bounds a step name, which was the only unwindowed field on the row', () => {
    // Input and output are windowed; the name was not, so a 500 KB tool name
    // emitted one line of 500,031 columns and scrolled the step's real content
    // away above it.
    const out = noAnsi(renderTimeline([step({ step_type: 'tool_call', name: 'B'.repeat(200000) })]));
    expect(Math.max(...out.split('\n').map((l) => l.length))).toBeLessThan(200);
    expect(out).toContain('...'); // and says it was cut
  });

  it('bounds it in the compact tree view as well', () => {
    const out = noAnsi(renderTree([step({ step_type: 'tool_call', name: 'B'.repeat(200000) })]));
    expect(Math.max(...out.split('\n').map((l) => l.length))).toBeLessThan(200);
  });
});


describe('the timeline budgets terminal columns, not UTF-16 code units', () => {
  // `maxWidth` comes from `process.stdout.columns`, so it is a WIDTH — but the
  // truncation measured the string with `.length`. A CJK or emoji character
  // occupies two columns, so a line built to a 90-unit budget rendered about
  // 193 columns wide: it wrapped several times and broke the `│` gutter that
  // makes the timeline readable. cli-table3 and boxen already measure with
  // string-width; this renderer did its own arithmetic.
  const widest = (out: string) =>
    Math.max(...noAnsi(out).split('\n').map((l) => stringWidth(l)));

  it('keeps a wide-character payload within the requested width', () => {
    const out = renderTimeline(
      [step({ step_type: 'output', name: 'o', output: { text: '完了'.repeat(80) } })],
      { maxWidth: 100 },
    );
    // Allowing for the row prefix and gutter, which sit outside the content
    // budget. The bug produced roughly double the budget, not a few columns over.
    expect(widest(out)).toBeLessThan(120);
  });

  // Note: this one passed BEFORE the fix too, and it is kept as a guard rather
  // than as evidence. An astral emoji is a surrogate pair, so `.length` counts
  // 2 for it and its display width is also 2 — the old arithmetic was wrong in
  // a way that happened to cancel out here. CJK is the discriminating case:
  // one code unit, two columns. Keeping both documents which is which.
  it('does the same for emoji, which are also two columns wide', () => {
    const out = renderTimeline(
      [step({ step_type: 'output', name: 'o', output: { text: '😀'.repeat(200) } })],
      { maxWidth: 100 },
    );
    expect(widest(out)).toBeLessThan(120);
  });

  it('leaves narrow text alone, so the common case is unchanged', () => {
    const out = renderTimeline(
      [step({ step_type: 'output', name: 'o', output: { text: 'short and plain' } })],
      { maxWidth: 100 },
    );
    expect(noAnsi(out)).toContain('short and plain');
  });
});


describe('panels degrade rather than crash at an absurd terminal width', () => {
  // boxen reads `process.stdout.columns` itself and subtracts its border width,
  // so at a reported width of 1 or 2 it computes a negative count and throws
  // `RangeError: Invalid count value: -1` out of `String.repeat` — taking down
  // `show`, `init`, `ingest` and `replay` with an uncaught exception from a
  // purely cosmetic concern. `process.stdout.columns` is whatever the
  // environment reports, not necessarily a real terminal width.
  function atWidth<T>(cols: number, f: () => T): T {
    const prev = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    try {
      return f();
    } finally {
      if (prev) Object.defineProperty(process.stdout, 'columns', prev);
      else delete (process.stdout as unknown as Record<string, unknown>).columns;
    }
  }

  const t = trace({ agent_name: 'a' });

  it.each([[1], [2], [3]])('renders the header panel at %i columns', (cols) => {
    const out = atWidth(cols, () => traceHeaderPanel(t));
    // The content is what the user came for; the border is decoration.
    expect(noAnsi(out)).toContain('a');
  });

  it.each([[1], [2]])('renders the summary panel at %i columns', (cols) => {
    expect(noAnsi(atWidth(cols, () => summaryPanel('T', { Traces: 1 })))).toContain('Traces');
  });

  it('still draws a real box once there is room for one', () => {
    // The fallback must not become the normal path.
    expect(atWidth(80, () => summaryPanel('T', { Traces: 1 }))).toContain('╭');
  });
});


describe('table and diff cells are budgeted in columns too', () => {
  // Three copies of `truncate` existed: json.ts's, table.ts's and
  // diff-renderer's. All three measured UTF-16 code units against what is a
  // COLUMN budget (`colWidths`), so a CJK cell rendered about twice its
  // allotted width and pushed the border out. table.ts's copy was additionally
  // not surrogate-safe, so it could cut an emoji in half — the very defect the
  // diff renderer had already been fixed for, in a sibling file.
  const cellWidth = (out: string, marker: string) => {
    const line = noAnsi(out).split('\n').find((l) => l.includes(marker))!;
    return stringWidth(line);
  };

  it('does not let a CJK agent name overflow its column', () => {
    const wide = noAnsi(traceTable([trace({ agent_name: '完了'.repeat(60) })]));
    const plain = noAnsi(traceTable([trace({ agent_name: 'a'.repeat(120) })]));
    const widest = (t: string) => Math.max(...t.split('\n').map((l) => stringWidth(l)));
    // The CJK row must not be dramatically wider than the ASCII one; before,
    // the same 40-unit budget bought 80 columns.
    expect(widest(wide)).toBeLessThanOrEqual(widest(plain) + 4);
  });

  it('never leaves a lone surrogate in a table cell', () => {
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let n = 30; n <= 60; n++) {
      const out = traceTable([trace({ agent_name: 'a'.repeat(n % 7) + '😀'.repeat(40) })]);
      expect(LONE.test(out), `n=${n}`).toBe(false);
    }
  });

  it('leaves a short ASCII name untouched, so the common case is unchanged', () => {
    expect(noAnsi(traceTable([trace({ agent_name: 'travel-bot' })]))).toContain('travel-bot');
  });
});


describe('the eval Details column never claims a criterion passed when it scored nothing', () => {
  const row = (threshold: number, score: number): EvalResult => ({
    id: 'e1', trace_id: 't1', evaluator_name: 'r', evaluator_type: 'rubric',
    score, passed: score >= threshold, details: { threshold, criteria: [{ name: 'needs_source', score }] },
    evaluated_at: '',
  });

  it('names the criterion when the rubric threshold is 0', () => {
    // `score < threshold` cannot express "did not pass" when the threshold is
    // 0, since nothing is below it — so a rubric written with `threshold: 0`
    // reported "All criteria passed" at 0% with every criterion having failed.
    // That is the same false summary this line was first written to fix for a
    // hardcoded 0.7, reappearing at the other end of the range.
    const out = noAnsi(evalTable([row(0, 0)]));
    expect(out).toContain('needs_source');
    expect(out).not.toContain('All criteria passed');
  });

  it('still says so when the criteria genuinely passed', () => {
    expect(noAnsi(evalTable([row(0.7, 1)]))).toContain('All criteria passed');
  });

  it('still names a criterion below an ordinary threshold', () => {
    const out = noAnsi(evalTable([row(0.7, 0.4)]));
    expect(out).toContain('needs_source');
    expect(out).not.toContain('All criteria passed');
  });
});
