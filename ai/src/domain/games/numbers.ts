/**
 * The number games, GENERATED rather than authored.
 *
 * These are the only questions in the product that cost no content, cannot go
 * stale, cannot be culturally wrong and cannot be factually wrong — a digit span
 * is the same game in all eleven languages because digits are not a language.
 * That is the whole argument for having them: the trivia bank is bounded by what
 * someone sat down and wrote, and this is not.
 *
 * They are also the only kind here that is a brain game in the literal sense.
 * Trivia tests what you already know; holding four digits and saying them back
 * is working memory, and subtracting by sevens is attention. If the feature ever
 * has to shrink to one kind, it should shrink to this one.
 *
 * ⚠ NOT AN ASSESSMENT. Nothing generated here is calibrated against anything,
 * the difficulty ramp below is a feel for pacing and not a scale, and no result
 * from these questions goes anywhere near care signals (ADR 0009). A digit span
 * looks enough like a cognitive screening item that the distinction has to be
 * written down: this is a pastime, nobody consented to a test, and a companion
 * that quietly scores someone's memory has changed what it is without asking.
 *
 * Randomness is injected so a round is reproducible in a test. `Math.random` in
 * a handler is a flaky suite waiting to happen.
 */

import type { Question } from "./types.ts";

const CATEGORY = "numbers";

function pick(random: () => number, lo: number, hi: number): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/**
 * Say these back to me.
 *
 * Grows slowly — three digits at the start, five at the end of a round. Span
 * tasks get hard fast, and a game that opens at seven digits is a game that
 * tells someone they are failing in the first thirty seconds.
 */
function digitSpan(random: () => number, index: number): Question {
  const length = Math.min(5, 3 + Math.floor(index / 2));
  const digits: number[] = [];
  for (let i = 0; i < length; i++) digits.push(pick(random, 0, 9));
  const spaced = digits.join(" ");

  return {
    id: `num:span:${digits.join("")}`,
    kind: "numbers",
    category: CATEGORY,
    prompt: `I will say some numbers, and you say them back to me in the same order: ${spaced}.`,
    answers: [spaced, digits.join("")],
  };
}

/** Serial sevens, one step at a time. Each question stands alone — see the round. */
function takeAwaySeven(random: () => number): Question {
  const from = pick(random, 30, 99);
  return {
    id: `num:minus7:${from}`,
    kind: "numbers",
    category: CATEGORY,
    prompt: `Take seven away from ${from}. What are you left with?`,
    answers: [String(from - 7)],
  };
}

/** The oldest puzzle there is: four terms and a gap. */
function nextInSequence(random: () => number): Question {
  const start = pick(random, 1, 9);
  const step = pick(random, 2, 9);
  const terms = [start, start + step, start + step * 2, start + step * 3];
  return {
    id: `num:seq:${start}+${step}`,
    kind: "numbers",
    category: CATEGORY,
    prompt: `Here is a run of numbers: ${terms.join(", ")}. What comes next?`,
    answers: [String(start + step * 4)],
  };
}

/**
 * A round's worth, rotating through the three shapes.
 *
 * Rotating rather than choosing at random, because three of the same thing in a
 * row is what makes a game feel like a worksheet.
 */
export function generateNumberQuestions(count: number, random: () => number): Question[] {
  const out: Question[] = [];
  const seen = new Set<string>();

  // Bounded: a small board can collide on ids (two rounds of "take seven from
  // 64"), and a `while` here would spin rather than simply asking one twice.
  for (let i = 0; out.length < count && i < count * 8; i++) {
    const q =
      i % 3 === 0
        ? digitSpan(random, out.length)
        : i % 3 === 1
          ? takeAwaySeven(random)
          : nextInSequence(random);
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
  }
  return out;
}
