/**
 * ASR failover availability — slice 8.
 *
 * The blunt fact this module encodes, and the reason it is a module rather than
 * an `if`: **"fail over to the other provider" survives for exactly one of our
 * eleven languages.**
 *
 * Deepgram's `flux-general-multi` covers ten languages — English, Spanish,
 * French, German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch — of which
 * exactly one is Indic
 * ([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)).
 * Intersected with our eleven that is `hi-IN` and `en-IN`. A Tamil, Bengali,
 * Marathi, Telugu, Gujarati, Kannada, Malayalam, Punjabi or Odia session has **no
 * second ASR at any point**, and no amount of code changes that.
 *
 * So this returns an honest `unavailable` with a reason for nine of eleven
 * languages, and the caller degrades rather than pretending. Writing the failover
 * as a general mechanism and discovering the coverage hole during an incident is
 * the failure mode this exists to prevent. See docs/00-provider-research.md §7.1b.
 *
 * NOTE ON COVERAGE, worth revisiting: Deepgram's **Nova-3** reaches hi, ta, te,
 * kn, gu, mr, pa, bn — eight of our eleven
 * ([models overview](https://developers.deepgram.com/docs/models-languages-overview)) —
 * but it is not the Flux turn-taking model, so adopting it as the standby means
 * running a second endpointing strategy that has never been tuned. That trade is
 * recorded in docs/adr/0008-degradation-policy.md, not decided here.
 */

import type { LanguageCode } from "./types.ts";
import { normalizeLanguage } from "./languages.ts";

export type AsrProviderName = "sarvam" | "deepgram";

/**
 * The intersection of Deepgram Flux Multilingual with our speakable set.
 * Two entries. This is the whole redundancy story for ASR.
 */
export const FLUX_MULTI_COVERAGE: readonly LanguageCode[] = ["hi-IN", "en-IN"];

export type StandbyDecision =
  | { available: true; provider: "deepgram"; languageHint: string }
  | {
      available: false;
      reason: "no_coverage" | "not_configured" | "already_failed_over";
      detail: string;
    };

export function standbyFor(
  language: LanguageCode,
  opts: { configured: boolean; current: AsrProviderName },
): StandbyDecision {
  if (opts.current === "deepgram") {
    return {
      available: false,
      reason: "already_failed_over",
      detail: "already on the standby; there is no third provider",
    };
  }

  const code = normalizeLanguage(language);
  if (code === null || !FLUX_MULTI_COVERAGE.includes(code)) {
    return {
      available: false,
      reason: "no_coverage",
      detail:
        `Deepgram flux-general-multi does not cover ${language}. Nine of our eleven ` +
        `languages have no second ASR — this session degrades instead.`,
    };
  }

  if (!opts.configured) {
    return {
      available: false,
      reason: "not_configured",
      // Two separate conditions gate this — ASR_FAILOVER_ENABLED and the key —
      // and the caller collapses them into one boolean. Naming only the key sent
      // an operator hunting for a missing credential during an incident where
      // the key was present and the flag was off, which is the likelier case
      // since the flag is the one that defaults to disabled. The boot log prints
      // both separately; say so rather than guessing which one.
      // No "no standby:" prefix here — session.ts already wraps this detail in
      // that phrase, and saying it twice reads as a stutter in the one log line
      // someone reads during an outage.
      detail:
        "ASR_FAILOVER_ENABLED is off or DEEPGRAM_API_KEY is unset — " +
        "the boot log reports which",
    };
  }

  // Flux takes a bare primary subtag as its language hint, not a BCP-47 region
  // tag. Passing "hi-IN" here is a silent no-op that leaves the model guessing.
  return { available: true, provider: "deepgram", languageHint: code.split("-")[0]! };
}

/** How many of the speakable set have a second ASR. Asserted in tests. */
export function redundancyProfile(speakable: readonly LanguageCode[]): {
  redundant: LanguageCode[];
  singleVendor: LanguageCode[];
} {
  const redundant = speakable.filter((c) => FLUX_MULTI_COVERAGE.includes(c));
  return {
    redundant,
    singleVendor: speakable.filter((c) => !FLUX_MULTI_COVERAGE.includes(c)),
  };
}
