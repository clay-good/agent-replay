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
 * typed.
 *
 * Tested by INVERSION rather than by a list of known wrappers. An earlier
 * version enumerated `<command-name>`, `<environment_context>` and friends.
 * Measured over every transcript on this machine (4,466 Claude sessions and 506
 * Codex rollouts, ~19,000 user turns), that list missed the most common wrapper
 * by an order of magnitude — a task-notification block, 1,495 occurrences —
 * along with `<environment_context>`, `<recommended_plugins>`, `<turn_aborted>`
 * and `<openlore-untrusted-data-…>`, the last of which carries a per-session
 * random suffix that no literal could ever have matched.
 *
 * Every harness envelope in that corpus is either a tag-like wrapper or one of
 * a few injected notices, and of the ~1,950 turns opening with `<`, NOT ONE is
 * a human-typed question. So the rule is the shape, not the name.
 *
 * Getting this wrong in either direction is cheap and recoverable: a missed
 * envelope costs a slightly worse prompt, and a question misread as an envelope
 * is still kept (the fallbacks below never discard a turn).
 */
export function isEnvelopeTurn(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith('<')) return true;
  return (
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('A session-scoped Stop hook is now active') ||
    t.startsWith('[SYSTEM NOTIFICATION') ||
    // The continuation summary a harness writes for itself when a session is
    // COMPACTED. It arrives as a user turn, so it was chosen as the prompt of
    // every long session — measured on two real transcripts, `input.prompt`
    // held 10 KB of harness-written summary while the user's actual message
    // ("Goal check-in: ...") sat in `follow_up_prompts`. `why`, the summarizer,
    // the rubric evals and `check --golden` all read `input.prompt` as what was
    // asked. A session that was ONLY a continuation still keeps it, through the
    // same fallback every other envelope uses.
    t.startsWith('This session is being continued from a previous conversation')
  );
}

/**
 * One user turn, with whatever the producer said ABOUT it.
 *
 * `isMeta` is Claude Code's own flag for a record the harness injected rather
 * than a person typing — a skill preamble, a hook notice, an image placeholder,
 * a "Continue from where you left off." Measured across every transcript on this
 * machine (2,015 sessions, 7,139 user turns): 1,361 turns carry it, the shape
 * heuristic below misses 1,002 of them, and 147 sessions therefore chose one as
 * `trace.input.prompt`. Not one of the 1,002 reads as a human question.
 *
 * A stated fact beats an inferred one, so it is read where it is present and
 * the shape rule stays for records that carry no such flag — Codex rollouts
 * have none, and neither do older transcripts.
 */
export interface UserTurn {
  text: string;
  /** The producer said this turn was harness-injected. */
  isMeta?: boolean;
}

export interface SelectedPrompt {
  input: Record<string, unknown> | undefined;
  /** Turns AFTER the chosen prompt, in order. */
  followUps: string[];
  /** Envelope turns that preceded the chosen prompt, in order. */
  preamble: string[];
}

/**
 * Split ordered user turns into the trace prompt, its follow-ups and the
 * preamble that came before it.
 *
 * `follow_up_prompts` means "later turns" everywhere else in this codebase (the
 * batch merge and the OTLP mapper both use it that way), so the envelope turns
 * that PRECEDE the chosen prompt must not be dumped into it — that would make
 * one field mean two different things depending on which path wrote it. They go
 * to `preamble_prompts` instead: still nothing is discarded, and both fields say
 * exactly what they hold.
 */
export function selectPrompt(turns: Array<string | UserTurn>): SelectedPrompt {
  const norm: UserTurn[] = turns.map((t) => (typeof t === 'string' ? { text: t } : t));
  const kept = norm.filter((t) => t.text.trim().length > 0);
  if (kept.length === 0) return { input: undefined, followUps: [], preamble: [] };
  const real = kept.map((t) => t.text);
  // `isMeta` first: the producer's own statement that the harness wrote this
  // turn, which no text rule can match reliably (a skill preamble opens with
  // its own directory path; an image placeholder with "[Image: original …").
  let idx = kept.findIndex((t) => !t.isMeta && !isEnvelopeTurn(t.text));
  // Every turn is an envelope: use the first anyway. An envelope prompt beats
  // no prompt at all, and that was the behavior before any of this existed.
  if (idx === -1) idx = 0;
  return {
    input: { prompt: real[idx] },
    followUps: real.slice(idx + 1),
    preamble: real.slice(0, idx),
  };
}
