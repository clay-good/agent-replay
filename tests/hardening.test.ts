import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import {
  startTrace,
  appendStep,
  attachDecision,
  attachSnapshot,
  getStepSnapshot,
  getTrace,
} from '../src/services/trace-service.js';
import { validateEvent } from '../src/services/event-protocol.js';
import { applyEvent } from '../src/services/recorder.js';
import { mapOtlpTraces } from '../src/services/otel/semconv.js';
import { applyHookPayload } from '../src/services/hook-adapter.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => db.close());

// ── Bug 1: decision decided_by never crashes the CHECK constraint ──────────

describe('decision robustness', () => {
  it('coerces an out-of-enum decided_by to "agent" instead of crashing', () => {
    const t = startTrace(db, { agent_name: 'a' });
    appendStep(db, t.id, { step_number: 1, step_type: 'decision', name: 'd' });
    // 'llm' is not in the CHECK enum — must not throw, and must not wipe the row.
    expect(() => attachDecision(db, t.id, 1, { chosen: 'x', decided_by: 'llm' })).not.toThrow();
    const step = getTrace(db, t.id)!.steps[0];
    expect(step.decision!.decided_by).toBe('agent');
    expect(step.decision!.chosen).toBe('x');
  });

  it('re-attaching a valid decision replaces the old one atomically', () => {
    const t = startTrace(db, { agent_name: 'a' });
    appendStep(db, t.id, { step_number: 1, step_type: 'decision', name: 'd' });
    attachDecision(db, t.id, 1, { chosen: 'first', decided_by: 'agent' });
    attachDecision(db, t.id, 1, { chosen: 'second', decided_by: 'user' });
    const step = getTrace(db, t.id)!.steps[0];
    expect(step.decision!.chosen).toBe('second');
    expect(step.decision!.decided_by).toBe('user');
  });

  it('event protocol skips an event with an invalid step_type', () => {
    const { event, warning } = validateEvent({ v: 1, type: 'step', trace_id: 't', step_number: 1, step_type: 'nonsense', name: 'x' });
    expect(event).toBeNull();
    expect(warning).toMatch(/invalid step_type/);
  });

  it('a decision applyEvent with a bad decided_by is stored coerced, not crashed', () => {
    applyEvent(db, { v: 1, type: 'trace_start', trace_id: 't1', agent_name: 'a' });
    applyEvent(db, { v: 1, type: 'step_start', trace_id: 't1', step_number: 1, step_type: 'decision', name: 'd' });
    expect(() => applyEvent(db, { v: 1, type: 'decision', trace_id: 't1', step_number: 1, chosen: 'go', decided_by: 'robot' } as never)).not.toThrow();
    expect(getTrace(db, 't1')!.steps[0].decision!.decided_by).toBe('agent');
  });
});

// ── Bug 2: nested OTel agent roots are preserved, not dropped ──────────────

describe('OTel nested agent roots', () => {
  function attr(key: string, value: string) {
    return { key, value: { stringValue: value } };
  }
  function span(traceId: string, spanId: string, parent: string | undefined, name: string, op: string) {
    return {
      traceId, spanId, parentSpanId: parent, name,
      startTimeUnixNano: '1000000', endTimeUnixNano: '2000000',
      attributes: [attr('gen_ai.operation.name', op)],
    };
  }

  it('keeps a nested invoke_agent as a step and preserves child parentage', () => {
    const payload = {
      resourceSpans: [{
        resource: { attributes: [] },
        scopeSpans: [{
          spans: [
            span('t', 'A', undefined, 'outer', 'invoke_agent'),
            span('t', 'B', 'A', 'inner', 'invoke_agent'),
            span('t', 'C', 'B', 'tool', 'execute_tool'),
          ],
        }],
      }],
    };
    const [trace] = mapOtlpTraces(payload);
    // A is the identity root; B (nested agent) and C (tool) are both steps.
    expect(trace.steps).toHaveLength(2);
    const inner = trace.steps!.find((s) => s.name === 'inner')!;
    const tool = trace.steps!.find((s) => s.name === 'tool')!;
    expect(inner).toBeTruthy(); // nested agent not dropped
    expect(tool.parent_step).toBe(inner.step_number); // child still linked
  });
});

// ── Bug 3: snapshot context_window with raw non-JSON text does not crash ───

describe('snapshot read robustness', () => {
  it('returns a non-JSON context_window verbatim instead of throwing', () => {
    const t = startTrace(db, { agent_name: 'a' });
    appendStep(db, t.id, { step_number: 1, step_type: 'thought', name: 's' });
    attachSnapshot(db, t.id, 1, { context_window: 'raw unparseable text', token_count: 5 });
    let snap;
    expect(() => { snap = getStepSnapshot(db, t.id, 1); }).not.toThrow();
    expect(snap!.context_window).toBe('raw unparseable text');
    expect(snap!.token_count).toBe(5);
  });
});

// ── Bug 4: sequential hook tool calls keep distinct step numbers ───────────

describe('hook step numbering', () => {
  it('assigns distinct step numbers to successive tool calls (no loss)', () => {
    const s = 'sess-seq';
    applyHookPayload(db, { hook_event_name: 'UserPromptSubmit', session_id: s, prompt: 'go' });
    for (const name of ['A', 'B', 'C']) {
      applyHookPayload(db, { hook_event_name: 'PreToolUse', session_id: s, tool_name: name, tool_input: {} });
    }
    const traceId = (db.prepare('SELECT id FROM agent_traces WHERE session_id = ?').get(s) as { id: string }).id;
    const trace = getTrace(db, traceId)!;
    const nums = trace.steps.filter((st) => st.step_type === 'tool_call').map((st) => st.step_number);
    expect(nums).toHaveLength(3);
    expect(new Set(nums).size).toBe(3); // all distinct, none lost
  });
});
