import type Database from 'better-sqlite3';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { ingestTrace } from '../trace-service.js';
import type { IngestTraceInput, IngestStepInput, Trace } from '../../models/types.js';

/**
 * Best-effort importer for Claude Code transcript JSONL
 * (`~/.claude/projects/<project>/<session-uuid>.jsonl`).
 *
 * The format is internal and version-unstable, so parsing is defensive:
 * unparseable lines and unrecognized record types are skipped and counted, and
 * the source format/version is stamped in trace metadata. Recognized shapes:
 * `user`/`assistant`/`system` records with a `message.content` that is a string
 * or an array of `text` / `thinking` / `tool_use` / `tool_result` blocks;
 * tool_use↔tool_result paired by `tool_use_id`; `usage` token counts aggregated.
 */

const SOURCE_FORMAT = 'claude-transcript';
const SOURCE_VERSION = '2025-07';

export interface ImportReport {
  trace: Trace | null;
  imported: number;
  skipped: number;
  steps: number;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * A finite number from a vendor value, or 0 — never a string to concatenate.
 *
 * `usage` is only *cast* to numbers; JSON gives whatever the file says. A
 * producer sending `"100"` made `0 + "100" + 20` concatenate to `"010020"`,
 * which `numOrNull` then happily stores as 10,020 tokens instead of 120. The
 * poisoning is sticky: once one record's usage is a string, every later `+=`
 * concatenates too. The Codex *stream* translator was hardened against exactly
 * this; the importers were missed.
 */
function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  // Clamp at zero: a negative usage count is not a token total, and it survived
  // import only to be REJECTED on the way back in — `ingest` requires a
  // non-negative total, so an export of such a trace could not be restored.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A tool step's name, coerced.
 *
 * `Block.name` is typed `string | undefined` but comes straight from
 * `JSON.parse`, and it was bound raw into a `TEXT NOT NULL` column — unlike
 * every scalar beside it in the same insert, which is coerced precisely so one
 * bad field can't cost the run. A single `{"type":"tool_use","name":{...}}`
 * block anywhere in a 50,000-record transcript made better-sqlite3 refuse the
 * bind, which threw out of the whole import: exit 1, nothing kept, in flat
 * contradiction of this importer's documented best-effort contract. An empty
 * name also produced a row `ingest` would reject (validateStepInput requires
 * one), breaking the export → ingest round-trip. The Codex importer already
 * did this correctly.
 */
function toolName(v: unknown): string {
  return typeof v === 'string' && v ? v : 'tool';
}

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b as Block)?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function importClaudeTranscript(
  db: Database.Database,
  filePath: string,
  opts: { tags?: string[] } = {},
): ImportReport {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  const records: Record<string, unknown>[] = [];
  let skipped = 0;
  // Subagent FILES that could not be read. Counted separately from records:
  // adding them to `skipped` reported a record count in the wrong unit (1
  // skipped where zero records existed).
  let unreadableSubagentFiles = 0;
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
    // 50,000-record transcript, against the documented best-effort contract.
    // (Other scalars happened to survive; null alone was fatal.)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped++;
      continue;
    }
    records.push(parsed as Record<string, unknown>);
  }

  // First pass: index tool_result content by tool_use_id, and remember which
  // results were errors. A failed tool call carries `is_error: true` with the
  // failure text in `content`; dropping that flag makes a failed tool step
  // indistinguishable from a successful one (its `error` column stays null),
  // which downstream error-aware consumers read as success.
  const toolResults = new Map<string, unknown>();
  const toolErrors = new Set<string>();
  for (const rec of records) {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content);
          if (block.is_error === true) toolErrors.add(block.tool_use_id);
        }
      }
    }
  }

  let sessionId: string | undefined;
  let input: Record<string, unknown> | undefined;
  let lastAssistantText = '';
  let totalTokens = 0;
  let imported = 0;
  const steps: IngestStepInput[] = [];
  let stepNumber = 1;

  const startedAt = (records.find((r) => typeof r.timestamp === 'string')?.timestamp as string) ?? undefined;

  for (const rec of records) {
    const type = rec.type as string | undefined;
    if (typeof rec.sessionId === 'string' && !sessionId) sessionId = rec.sessionId;

    if (type !== 'user' && type !== 'assistant') {
      // Any record we don't turn into a step (system/summary and the various
      // metadata records real transcripts carry — attachment, file-history-
      // snapshot, queue-operation, ai-title, …) counts toward `skipped`, so the
      // imported-vs-skipped report accounts for every record.
      skipped++;
      continue;
    }

    const message = rec.message as { content?: unknown; usage?: Record<string, unknown> } | undefined;
    const content = message?.content;
    if (message?.usage) {
      totalTokens += toNum(message.usage.input_tokens) + toNum(message.usage.output_tokens);
    }

    let contributed = false;

    if (typeof content === 'string') {
      // Only a record that actually captures input or emits a step counts as
      // imported. A follow-up user turn (input already set) captures nothing —
      // there is no user/input step type — so it must fall through to skipped,
      // matching the codex-rollout importer and the content-less-record test.
      if (type === 'user' && !input) {
        input = { prompt: content };
        contributed = true;
      } else if (type === 'assistant') {
        lastAssistantText = content;
        steps.push({ step_number: stepNumber++, step_type: 'output', name: 'assistant_message', output: { text: content } });
        contributed = true;
      }
    } else if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        switch (block?.type) {
          case 'text': {
            if (type === 'user' && !input) {
              input = { prompt: block.text ?? '' };
              contributed = true;
            } else if (type === 'assistant' && block.text) {
              lastAssistantText = block.text;
              steps.push({ step_number: stepNumber++, step_type: 'output', name: 'assistant_message', output: { text: block.text } });
              contributed = true;
            }
            // A follow-up user turn or an empty-text block yields no step; leave
            // `contributed` false so the record is tallied as skipped.
            break;
          }
          case 'thinking': {
            steps.push({ step_number: stepNumber++, step_type: 'thought', name: 'thinking', output: { text: block.thinking ?? block.text ?? '' } });
            contributed = true;
            break;
          }
          case 'tool_use': {
            const result = block.id ? toolResults.get(block.id) : undefined;
            const failed = block.id ? toolErrors.has(block.id) : false;
            steps.push({
              step_number: stepNumber++,
              step_type: 'tool_call',
              name: toolName(block.name),
              input: block.input ?? {},
              output: result !== undefined ? { result: normalizeResult(result) } : null,
              // Mirror the live capture paths (hook-adapter): a failed tool call
              // keeps step_type 'tool_call' but populates `error` so the failure
              // survives. The result content is the error text; fall back like
              // the hook path when it's empty.
              error: failed ? (normalizeResult(result) || 'tool failed') : undefined,
              metadata: { tool_use_id: block.id },
            });
            contributed = true;
            break;
          }
          case 'tool_result':
            // already indexed in the first pass
            contributed = true;
            break;
          default:
            break;
        }
      }
    }

    // A user/assistant record that yielded no step (e.g. an empty or
    // content-less message) still counts — as skipped — so the imported-vs-
    // skipped report accounts for every top-level record, as documented above.
    if (contributed) imported++;
    else skipped++;
  }

  // Subagent transcripts live under `<session>/subagents/agent-<id>.jsonl`
  // next to the main transcript. Import each as an anchor step with the
  // subagent's own steps nested beneath it (best-effort — absent dir is fine).
  const subDir = join(dirname(filePath), basename(filePath, '.jsonl'), 'subagents');
  if (existsSync(subDir)) {
    let subFiles: string[] = [];
    try {
      subFiles = readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      subFiles = [];
    }
    for (const f of subFiles) {
      const agentId = basename(f, '.jsonl').replace(/^agent-/, '');
      const anchor = stepNumber;
      const subRecords: Record<string, unknown>[] = [];
      try {
        for (const l of readFileSync(join(subDir, f), 'utf-8').split('\n')) {
          const trimmed = l.trim();
          if (!trimmed) continue;
          // Parse each line on its own, like the main transcript, so one bad
          // line (e.g. a truncated final line from a killed run) skips only
          // that line instead of discarding the whole subagent file.
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            skipped++;
            continue;
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            skipped++;
            continue;
          }
          subRecords.push(parsed as Record<string, unknown>);
        }
      } catch {
        // The file itself is unreadable. Report it, but do NOT count it as a
        // skipped RECORD: it is a file, and "Records skipped" then reported a
        // number in the wrong unit (1 skipped where zero records existed).
        unreadableSubagentFiles++;
        continue;
      }
      // Build the children FIRST, and only anchor them if there are any. The
      // anchor used to be pushed before the file was even read, so an empty or
      // unreadable subagent file left a childless `subagent:<id>` thought step —
      // which also made `steps.length` non-zero, defeating the "nothing
      // importable → exit 1" guard below: `Records imported: 0` and exit 0 at
      // the same time. The spec says not to fabricate steps for unknown records.
      const built = buildSubagentSteps(subRecords, stepNumber + 1, anchor);
      if (built.steps.length === 0) {
        imported += built.imported;
        skipped += built.skipped;
        continue;
      }
      stepNumber++; // consume the anchor's number now that it has children
      steps.push({
        step_number: anchor,
        step_type: 'thought',
        name: `subagent:${agentId}`,
        metadata: { hook_anchor: 1, agent_id: agentId, source: 'subagent-transcript' },
      });
      steps.push(...built.steps);
      stepNumber += built.steps.length;
      totalTokens += built.tokens;
      // Add record counts, not step counts — "Records imported" must stay a
      // count of records, and imported + skipped must equal the records read.
      imported += built.imported;
      skipped += built.skipped;
    }
  }

  // A file that yielded no steps AND no prompt has nothing of the session in
  // it — only, at most, a session id from a header record. Creating a trace for
  // that produced an empty row and a green exit, so `import X && use-trace`
  // proceeded against content-free data; the command's own comment already says
  // producing no trace should be a failed import. Keying this on `sessionId`
  // alone let the empty case through, because a header record supplies the id.
  // A file that captured a prompt but no steps still imports — the prompt is
  // real content worth keeping.
  if (steps.length === 0 && !input) {
    return { trace: null, imported, skipped, steps: 0 };
  }

  if (unreadableSubagentFiles > 0) {
    console.error(
      `  ⚠ ${unreadableSubagentFiles} subagent file(s) could not be read and were left out.`,
    );
  }

  const traceInput: IngestTraceInput = {
    agent_name: 'claude-code',
    trigger: 'user_message',
    status: 'completed',
    session_id: sessionId ?? null,
    input: input ?? {},
    output: lastAssistantText ? { text: lastAssistantText } : null,
    started_at: startedAt,
    total_tokens: totalTokens || null,
    tags: opts.tags,
    metadata: { source_format: SOURCE_FORMAT, source_version: SOURCE_VERSION },
    steps,
  };

  const trace = ingestTrace(db, traceInput);
  return { trace, imported, skipped, steps: steps.length };
}

