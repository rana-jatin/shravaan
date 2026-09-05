/**
 * Resolving a message to the words that get spoken.
 *
 * The one rule the whole file serves: A MISSING TRANSLATION MUST NEVER BECOME
 * SILENCE. Every path here ends in a string, and every fallback is down the
 * ladder in `languages.json` rather than a per-file guess.
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";
import { REFUSAL_LADDER } from "../domain/languages.ts";
import type { Catalogue, CopySet, ReviewEntry } from "./types.ts";

/**
 * Where to look when a message has no entry for the requested language.
 *
 * READ FROM `languages.json`, not written here, because the gate already reads
 * it and two copies of a ladder is how they came to disagree. Hindi first: it
 * has the widest comprehension across the excluded set. English last, because
 * something is always better than nothing.
 */
export const LADDER: readonly LanguageCode[] = REFUSAL_LADDER;

export type ResolveOptions = {
  /**
   * Rotates through `variants`. Pass a counter that increases per utterance —
   * the same number twice gives the same words twice, which is the point when a
   * test wants determinism and a bug when a session does.
   */
  rotate?: number;
  /** `{name}` placeholders to fill. See `interpolate`. */
  vars?: Record<string, string>;
};

/**
 * The copy set for a language, walking the ladder.
 *
 * Returns null only when a key exists in no language at all, which is a
 * programming error rather than a translation gap.
 */
export function lookup<K extends string>(
  catalogue: Catalogue<K>,
  key: K,
  language: LanguageCode,
): CopySet | null {
  const byLanguage = catalogue[key];
  if (!byLanguage) return null;

  const direct = byLanguage[language];
  if (direct) return direct;

  for (const rung of LADDER) {
    const found = byLanguage[rung];
    if (found) return found;
  }

  // Nothing on the ladder either. Take whatever exists rather than say nothing:
  // a sentence in the wrong language still tells a person something is
  // happening, and silence on this path is the failure the gate exists to stop.
  return Object.values(byLanguage)[0] ?? null;
}

/**
 * One message, ready to speak.
 *
 * Throws only for a key that exists in no language — a typo in a call site,
 * caught by the catalogue tests rather than by a user hearing nothing.
 */
export function t<K extends string>(
  catalogue: Catalogue<K>,
  key: K,
  language: LanguageCode,
  opts: ResolveOptions = {},
): string {
  const set = lookup(catalogue, key, language);
  if (!set || set.variants.length === 0) {
    throw new Error(`no copy for "${key}" in any language`);
  }
  const index = (opts.rotate ?? 0) % set.variants.length;
  return interpolate(set.variants[index]!, opts.vars);
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fill `{name}` placeholders.
 *
 * TWO THINGS THIS FIXES, both from the hand-rolled `.replace("{names}", …)`
 * this replaces:
 *
 *   `String.replace` with a string pattern substitutes the FIRST match only. A
 *   translation that used `{names}` twice — which no reviewer would think twice
 *   about — would have had the second one read out as literal braces.
 *
 *   An unfilled placeholder was spoken verbatim. Hearing "I'm telling open
 *   brace names close brace" from a device you asked for help is worse than
 *   hearing a slightly clipped sentence, so anything left over is dropped along
 *   with the space it leaves behind.
 */
export function interpolate(text: string, vars?: Record<string, string>): string {
  return text
    .replace(PLACEHOLDER, (whole, name: string) => vars?.[name] ?? "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:।])/g, "$1")
    .trim();
}

/** Languages in this catalogue whose copy is still placeholder text. */
export function reviewPending<K extends string>(
  scope: string,
  catalogue: Catalogue<K>,
  /** Use the message key as the scope instead of one name for the catalogue. */
  perKey = false,
): ReviewEntry[] {
  const out: ReviewEntry[] = [];
  for (const [key, byLanguage] of Object.entries(catalogue) as Array<
    [K, Partial<Record<LanguageCode, CopySet>>]
  >) {
    for (const [language, set] of Object.entries(byLanguage)) {
      if (set?.needsNativeReview) out.push({ scope: perKey ? key : scope, language });
    }
  }
  return out;
}
