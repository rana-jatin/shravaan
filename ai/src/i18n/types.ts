/**
 * The shape spoken copy comes in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS LAYER EXISTS. The copy tables were fine; what sat on top of them was
 * not. `src/copy/` grew four separate resolvers, and by the time the fifth was
 * written inline in `session.ts` they no longer agreed with each other:
 *
 *   fillers.ts     language -> hi-IN -> en-IN   (three times over, copy-pasted)
 *   refusals.ts    language -> hi-IN -> en-IN
 *   session.ts     language -> en-IN            ← skipped Hindi, on the
 *                                                 EMERGENCY acknowledgement
 *
 * That last one is the one that matters. `languages.json` says Hindi is on the
 * ladder because it has the widest comprehension across the excluded set — and
 * the single place that dropped it was the sentence telling a frightened person
 * that help is coming. Every table happens to carry all eleven languages today,
 * so it has never fired. It was still one missing translation away from being
 * the worst possible place to fall back to the wrong language.
 *
 * One resolver, one ladder, read from the same `languages.json` the gate uses.
 *
 * ADDING COPY IS ADDING A CATALOGUE. A capability ships its own — medication
 * reminders and check-ins will each want a dozen lines — and nothing about that
 * requires editing a shared table or a shared resolver. `CATALOGUES` in
 * ./catalogues.ts is the list the boot-time review report walks.
 *
 * WHAT THIS DELIBERATELY IS NOT: a move to JSON. Translators would be better
 * served by it, and it is worth doing. But these tables carry the reasoning
 * that makes them correct — which languages inflect the verb for the speaker's
 * gender, why a stop phrase must not be paraphrased, what was measured — and
 * JSON cannot hold a comment. Extracting them is its own change, with a plan
 * for where the reasoning goes. Noted as follow-up rather than done halfway.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";

/**
 * One message, in one language.
 *
 * `variants` rotate: a companion that says the identical words every time it
 * waits stops sounding like a person very quickly. Most entries have one.
 */
export type CopySet = {
  variants: string[];
  /**
   * Placeholder text a native speaker has not signed off.
   *
   * Nine of eleven languages are in this state. The server says so at boot, and
   * it is not shippable to users until they are reviewed — see the warning in
   * `backend/src/server.ts`.
   */
  needsNativeReview: boolean;
};

/** Every language a message exists in. Partial: a gap falls down the ladder. */
export type Catalogue<K extends string = string> = Record<
  K,
  Partial<Record<LanguageCode, CopySet>>
>;

/** Reviewed by a native speaker. */
export const ready = (...variants: string[]): CopySet => ({ variants, needsNativeReview: false });

/** Machine-drafted. Counted at boot, and not shippable. */
export const draft = (...variants: string[]): CopySet => ({ variants, needsNativeReview: true });

/** One line of the boot-time review report. */
export type ReviewEntry = {
  /** Which catalogue — "filler", "gate.unsupported_language", "medication". */
  scope: string;
  language: LanguageCode;
};
