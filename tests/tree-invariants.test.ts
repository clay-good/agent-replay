/**
 * Tree-walk invariants over pathological parent graphs.
 *
 * The walk was made ITERATIVE (an explicit stack) because recursion blew the
 * stack on a deep parent chain. The property that must survive that change is
 * simple and total: every step is rendered exactly once, and the line count
 * equals the step count — whatever the parent pointers do. A cycle, a
 * self-parent, a parent that does not exist, and step numbers out of order are
 * all reachable if a producer bypassed validation, and the old recursive version
 * satisfied this too (verified by running these same shapes against it).
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { renderTree } from '../src/ui/timeline.js';
import type { TraceStep } from '../src/models/types.js';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function mk(n: number, parent: number | null): TraceStep {
  return {
    id: 'i' + n, trace_id: 't', step_number: n, step_type: 'thought', name: 's' + n,
    input: {}, output: null, model: null, error: null, started_at: '2026-08-18T10:00:00Z',
    ended_at: null, duration_ms: null, tokens_used: null, parent_step_number: parent,
    caused_by_step_number: null, metadata: {},
  } as unknown as TraceStep;
}

function invariants(steps: TraceStep[], label: string): string[] {
  const out = renderTree(steps).replace(ANSI, '');
  const lines = out.split('\n').filter((l) => l.trim());
  const bad: string[] = [];
  for (const s of steps) {
    const hits = lines.filter((l) => new RegExp('"s' + s.step_number + '"').test(l)).length;
    if (hits !== 1) bad.push(label + ': step ' + s.step_number + ' appeared ' + hits + ' times');
  }
  if (lines.length !== steps.length) bad.push(label + ': ' + lines.length + ' lines for ' + steps.length + ' steps');
  return bad;
}

describe('tree walk invariants on pathological parent graphs', () => {
  it('renders every step exactly once', () => {
    const shapes: Array<[string, TraceStep[]]> = [
      ['multiple roots', [mk(1, null), mk(2, null), mk(3, 1), mk(4, 2)]],
      ['missing parent', [mk(1, 99), mk(2, 1)]],
      ['self parent', [mk(1, 1), mk(2, null)]],
      ['two cycle', [mk(1, 2), mk(2, 1)]],
      ['three cycle', [mk(1, 3), mk(2, 1), mk(3, 2)]],
      ['cycle plus root', [mk(1, null), mk(2, 3), mk(3, 2)]],
      ['out of order numbers', [mk(5, null), mk(3, 5), mk(9, 3), mk(1, 9)]],
      ['deep chain', Array.from({ length: 300 }, (_, i) => mk(i + 1, i === 0 ? null : i))],
      ['wide fan', [mk(1, null), ...Array.from({ length: 200 }, (_, i) => mk(i + 2, 1))]],
      ['all orphaned to a cycle', [mk(1, 2), mk(2, 3), mk(3, 1), mk(4, 1)]],
    ];
    const failures: string[] = [];
    for (const [label, steps] of shapes) failures.push(...invariants(steps, label));
    writeFileSync('/tmp/treefuzz-out.txt', failures.join('\n') || 'ALL SHAPES OK');
    expect(failures).toEqual([]);
  });
});
