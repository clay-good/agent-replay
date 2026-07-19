import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { ensureDatabase, resetConnection } from '../src/db/index.js';
import {
  startTrace,
  appendStep,
  attachDecision,
  attachSnapshot,
  getStepSnapshot,
  getTrace,
  ingestTrace,
} from '../src/services/trace-service.js';
import { validateEvent } from '../src/services/event-protocol.js';
import { applyEvent } from '../src/services/recorder.js';
import { mapOtlpTraces } from '../src/services/otel/semconv.js';
import { applyHookPayload } from '../src/services/hook-adapter.js';
import { renderTree, renderTimeline } from '../src/ui/timeline.js';
import { traceHeaderPanel } from '../src/ui/boxen-panels.js';
import type { Trace } from '../src/models/types.js';
import { validateTraceInput } from '../src/utils/validators.js';
import type { TraceStep } from '../src/models/types.js';
import type { StepType } from '../src/models/enums.js';

function step(over: Partial<TraceStep> & { step_number: number }): TraceStep {
  return {
    id: '', trace_id: '', step_type: 'thought' as StepType, name: `s${over.step_number}`,
    input: {}, output: null, started_at: '', ended_at: null, duration_ms: null,
    tokens_used: null, model: null, error: null, metadata: {},
    parent_step_number: null, caused_by_step_number: null, ...over,
  };
}
const noAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

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

// ── renderTree never drops steps in a parent cycle / self-loop ─────────────

describe('renderTree cycle safety', () => {
  it('renders every step even when parents form a 2-cycle', () => {
    // step 1's parent is 2 and step 2's parent is 1 — no resolvable root.
    const out = noAnsi(renderTree([
      step({ step_number: 1, name: 'alpha', parent_step_number: 2 }),
      step({ step_number: 2, name: 'beta', parent_step_number: 1 }),
    ]));
    expect(out).toContain('"alpha"');
    expect(out).toContain('"beta"');
  });

  it('renders a self-parented step exactly once', () => {
    const out = noAnsi(renderTree([
      step({ step_number: 1, name: 'solo', parent_step_number: 1 }),
      step({ step_number: 2, name: 'child', parent_step_number: 1 }),
    ]));
    expect(out).toContain('"solo"');
    expect(out).toContain('"child"');
    expect(out.match(/"solo"/g)).toHaveLength(1); // not duplicated by the cycle guard
  });

  it('still nests a normal hierarchy correctly', () => {
    const out = noAnsi(renderTree([
      step({ step_number: 1, name: 'root' }),
      step({ step_number: 2, name: 'kid', parent_step_number: 1 }),
    ]));
    const rootLine = out.split('\n').find((l) => l.includes('"root"'))!;
    const kidLine = out.split('\n').find((l) => l.includes('"kid"'))!;
    expect(kidLine.indexOf('#2')).toBeGreaterThan(rootLine.indexOf('#1')); // kid indented deeper
  });

  it('reports no steps for an empty trace', () => {
    expect(noAnsi(renderTree([]))).toContain('No steps recorded');
  });

  it('falls back to the flat timeline when no step declares a parent (spec scenario)', () => {
    const out = noAnsi(renderTree([
      step({ step_number: 1, name: 'one' }),
      step({ step_number: 2, name: 'two' }),
    ]));
    expect(out).toContain('"one"');
    expect(out).toContain('"two"');
    // Flat fallback goes through renderTimeline, whose first-step connector is ┌;
    // tree mode uses a #N prefix and never emits ┌.
    expect(out).toContain('┌');
    expect(out).not.toContain('#1');
  });
});

// ── Export → re-ingest round-trip preserves hierarchy/causality (spec 3.3) ──

