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
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }

  // First pass: index tool_result content by tool_use_id.
  const toolResults = new Map<string, unknown>();
  for (const rec of records) {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content);
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

    const message = rec.message as { content?: unknown; usage?: Record<string, number> } | undefined;
    const content = message?.content;
    if (message?.usage) {
      totalTokens += (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
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
            steps.push({
              step_number: stepNumber++,
              step_type: 'tool_call',
              name: block.name ?? 'tool',
              input: block.input ?? {},
              output: result !== undefined ? { result: normalizeResult(result) } : null,
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
      const anchor = stepNumber++;
      steps.push({
        step_number: anchor,
        step_type: 'thought',
        name: `subagent:${agentId}`,
        metadata: { hook_anchor: 1, agent_id: agentId, source: 'subagent-transcript' },
      });
      const subRecords: Record<string, unknown>[] = [];
      try {
        for (const l of readFileSync(join(subDir, f), 'utf-8').split('\n')) {
          const trimmed = l.trim();
          if (!trimmed) continue;
          // Parse each line on its own, like the main transcript, so one bad
          // line (e.g. a truncated final line from a killed run) skips only
          // that line instead of discarding the whole subagent file.
          try {
            subRecords.push(JSON.parse(trimmed));
          } catch {
            skipped++;
          }
        }
      } catch {
        // The file itself is unreadable — skip it whole.
        skipped++;
        continue;
      }
      const built = buildSubagentSteps(subRecords, stepNumber, anchor);
      steps.push(...built.steps);
      stepNumber += built.steps.length;
      totalTokens += built.tokens;
      // Add record counts, not step counts — "Records imported" must stay a
      // count of records, and imported + skipped must equal the records read.
      imported += built.imported;
      skipped += built.skipped;
    }
  }

  if (steps.length === 0 && !sessionId) {
    return { trace: null, imported, skipped, steps: 0 };
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
  for (const rec of records) {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block?.type === 'tool_result' && block.tool_use_id) toolResults.set(block.tool_use_id, block.content);
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
    const type = rec.type as string | undefined;
    if (type === 'user' || type === 'assistant') {
      const message = rec.message as { content?: unknown; usage?: Record<string, number> } | undefined;
      if (message?.usage) tokens += (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
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
            steps.push({
              step_number: n++,
              step_type: 'tool_call',
              name: block.name ?? 'tool',
              input: block.input ?? {},
              output: result !== undefined ? { result: normalizeResult(result) } : null,
              parent_step: parentStep,
              metadata: { tool_use_id: block.id },
            });
          }
        }
      }
    }
    if (steps.length > before) imported++;
    else skipped++;
  }

  return { steps, tokens, imported, skipped };
}

function normalizeResult(content: unknown): string {
  return toText(content) || (typeof content === 'string' ? content : JSON.stringify(content));
}
