/**
 * Prompt selection shared by the transcript importers.
 *
 * Two problems, one rule:
 *
 * 1. Only the FIRST user turn was kept. Every later one hit a branch that
 *    counted it as skipped and stored it nowhere, so a 59-turn session imported
 *    with one question and the other 58 unrecoverable — while the two other
 *    assembly paths that model the same thing (the batch merge in
 *    `trace-service`, and the OTLP log-event mapper) both put later turns in
 *    `metadata.follow_up_prompts`. Same concept, three code paths, one of which
 *    disagreed; these importers now follow the existing convention.
 *
 * 2. The turn that was kept is usually not a prompt. Real transcripts open with
 *    a harness envelope — a slash-command block, injected instructions, an
 *    environment preamble — so `trace.input.prompt` (what `why`, the
 *    summarizer, the rubric evals and `check` all read as "what was asked")
 *    held boilerplate while the user's actual question sat in a later turn.
 *
 * So: the prompt is the first turn that is not an envelope, and every other
 * turn is preserved in order. If EVERY turn is an envelope the first one is
 * still used, because an envelope prompt beats no prompt at all and that was
 * the previous behavior.
 */

/**
 * Whether a user turn is a harness envelope rather than something a person
 * typed. Deliberately narrow: it matches only text that BEGINS with a known
 * wrapper, so an ordinary question that happens to mention one of these words
 * is never mistaken for boilerplate. Missing an envelope costs a slightly worse
 * prompt; misreading a real question as one loses it from the field every
 * reader treats as the ask.
 */
export function isEnvelopeTurn(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<INSTRUCTIONS>') ||
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('<system-reminder>')
  );
}

export interface SelectedPrompt {
  input: Record<string, unknown> | undefined;
  followUps: string[];
}

/** Split ordered user turns into the trace prompt and its follow-ups. */
export function selectPrompt(turns: string[]): SelectedPrompt {
  const real = turns.filter((t) => t.trim().length > 0);
  if (real.length === 0) return { input: undefined, followUps: [] };
  let idx = real.findIndex((t) => !isEnvelopeTurn(t));
  if (idx === -1) idx = 0;
  return {
    input: { prompt: real[idx] },
    followUps: real.filter((_, i) => i !== idx),
  };
}
