import type Database from 'better-sqlite3';
import { ingestTrace } from '../services/trace-service.js';
import { addPolicy } from '../services/guard-service.js';
import { customerServiceHallucination } from './scenarios/customer-service-hallucination.js';
import { codeAgentError } from './scenarios/code-agent-error.js';
import { ragContextPollution } from './scenarios/rag-context-pollution.js';
import { successfulBooking } from './scenarios/successful-booking.js';
import { guardrailViolation } from './scenarios/guardrail-violation.js';

/**
 * Seed all 5 demo scenarios and 3 guardrail policies into the database.
 * Timestamps are relative to "now" so the demo always looks fresh.
 */
export function seedDemoData(db: Database.Database): void {
  const now = new Date();

  // ── Insert 5 demo traces ───────────────────────────────────────────────
  const scenarios = [
    customerServiceHallucination(now),
    codeAgentError(now),
    ragContextPollution(now),
    successfulBooking(now),
    guardrailViolation(now),
  ];

  for (const scenario of scenarios) {
    ingestTrace(db, scenario);
  }

  // ── Insert 3 guardrail policies ────────────────────────────────────────

  // Policy 1: Block delete operations
  addPolicy(db, {
    name: 'no-delete-operations',
    description:
      'Prevents agents from executing delete/destroy/drop operations on production data. ' +
      'Agents must generate reports or escalate instead.',
    action: 'deny',
    priority: 100,
    match_pattern: {
      step_type: 'tool_call',
      name_contains: 'delete',
    },
  });

  // Policy 2: Warn on high token usage
  addPolicy(db, {
    name: 'token-limit-warning',
    description:
      'Triggers a warning when a single LLM call uses more than 5000 tokens, ' +
      'indicating potential context window bloat.',
    action: 'warn',
    priority: 50,
    match_pattern: {
      step_type: 'llm_call',
      input_contains: 'max_output_tokens',
    },
  });

  // Policy 3: Block external URL references
  addPolicy(db, {
    name: 'no-external-urls',
    description:
      'Blocks agent responses that contain external URLs to prevent ' +
      'prompt injection via URL-based payloads.',
    action: 'deny',
    priority: 75,
    match_pattern: {
      output_contains: 'http',
    },
  });
}
