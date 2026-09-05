/**
 * Did they get it right? Decided HERE, not by the model.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE TOOL JUDGES AND NOT THE LLM.
 *
 * The answer key has to be somewhere when the question is asked. If it is in the
 * model's context, it leaks — not through malice but through helpfulness: a
 * model holding "Ganga" writes "which river runs past Varanasi — starts with a
 * G?" and the game is over before it began. So `start_game` returns the question
 * WITHOUT the key, the key stays in the round, and this function is what closes
 * the loop. The key reaches the model exactly once, in the result of the answer
 * that earned it.
 *
 * Which means the matching has to be good, because there is no model to be
 * charitable on our behalf. The input is a free-spoken sentence that has been
 * through ASR — "umm, the Ganges I think" — not a form field.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bias throughout is towards accepting. A false positive gives someone a
 * point they half-earned; a false negative tells an elderly person they are
 * wrong when they were right, which is the failure this whole feature has to
 * avoid to be worth shipping at all. Same trade `isStopRequest` makes in
 * src/copy/stop-intent.ts, for a related reason.
 */

/** Indic digit blocks. Each block puts ZERO at base and ascends by one. */
const DIGIT_BASES = [
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Odia
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
];

function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return ch;
  if (cp >= 0x30 && cp <= 0x39) return ch;
  for (const base of DIGIT_BASES) {
    if (cp >= base && cp <= base + 9) return String(cp - base);
  }
  return ch;
}

/**
 * English number words, folded to digits before matching.
 *
 * English appears here for the same reason it appears in every list in
 * stop-intent.ts: code-mixing is first-class in this product, and a Kannada
 * speaker counting out loud says "ninety three" as often as the Kannada. The
 * other ten languages are NOT tabulated, and deliberately so — the model is the
 * multilingual component, it is already in the loop, and tools/games.ts tells it
 * to pass numeric answers as digits. Ten hand-written numeral tables would be
 * ten more things to get wrong in languages nobody here can check.
 */
