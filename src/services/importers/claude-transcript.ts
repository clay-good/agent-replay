import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
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
      // system/summary/other: not turned into steps, but not an error either.
      if (type !== 'system' && type !== 'summary') skipped++;
      continue;
    }

    const message = rec.message as { content?: unknown; usage?: Record<string, number> } | undefined;
    const content = message?.content;
    if (message?.usage) {
      totalTokens += (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
    }

    let contributed = false;

    if (typeof content === 'string') {
      if (type === 'user' && !input) {
        input = { prompt: content };
      } else if (type === 'assistant') {
        lastAssistantText = content;
        steps.push({ step_number: stepNumber++, step_type: 'output', name: 'assistant_message', output: { text: content } });
      }
      contributed = true;
    } else if (Array.isArray(content)) {
      for (const block of content as Block[]) {
        switch (block?.type) {
          case 'text': {
            if (type === 'user' && !input) {
              input = { prompt: block.text ?? '' };
            } else if (type === 'assistant' && block.text) {
              lastAssistantText = block.text;
              steps.push({ step_number: stepNumber++, step_type: 'output', name: 'assistant_message', output: { text: block.text } });
            }
            contributed = true;
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

    if (contributed) imported++;
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

function normalizeResult(content: unknown): string {
  return toText(content) || (typeof content === 'string' ? content : JSON.stringify(content));
}