describe('ingest accepts the model-shaped _number aliases', () => {
  it('re-ingesting an exported trace keeps parent/causal links', () => {
    // getTrace / export emit parent_step_number & caused_by_step_number; ingest
    // must accept those (not only the short parent_step/caused_by_step) so a
    // show --json / export round-trips.
    const t = ingestTrace(db, {
      agent_name: 'roundtrip',
      status: 'completed',
      steps: [
        { step_number: 1, step_type: 'decision', name: 'd', decision: { chosen: 'A', decided_by: 'agent' } },
        { step_number: 2, step_type: 'tool_call', name: 't', parent_step_number: 1, caused_by_step_number: 1 },
      ],
    });
    const s2 = getTrace(db, t.id)!.steps[1];
    expect(s2.parent_step_number).toBe(1);
    expect(s2.caused_by_step_number).toBe(1);
  });

  it('still rejects a forward/self reference via the _number alias', () => {
    const r = validateTraceInput({
      agent_name: 'x',
      steps: [{ step_number: 1, step_type: 'thought', name: 'a', parent_step_number: 1 }],
    });
    expect(r.valid).toBe(false); // self-parent rejected regardless of field name
  });
});

// ── Cyclic references are rejected at the ingest validation layer ───────────

describe('reference validation is wired into ingest', () => {
  it('rejects a trace whose steps form a parent cycle', () => {
    const r = validateTraceInput({
      agent_name: 'x',
      steps: [
        { step_number: 1, step_type: 'thought', name: 'a', parent_step: 2 },
        { step_number: 2, step_type: 'thought', name: 'b', parent_step: 1 },
      ],
    });
    expect(r.valid).toBe(false);
  });
});

// ── Default `show` surfaces v2 data (session + decision records) ───────────

describe('default show view exposes v2 fields', () => {
  it('renderTimeline shows a decision step\'s chosen option and rationale', () => {
    const s = step({ step_number: 1, step_type: 'decision' as StepType, name: 'pick' });
    s.decision = { id: 'd', step_id: '', options: [], chosen: 'A', rationale: 'A is faster', confidence: 0.9, decided_by: 'agent' };
    const out = noAnsi(renderTimeline([s]));
    expect(out).toContain('Chose:');
    expect(out).toContain('A');
    expect(out).toContain('A is faster');
  });

  it('traceHeaderPanel shows the session_id when present', () => {
    const trace: Trace = {
      id: 'trc_1', agent_name: 'bot', agent_version: null, trigger: 'manual', status: 'completed',
      input: {}, output: null, started_at: '2026-01-01T00:00:00Z', ended_at: null,
      total_duration_ms: null, total_tokens: null, total_cost_usd: null, error: null,
      tags: [], metadata: {}, parent_trace_id: null, forked_from_step: null,
      session_id: 'sess_abc', created_at: '2026-01-01T00:00:00Z',
    };
    expect(noAnsi(traceHeaderPanel(trace))).toContain('sess_abc');
  });

  it('omits the session line when there is no session', () => {
    const trace: Trace = {
      id: 'trc_2', agent_name: 'bot', agent_version: null, trigger: 'manual', status: 'completed',
      input: {}, output: null, started_at: '2026-01-01T00:00:00Z', ended_at: null,
      total_duration_ms: null, total_tokens: null, total_cost_usd: null, error: null,
      tags: [], metadata: {}, parent_trace_id: null, forked_from_step: null,
      session_id: null, created_at: '2026-01-01T00:00:00Z',
    };
    expect(noAnsi(traceHeaderPanel(trace))).not.toContain('Session:');
  });
});

// ── The local data directory is owner-only (privacy / secrets on disk) ─────

describe('data directory permissions', () => {
  it('creates the .agent-replay directory owner-only (0700)', () => {
    if (process.platform === 'win32') return; // POSIX permissions only
    const root = mkdtempSync(join(tmpdir(), 'ar-perm-'));
    const dataDir = join(root, '.agent-replay');
    try {
      const d = ensureDatabase(join(dataDir, 'traces.db'));
      d.prepare('SELECT 1').get(); // usable by the owner
      expect(statSync(dataDir).mode & 0o777).toBe(0o700); // no group/world access
    } finally {
      resetConnection();
      rmSync(root, { recursive: true, force: true });
    }
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