/** Build steps for one subagent transcript, nested under `parentStep`. */
function buildSubagentSteps(
  records: Record<string, unknown>[],
  startNumber: number,
  parentStep: number,
): { steps: IngestStepInput[]; tokens: number; imported: number; skipped: number } {
  const toolResults = new Map<string, unknown>();
  const toolErrors = new Set<string>();
  for (const rec of records) {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content);
          if (block.is_error === true) toolErrors.add(block.tool_use_id);
        }
      }
    }
  }

  const steps: IngestStepInput[] = [];
  let n = startNumber;
  let tokens = 0;
  // Count records the same way the main loop does — a record that yields at
  // least one step is imported, one that yields none is skipped — so the
  // caller's "Records imported" total stays a record count and the
  // imported + skipped = records invariant holds across subagents too.
  let imported = 0;
  let skipped = 0;

  for (const rec of records) {
    const before = steps.length;
    // A tool_result block yields no step of its own — it was indexed above and
    // attached to the paired tool_use step's output — but it DID contribute
    // retained data, so the record counts as imported (mirroring the main loop's
    // `case 'tool_result'`). Without this, a tool_result-only record (the normal
    // shape: tool_use and its result live in separate records) is mis-tallied as
    // skipped, disagreeing with the main transcript loop on the same record.
    let contributedResult = false;
    const type = rec.type as string | undefined;
    if (type === 'user' || type === 'assistant') {
      const message = rec.message as { content?: unknown; usage?: Record<string, unknown> } | undefined;
      if (message?.usage) tokens += toNum(message.usage.input_tokens) + toNum(message.usage.output_tokens);
      const content = message?.content;
      if (!Array.isArray(content)) {
        if (typeof content === 'string' && type === 'assistant') {
          steps.push({ step_number: n++, step_type: 'output', name: 'assistant_message', output: { text: content }, parent_step: parentStep });
        }
      } else {
        for (const block of content as Block[]) {
          if (block?.type === 'thinking') {
            steps.push({ step_number: n++, step_type: 'thought', name: 'thinking', output: { text: block.thinking ?? block.text ?? '' }, parent_step: parentStep });
          } else if (block?.type === 'text' && type === 'assistant' && block.text) {
            steps.push({ step_number: n++, step_type: 'output', name: 'assistant_message', output: { text: block.text }, parent_step: parentStep });
          } else if (block?.type === 'tool_use') {
            const result = block.id ? toolResults.get(block.id) : undefined;
            const failed = block.id ? toolErrors.has(block.id) : false;
            steps.push({
              step_number: n++,
              step_type: 'tool_call',
              name: toolName(block.name),
              input: block.input ?? {},
              output: result !== undefined ? { result: normalizeResult(result) } : null,
              // A failed subagent tool call keeps its error too (see main loop).
              error: failed ? (normalizeResult(result) || 'tool failed') : undefined,
              parent_step: parentStep,
              metadata: { tool_use_id: block.id },
            });
          } else if (block?.type === 'tool_result') {
            contributedResult = true;
          }
        }
      }
    }
    if (steps.length > before || contributedResult) imported++;
    else skipped++;
  }

  return { steps, tokens, imported, skipped };
}

function normalizeResult(content: unknown): string {
  return toText(content) || (typeof content === 'string' ? content : JSON.stringify(content));
}
