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

  // Policy 2: Flag LLM calls that configure an output-token cap.
  //
  // The description used to claim it fires "when a call uses more than 5000
  // tokens". It cannot: the match keys are substring/step-type tests, with no
  // numeric threshold among them — so this matches any llm_call whose input
  // MENTIONS max_output_tokens, whatever the value. (The demo's own occurrence
  // is 4000, below the number the old text claimed.) Describe what it does.
  addPolicy(db, {
    name: 'token-limit-warning',
    description:
      'Warns on an LLM call that configures an output-token cap, as a hook for ' +
      'reviewing context-window growth.',
    action: 'warn',
    priority: 50,
    match_pattern: {
      step_type: 'llm_call',
      input_contains: 'max_output_tokens',
    },
  });

  // Policy 3: Flag responses carrying external URLs.
  //
  // `warn`, deliberately, not `deny`. Live enforcement evaluates a PROPOSED
  // tool call, before it runs and therefore before it has any output, so a
  // BLOCKING policy keyed on `output_contains` can never fire — `guard add`
  // warns about exactly this shape. Seeding it as a deny taught users to write
  // a kill switch that silently does nothing, and the seed path bypasses that
  // warning. As a warn it is what it actually is: an auditing pattern, which
  // `guard test` and a recorded step both evaluate.
  addPolicy(db, {
    name: 'no-external-urls',
    description:
      'Flags agent responses containing external URLs (post-hoc review — an ' +
      'output pattern cannot block a call before it runs).',
    action: 'warn',
    priority: 75,
    match_pattern: {
      output_contains: 'http',
    },
  });
}
