import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { ingestTrace } from '../trace-service.js';
import { selectPrompt } from './user-turns.js';
import type { IngestTraceInput, IngestStepInput, Trace } from '../../models/types.js';
import type { ImportReport } from './claude-transcript.js';

/**
 * Best-effort importer for OpenAI Codex CLI rollout JSONL
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * The format is internal and version-unstable, so parsing is defensive:
 * `session_meta` → trace identity + git metadata; `response_item` records
 * mirroring the Responses API (`function_call`/`function_call_output` AND
 * `custom_tool_call`/`custom_tool_call_output`, each paired by `call_id` →
 * tool_call steps; `reasoning` → thought; `message` → input/output);
 * `token_count` → trace totals; `compacted` → metadata. Unrecognized records are
 * skipped and counted, and the source format/version is stamped in trace
 * metadata.
 *
 * The two tool-call families are handled by ONE branch each, never a copy: the
 * freeform `custom_tool_call` (the `exec`/apply-patch tools) carries the same
 * call_id pairing and is by far the more common of the two in practice —
 * measured across 40 recent rollouts, 194 custom vs 25 function. Handling only
 * `function_call` therefore dropped roughly nine tenths of everything the agent
 * actually did, silently, into the skipped count.
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
  // `response_item` and `event_msg` both wrap the real item; use the inner type
  // for those. `event_msg` is the more common wrapper in real rollouts (7,471
  // records against 4,351 across 60 sessions here) and was not unwrapped, so
  // every record it carries — including the `token_count` totals — was matched
  // against the literal string "event_msg" and skipped. Unwrapping is safe
  // because no inner type of an event_msg collides with a handled one: they are
  // token_count, agent_message, task_started/complete, user_message,
  // thread_settings_applied, agent_reasoning, patch_apply_end and friends, none
  // of which is `message`, `reasoning`, `function_call` or `custom_tool_call`.
  // So this changes exactly one thing: token totals are now read.
  if (top === 'response_item' || top === 'event_msg' || top === '') return String(itemOf(rec).type ?? top);
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

  // First pass: index tool outputs by call_id. Both output families are indexed
  // here — a `custom_tool_call` pairs with a `custom_tool_call_output` exactly
  // as a `function_call` pairs with a `function_call_output`.
  const outputs = new Map<string, unknown>();
  for (const rec of records) {
    const it = itemOf(rec);
    const t = String(it.type);
    if ((t === 'function_call_output' || t === 'custom_tool_call_output') && it.call_id != null) {
      outputs.set(String(it.call_id), it.output);
    }
  }

  let sessionId: string | undefined;
  let agentName = 'codex';
  let input: Record<string, unknown> | undefined;
  /** Every user turn, in order; split into prompt + follow-ups after the loop. */
  const userTurns: string[] = [];
  let lastAssistantText = '';
  let startedAt: string | undefined;
  let totalTokens: number | undefined;
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
      case 'function_call':
      case 'custom_tool_call': {
        // Coerce like the first pass (outputs.set(String(call_id))) so a
        // non-string call_id still pairs with its output record.
        const callId = it.call_id != null ? String(it.call_id) : undefined;
        const result = callId ? outputs.get(callId) : undefined;
        // A function_call carries JSON `arguments`; a custom_tool_call carries a
        // freeform `input` string. parseArgs already handles both a JSON string
        // and an unparseable one (kept verbatim under `arguments`), so the two
        // shapes need one expression, not two branches that can drift apart.
        const failure = toolFailure(result);
        steps.push({
          step_number: stepNumber++,
          step_type: 'tool_call',
          name: str(it.name) ?? 'tool',
          input: parseArgs(it.arguments ?? it.input),
          output: result !== undefined ? { output: result } : null,
          // A failed tool must be recorded as failed. Left null, an imported
          // trace read as a clean run to `hallucination-check`'s no_error_steps
          // criterion, `completeness-check`, and `check --golden`'s step_errors
          // baseline — a fail-open on exactly the traces this tool exists to
          // audit. The sibling claude-transcript importer already did this.
          ...(failure ? { error: failure } : {}),
          metadata: { call_id: callId },
        });
        contributed = true;
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        // indexed in the first pass
        contributed = true;
        break;
      case 'token_count': {
        // `info.total_token_usage` is CUMULATIVE for the session (verified
        // monotonic across real rollouts), so the last record is the total and
        // summing them is wrong — on a real 82-record session, summing reported
        // 214,648,081 tokens against an actual 6,267,854, a 34x over-count.
        const usage = (it.info as { total_token_usage?: Record<string, unknown> } | undefined)?.total_token_usage;
        const t = usage != null ? num(usage.total_tokens) : undefined;
        if (t != null) totalTokens = t;
        contributed = true;
        break;
      }
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
        if (role === 'user') {
          // Every user turn is retained (prompt or follow-up), through the same
          // rule the claude-transcript importer uses — the stored prompt here
          // was otherwise the injected instructions preamble while the user's
          // real question, one of ~25 turns, was dropped entirely.
          userTurns.push(text);
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
  const selected = selectPrompt(userTurns);
  input = selected.input;
  if (selected.followUps.length > 0) metadata.follow_up_prompts = selected.followUps;

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
    total_tokens: totalTokens ?? null,
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

/** A finite number, however the producer spelled it; anything else is absent. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Failure text for a paired tool output, or undefined when it succeeded.
 *
 * Read GENEROUSLY, in the same direction the hook path reads `is_error`: for a
 * failure FLAG, missing a signal is the expensive mistake (a failed call stored
 * clean is a false-green gate), while over-reading one only makes a failure
 * more visible. So an explicit `success: false`, a non-zero `exit_code`, or an
 * `error` field all count. An exit code that does not parse is NOT read as a
 * failure — fabricating one is the mistake that costs more in that direction.
 */
function toolFailure(result: unknown): string | undefined {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  const meta = (r.metadata && typeof r.metadata === 'object' ? r.metadata : {}) as Record<string, unknown>;
  const code = num(meta.exit_code ?? r.exit_code);
  if (code != null && code !== 0) return `exited with code ${code}`;
  if (r.success === false || r.success === 'false') return asText(r.output) || 'tool reported failure';
  const err = r.error ?? meta.error;
  if (err != null) {
    const text = typeof err === 'string' ? err : asText(err) || JSON.stringify(err);
    return text || 'error';
  }
  return undefined;
}
