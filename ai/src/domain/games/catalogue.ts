/**
 * What can be played, in this language, that has not been asked yet.
 *
 * The one interesting decision here is `kindsFor`. Trivia and numbers are
 * available in all eleven languages — one because the model narrates it, the
 * other because digits are not a language. Proverbs are available in two. That
 * asymmetry is the feature's whole shape (src/domain/games/types.ts), and this
 * is where it becomes a list.
 *
 * Pure, and seeded from outside: a round has to be reproducible in a test, and
 * `Math.random` reached from inside a tool handler is a suite that fails once a
 * fortnight for no reason anyone can find.
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";
import { normalizeLanguage } from "../languages.ts";
import { TRIVIA } from "./bank.ts";
import { generateNumberQuestions } from "./numbers.ts";
import { PROVERBS } from "./proverbs.ts";
import type { GameKind, Question } from "./types.ts";

/**
 * Questions per round.
 *
 * Five, because a round has to be finishable in one sitting by someone who tires
 * — and because a round that ends is a round the companion can close warmly and
 * offer again, where a round that drags gets abandoned halfway and leaves the
 * score hanging.
 */
export const ROUND_LENGTH = 5;

/** Where an unspecified request lands. Trivia is the most conversational of the three. */
const DEFAULT_KIND: GameKind = "trivia";

/** Kinds with real content behind them in this language, in offer order. */
export function kindsFor(language: LanguageCode): GameKind[] {
  const code = normalizeLanguage(language) ?? language;
  const kinds: GameKind[] = ["trivia", "numbers"];
  if ((PROVERBS[code]?.length ?? 0) > 0) kinds.push("proverbs");
  return kinds;
}

/** Fisher-Yates, on a copy, from the injected source. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * Prefer what has not been asked, but never refuse to play.
 *
 * A long session can exhaust a category, and "we have run out of questions" is a
 * worse answer than one repeat. Unseen questions come first; seen ones fill the
 * tail only if there are not enough.
 */
function preferUnseen(
  pool: readonly Question[],
  exclude: ReadonlySet<string>,
  count: number,
  random: () => number,
): Question[] {
  const fresh = shuffled(
    pool.filter((question) => !exclude.has(question.id)),
    random,
  );
  if (fresh.length >= count) return fresh.slice(0, count);
  const repeats = shuffled(
    pool.filter((question) => exclude.has(question.id)),
    random,
  );
  return [...fresh, ...repeats].slice(0, count);
}

export type RoundPlan = {
  kind: GameKind;
  category: string;
  questions: Question[];
};

/**
 * Build a round.
 *
 * `kind` is a HINT, not a demand: the caller may be relaying a user who asked
 * for a word game in a language that has none. Falling back and saying so beats
 * refusing, and the difference is visible to the caller — the kind that comes
 * back is the kind that was built.
 */
export function pickRound(opts: {
  kind?: GameKind | undefined;
  category?: string | undefined;
  language: LanguageCode;
  count?: number | undefined;
  exclude?: ReadonlySet<string> | undefined;
  random: () => number;
}): RoundPlan | null {
  const count = opts.count ?? ROUND_LENGTH;
  const exclude = opts.exclude ?? new Set<string>();
  const available = kindsFor(opts.language);
  const kind =
    opts.kind && available.includes(opts.kind)
      ? opts.kind
      : available.includes(DEFAULT_KIND)
        ? DEFAULT_KIND
        : available[0];
  if (!kind) return null;

  if (kind === "numbers") {
    const questions = generateNumberQuestions(count, opts.random);
    return questions.length === 0 ? null : { kind, category: "numbers", questions };
  }

  if (kind === "proverbs") {
    const code = normalizeLanguage(opts.language) ?? opts.language;
    const pool = PROVERBS[code] ?? [];
    const questions = preferUnseen(pool, exclude, count, opts.random);
    return questions.length === 0 ? null : { kind, category: "sayings", questions };
  }

  // An unknown category is ignored rather than rejected. The model picked the
  // word "temple" out of a user's sentence; answering with a mixed round is a
  // better companion than answering with a complaint about a parameter.
  const wanted = opts.category;
  const filtered = wanted ? TRIVIA.filter((question) => question.category === wanted) : [];
  const pool = filtered.length > 0 ? filtered : TRIVIA;
  const questions = preferUnseen(pool, exclude, count, opts.random);
  return questions.length === 0
    ? null
    : { kind, category: filtered.length > 0 ? wanted! : "mixed", questions };
}