const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** "ninety three" -> "93", "one hundred" -> "100". Leaves everything else alone. */
function foldWords(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    const tens = TENS[t];
    if (tens !== undefined) {
      const next = tokens[i + 1];
      const unit = next === undefined ? undefined : UNITS[next];
      if (unit !== undefined && unit < 10) {
        out.push(String(tens + unit));
        i++;
        continue;
      }
      out.push(String(tens));
      continue;
    }

    const unit = UNITS[t];
    if (unit !== undefined) {
      // "one hundred" is the only multiplier worth carrying: it is where the
      // number games start and nothing in the banks goes past it.
      if (tokens[i + 1] === "hundred") {
        out.push(String(unit * 100));
        i++;
        continue;
      }
      out.push(String(unit));
      continue;
    }

    if (t === "hundred") {
      out.push("100");
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * "three hundred and sixty six" → 366. A second pass, over the first one's output.
 *
 * It has to be a second pass because the fold above works left to right and has
 * already turned that phrase into `300 and 66` by the time the tail is known.
 * Without this, the leap-year question rejected its own answer: `digitsOf` sees
 * "30066", the accept-list says "366", and someone who answered correctly was
 * told they were wrong — the exact failure this file's header calls the one that
 * must not happen.
 *
 * Deliberately stops at hundreds. Thousands would need "nineteen forty seven" —
 * which already works, because that is spoken as two pairs and folds to `19 47`
 * on its own — to keep working, and nothing in the banks reaches a thousand any
 * other way.
 */
function composeHundreds(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const hundreds = /^\d+$/.test(t) ? Number(t) : NaN;

    if (Number.isFinite(hundreds) && hundreds >= 100 && hundreds % 100 === 0) {
      // The "and" is optional: both "three hundred sixty six" and "three hundred
      // and sixty six" are how people say it, and Indian English prefers the second.
      const j = tokens[i + 1] === "and" ? i + 2 : i + 1;
      const tail = tokens[j];
      const rest = tail !== undefined && /^\d+$/.test(tail) ? Number(tail) : NaN;
      if (Number.isFinite(rest) && rest > 0 && rest < 100) {
        out.push(String(hundreds + rest));
        i = j;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

function foldNumberWords(tokens: string[]): string[] {
  return composeHundreds(foldWords(tokens));
}

/**
 * Drop the honorific "-ji". "Gandhiji" is "Gandhi", and "गांधीजी" is "गांधी".
 *
 * Not a nicety: almost nobody in this product's audience says "Gandhi" or "Lata"
 * bare, and the suffix costs two edits — one more than the tolerance allows for
 * a six-letter name — so every honorific answer was landing on "wrong". Handling
 * it here rather than by writing "Gandhiji" into a dozen accept-lists means it
 * also covers the names nobody thought to duplicate.
 *
 * The length floor is what stops it eating real words: the remainder has to be a
 * plausible name, so "raji" keeps its ending and only a stem of three or more
 * survives the strip.
 */
const HONORIFICS = ["ji", "जी"];

function dropHonorific(token: string): string {
  for (const suffix of HONORIFICS) {
    if (!token.endsWith(suffix)) continue;
    const stem = [...token.slice(0, token.length - suffix.length)];
    if (stem.length >= 3) return stem.join("");
  }
  return token;
}

/**
 * Lowercase, depunctuate, ASCII-ise digits, fold number words.
 *
 * BOTH MARK-HANDLING STEPS ARE LOAD-BEARING, and the second one caught a defect
 * in the first draft of this file.
 *
 * The strip targets U+0300–U+036F ONLY — the Combining Diacritical Marks block,
 * which is Latin, Greek and Cyrillic — so "café" folds to "cafe".
 *
 * The keep-set that follows then has to include `\p{M}`, because Devanagari
 * vowel signs and anusvara are MARKS, not letters. Without it "गंगा" came out as
 * "ग ग": every answer in an Indic script was quietly reduced to its bare
 * consonants. It still matched, because both sides were being destroyed the same
 * way — which is exactly why nothing but a test comparing against a literal
 * would ever have noticed.
 */
export function normalizeAnswer(raw: string): string {
  const tokens = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t !== "")
    .map(dropHonorific);

  return foldNumberWords(tokens).join(" ");
}

/** Every digit in order, spaces dropped. "4 9 2 7" and "4927" collapse together. */
export function digitsOf(text: string): string {
  return (text.match(/\d/g) ?? []).join("");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return b.length;
  if (b === "") return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * How wrong a word may be and still be the right word.
 *
 * Scaled to length because one edit in "rum" is a different word while one edit
 * in "brahmaputra" is a microphone. Sized against what ASR actually does to
 * proper nouns, which is the bulk of a trivia bank's answers.
 */
function tolerance(want: string): number {
  if (want.length <= 4) return 0;
  if (want.length <= 8) return 1;
  if (want.length <= 12) return 2;
  return 3;
}

function windows(tokens: string[], size: number): string[] {
  if (size > tokens.length) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) out.push(tokens.slice(i, i + size).join(" "));
  return out;
}

/**
 * Judge a spoken answer against the accept-list.
 *
 * A pass — the user saying they do not know — is NOT decided here: it is an
 * empty answer, and the round handles it (src/domain/games/controller.ts).
 */
export function judge(spoken: string, answers: readonly string[]): "correct" | "close" | "wrong" {
  const said = normalizeAnswer(spoken);
  if (said === "") return "wrong";

  const saidTokens = said.split(" ");
  const saidDigits = digitsOf(said);
  let nearest = Infinity;
  let nearestTolerance = 0;

  for (const raw of answers) {
    const want = normalizeAnswer(raw);
    if (want === "") continue;

    // A numeric answer is right or it is not. There is no near miss on a number:
    // 94 is not "almost 93", it is the wrong answer to a subtraction.
    if (/^[\d\s]+$/.test(want)) {
      const wantDigits = digitsOf(want);
      if (wantDigits === "") continue;
      // Two spellings of the same reply: every digit in order (a span read back
      // as "4 9 2 7") or one standalone number inside a sentence ("I think 93").
      if (saidDigits === wantDigits) return "correct";
      if (saidTokens.some((t) => /^\d+$/.test(t) && t === wantDigits)) return "correct";
      continue;
    }

    const wantTokens = want.split(" ");
    // Containment, not equality — people answer in sentences. "the ganges, I
    // think" contains the answer and is plainly right.
    if (wantTokens.length === 1) {
      if (saidTokens.includes(want)) return "correct";
    } else if (said.includes(want)) {
      return "correct";
    }

    const candidates =
      wantTokens.length === 1 ? saidTokens : [...windows(saidTokens, wantTokens.length), said];
    for (const candidate of candidates) {
      const d = levenshtein(candidate, want);
      if (d < nearest) {
        nearest = d;
        nearestTolerance = tolerance(want);
      }
    }
  }

  return nearest <= nearestTolerance ? "close" : "wrong";
}
