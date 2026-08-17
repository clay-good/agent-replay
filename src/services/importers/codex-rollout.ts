import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { ingestTrace } from '../trace-service.js';
import type { IngestTraceInput, IngestStepInput, Trace } from '../../models/types.js';
import type { ImportReport } from './claude-transcript.js';

/**
 * Best-effort importer for OpenAI Codex CLI rollout JSONL
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * The format is internal and version-unstable, so parsing is defensive:
 * `session_meta` → trace identity + git metadata; `response_item` records
 * mirroring the Responses API (`function_call`/`function_call_output` paired by
 * `call_id` → tool_call steps; `reasoning` → thought; `message` → input/output);
 * `compacted` → metadata. Unrecognized records are skipped and counted, and the
 * source format/version is stamped in trace metadata.
 */

/** Mirrors the claude-transcript importer: `{prompt: ''}` is truthy, so an
 *  empty first user record must not count as the captured input. */
function hasPrompt(input: Record<string, unknown> | undefined): boolean {
  return typeof input?.prompt === 'string' && input.prompt.trim().length > 0;
}

const SOURCE_FORMAT = 'codex-rollout';
const SOURCE_VERSION = '2025-07';

/** Unwrap the item carried by a record, tolerating `payload`/`item`/flat shapes. */
function itemOf(rec: Record<string, unknown>): Record<string, unknown> {
  return (rec.payload as Record<string, unknown>) ?? (rec.item as Record<string, unknown>) ?? rec;
}

function recordType(rec: Record<string, unknown>): string {
  const top = String(rec.type ?? rec.record_type ?? '');
  // `response_item` wraps the real item; use the inner type for those.
  if (top === 'response_item' || top === '') return String(itemOf(rec).type ?? top);
  return top;
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : { arguments: args };
    } catch {
      return { arguments: args };
    }
  }
  return {};
}

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? '')).filter(Boolean).join('\n');
  }
  return '';
}

export function importCodexRollout(
  db: Database.Database,
  filePath: string,
  opts: { tags?: string[] } = {},
): ImportReport {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  const records: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    // A line that parses to a non-object is not a record. `null` in particular
    // used to be pushed and then dereferenced unguarded in the first pass, so
    // ONE such line threw and aborted the whole import — nothing kept from a
    // large rollout, against the documented best-effort contract.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped++;
      continue;
    }
    records.push(parsed as Record<string, unknown>);
  }

  // First pass: index function_call_output by call_id.
  const outputs = new Map<string, unknown>();
  for (const rec of records) {
    const it = itemOf(rec);
    if (String(it.type) === 'function_call_output' && it.call_id != null) {
      outputs.set(String(it.call_id), it.output);
    }
  }

  let sessionId: string | undefined;
  let agentName = 'codex';
  let input: Record<string, unknown> | undefined;
  let lastAssistantText = '';
  let startedAt: string | undefined;
  let imported = 0;
  const metadata: Record<string, unknown> = { source_format: SOURCE_FORMAT, source_version: SOURCE_VERSION };
  const steps: IngestStepInput[] = [];
  let stepNumber = 1;

  for (const rec of records) {
    const type = recordType(rec);
    const it = itemOf(rec);
    let contributed = false;

    switch (type) {
      case 'session_meta': {
        sessionId = str(it.id) ?? str(it.session_id) ?? sessionId;
        startedAt = str(it.timestamp) ?? startedAt;
        if (it.cwd != null) metadata.cwd = it.cwd;
        if (it.git != null) metadata.git = it.git;
        contributed = true;
        break;
      }
      case 'function_call': {
        // Coerce like the first pass (outputs.set(String(call_id))) so a
        // non-string call_id still pairs with its function_call_output.
        const callId = it.call_id != null ? String(it.call_id) : undefined;
        const result = callId ? outputs.get(callId) : undefined;
        steps.push({
          step_number: stepNumber++,
          step_type: 'tool_call',
          name: str(it.name) ?? 'tool',
          input: parseArgs(it.arguments),
          output: result !== undefined ? { output: result } : null,
          metadata: { call_id: callId },
        });
        contributed = true;
        break;
      }
      case 'function_call_output':
        // indexed in the first pass
        contributed = true;
        break;
      case 'reasoning': {
        steps.push({
          step_number: stepNumber++,
          step_type: 'thought',
          name: 'reasoning',
          // Fall back with `||`, not `??`: the Responses API serializes a
          // reasoning item with no summary as `summary: []` (present but empty),
          // which is not nullish, so `??` would keep the empty summary and drop
          // the real text carried in `content`. Treat an empty asText result
          // ("" from `[]` or a blank string) as absent.
          output: { text: asText(it.summary) || asText(it.content) || asText(it.text) },
        });
        contributed = true;
        break;
      }
      case 'message': {
        const role = str(it.role);
        // `||` for the same reason as the reasoning case above: an empty
        // `content: []` is not nullish, so `??` would drop text carried in `text`.
        const text = asText(it.content) || asText(it.text);
        // `!input` alone treated an EMPTY first user record as "input
        // captured", because `{prompt: ''}` is truthy — so the next, REAL
        // prompt fell to the follow-up branch and was discarded, leaving the
        // trace with no question at all, and counted the empty record as
        // imported. Same defect, same shape, as the one already fixed in both
        // branches of the claude-transcript importer; this sibling was missed.
        if (role === 'user' && !hasPrompt(input)) {
          input = { prompt: text };
          contributed = text.trim().length > 0;
        } else if (role === 'assistant' && text) {
          lastAssistantText = text;
          steps.push({ step_number: stepNumber++, step_type: 'output', name: 'assistant_message', output: { text } });
          contributed = true;
        } else {
          // A follow-up user turn (input already set) or an empty message has no
          // home in the current model — there is no 'user' step type, so the
          // initial prompt is trace.input and only agent actions become steps
          // (same as the claude-transcript importer). Count it as skipped:
          // previously it was marked imported while nothing was retained,
          // inflating "Records imported" and breaking imported + skipped = records.
          skipped++;
        }
        break;
      }
      case 'compacted': {
        metadata.compacted = true;
        contributed = true;
        break;
      }
      default:
        skipped++;
        break;
    }

    if (contributed) imported++;
  }

  // A file that yielded no steps AND no prompt has nothing of the session in
  // it — only, at most, a session id from a header record. Creating a trace for
  // that produced an empty row and a green exit, so `import X && use-trace`
  // proceeded against content-free data; the command's own comment already says
  // producing no trace should be a failed import. Keying this on `sessionId`
  // alone let the empty case through, because a header record supplies the id.
  // A file that captured a prompt but no steps still imports — the prompt is
  // real content worth keeping.
  // `hasPrompt`, not `!input` — same reason as the claude-transcript importer:
  // `{prompt: ''}` from an empty first user record is truthy, so a file that
  // captured nothing still produced a trace and exited 0.
  if (steps.length === 0 && !hasPrompt(input)) {
    return { trace: null as Trace | null, imported, skipped, steps: 0 };
  }

  const traceInput: IngestTraceInput = {
    agent_name: agentName,
    trigger: 'user_message',
    status: 'completed',
    session_id: sessionId ?? null,
    input: input ?? {},
    output: lastAssistantText ? { text: lastAssistantText } : null,
    started_at: startedAt,
    tags: opts.tags,
    metadata,
    steps,
  };

  const trace = ingestTrace(db, traceInput);
  return { trace, imported, skipped, steps: steps.length };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
