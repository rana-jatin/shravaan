/**
 * Care signals: what a retrospective read of the transcript is allowed to claim.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS FILE EXISTS TO PREVENT: A CONFIDENT WRONG ANSWER.
 *
 * D9 is the reference failure — Open-Meteo returned weather for Razavi Khorasan,
 * fluently, with nothing in the response to mark it wrong, and the companion
 * spoke it. An English-only sentiment model handed a Hindi transcript does the
 * same thing in a far worse register: it will return a number, the number will
 * look like data, and it will be about nothing. So the language gate below is a
 * hard refusal that runs BEFORE the network call, and every mapping function
 * returns `undefined` rather than a default when the field it wanted is missing.
 *
 * Absent means absent. A fabricated 0.0 is indistinguishable from a genuinely
 * neutral week, and it is the trend that carries the whole feature.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ WHAT THIS IS NOT. It is not an alarm path. src/copy/emergency-intent.ts is
 * local, pre-network and sub-second precisely because a call for help cannot wait
 * on anything; this runs in the memory worker, minutes to hours later, only on
 * English sessions, on a provider we do not control. Wiring it to the alerter
 * would give a slow English-only false sense of coverage over a fast
 * eleven-language path that already works. It informs a caregiver's reading of
 * the week. Nothing here ever raises an alarm.
 *
 * ⚠ NOR IS IT A DIAGNOSIS. "Negative sentiment across four sessions" means the
 * person used words a model scored low. It does not mean depressed, and no copy
 * derived from this may imply that it does.
 */

import type { CareSignals, Episode, LanguageCode, MemWriteEvent } from "./types.ts";

/**
 * The watch-list, sent as `custom_intent` with `custom_intent_mode=strict` so
 * Deepgram returns THESE AND NOTHING ELSE.
 *
 * Strict mode is the point. An open intent list is a model inventing categories
 * nobody reviewed, arriving in a caregiver's inbox with the authority of a
 * system that supposedly watches someone's mother. A fixed list can be read,
 * argued with, and signed off before it ships.
 *
 * ⚠ THIS LIST IS A PRODUCT DECISION AWAITING REVIEW, not an engineering default.
 * It was drafted against the care use case, not validated by a clinician, and
 * its wording is what Deepgram matches on — so the phrasing is load-bearing and
 * changing it changes what fires. English, because the endpoint is.
 */
export const CARE_INTENTS: readonly string[] = [
  "reports pain",
  "reports a fall",
  "reports dizziness or feeling faint",
  "reports breathlessness",
  "reports not sleeping",
  "reports not eating",
  "reports confusion or memory trouble",
  "misses or refuses medication",
  "asks for help",
  "expresses loneliness",
  "expresses hopelessness",
  "expresses fear or anxiety",
  "mentions a doctor or hospital visit",
  "mentions money trouble",
  "asks to contact a family member",
  "reports a problem in the home",
];

/**
 * Below this, there is nothing to read.
 *
 * Deepgram's own floor for summarisation is 50 words; borrowed here for the
 * whole call because a four-line "hello / fine / goodnight" exchange produces a
 * sentiment score that is pure noise, and a trend built from noise is worse than
 * no trend at all.
 */
export const MIN_WORDS = 50;

/**
 * Character cap, deliberately far below their 150K TOKEN limit.
 *
 * We do not have Deepgram's tokeniser, so any character-to-token ratio here is a
 * guess. ~60K characters is roughly 15-20K tokens on English prose — nowhere
 * near the ceiling, which is the point: a cap that runs close to a hard limit is
 * a cap that eventually 400s on the one session someone talked all afternoon.
 */
export const MAX_CHARS = 60_000;

/** Deepgram's own break point between neutral and not. Not ours to tune. */
const SENTIMENT_BREAK = 0.333333333;

export type Analysability =
  | { ok: true; text: string }
  | { ok: false; reason: "not_english" | "too_short" | "empty" };

/**
 * English, or nothing.
 *
 * EVERY language observed in the session must be English. Not "mostly", not "the
 * dominant one" — a Hinglish session is code-mixed by design in this product
 * (README, "Language set"), and half a transcript in Devanagari scored by an
 * English model is exactly the confident-wrong-answer case above.
 */
export function isEnglishOnly(languages: readonly LanguageCode[]): boolean {
  if (languages.length === 0) return false;
  return languages.every((l) => l.toLowerCase().split("-")[0] === "en");
}

/**
 * The user's words only.
 *
 * The assistant's turns are excluded, and that is not a rounding decision: this
 * companion is written to be warm, so its own lines score positive almost
 * everywhere. Averaging them in would drag every session upward and mask exactly
 * the weeks this feature exists to notice.
 *
 * Truncation keeps the END of the conversation. If a session has to be cut, the
 * recent half is the half that matters.
 */
export function userTranscript(events: readonly MemWriteEvent[], maxChars = MAX_CHARS): string {
  const lines = events
    .map((e) => e.user_text?.trim())
    .filter((t): t is string => !!t && t !== "");

  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

export function analysable(
  languages: readonly LanguageCode[],
  text: string,
  minWords = MIN_WORDS,
): Analysability {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (!isEnglishOnly(languages)) return { ok: false, reason: "not_english" };
  if (countWords(text) < minWords) return { ok: false, reason: "too_short" };
  return { ok: true, text };
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export type MappingOptions = {
  /** Below this, an intent match is noise. Unverified — see the note in mapIntents. */
  intentConfidence: number;
  analysedAt: string;
};

/**
 * Deepgram's response → our contract.
 *
 * Returns `null` when the body carried NEITHER a sentiment average NOR a single
 * intent — a 200 with nothing usable in it is not a signal, and writing an empty
 * `signals` object onto an episode would make "we analysed and found nothing"
 * indistinguishable from "we never analysed this session".
 *
 * Every field is read through a typed guard. The shape below is documented, not
 * verified against a live key (see the header of deepgram-read.ts), so this
 * function's job is to survive being wrong about it.
 */
export function toCareSignals(raw: unknown, opts: MappingOptions): CareSignals | null {
  const sentiments = pick(pick(raw, "results"), "sentiments");
  const intents = pick(pick(raw, "results"), "intents");

  const signals: CareSignals = { provider: "deepgram", analysed_at: opts.analysedAt };

  const average = pick(sentiments, "average");
  const avgScore = num(pick(average, "sentiment_score"));
  if (avgScore !== undefined) {
    signals.sentiment = { label: labelFor(avgScore), score: round2(avgScore) };
  }

  const segments = arr(pick(sentiments, "segments"))
    .map((s) => num(pick(s, "sentiment_score")))
    .filter((n): n is number => n !== undefined)
    .map(round2);
  if (segments.length > 0) signals.sentiment_segments = segments;

  const flagged = mapIntents(arr(pick(intents, "segments")), opts.intentConfidence);
  if (flagged.length > 0) signals.flagged_intents = flagged;

  return signals.sentiment || signals.flagged_intents ? signals : null;
}

/**
 * Strongest hit per intent, above the floor.
 *
 * ⚠ THE FLOOR IS A GUESS. Deepgram publishes no calibration for
 * `confidence_score`, so 0.5 is a placeholder that needs tuning against real
 * transcripts before anyone acts on what comes out. Tuned wrong in one direction
 * it floods a caregiver until they stop reading; in the other it is silent. It is
 * configurable for that reason and defaults conservatively.
 *
 * One entry per intent, not per occurrence: "reports pain" three times in one
 * session is one thing that happened, and a caregiver reading a list wants the
 * distinct concerns, not a frequency table.
 */
export function mapIntents(
  segments: readonly unknown[],
  floor: number,
): NonNullable<CareSignals["flagged_intents"]> {
  const best = new Map<string, { intent: string; confidence: number; text: string }>();

  for (const segment of segments) {
    const text = str(pick(segment, "text")) ?? "";
    for (const hit of arr(pick(segment, "intents"))) {
      const intent = str(pick(hit, "intent"));
      const confidence = num(pick(hit, "confidence_score"));
      if (!intent || confidence === undefined || confidence < floor) continue;

      const prev = best.get(intent);
      if (prev && prev.confidence >= confidence) continue;
      best.set(intent, {
        intent,
        confidence: round2(confidence),
        // Enough for a caregiver to judge the match, short enough that an
        // episode does not quietly become a second transcript.
        text: text.length > 160 ? text.slice(0, 157) + "..." : text,
      });
    }
  }

  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

// --- Reading it back ---------------------------------------------------------

export type MoodTrend = {
  sessions: number;
  /** Mean of the whole window, rounded. */
  average: number;
  label: "positive" | "neutral" | "negative";
  /** Recent half against the earlier half. `unknown` until there are enough sessions. */
  direction: "brighter" | "lower" | "steady" | "unknown";
  /** Distinct watch-list intents seen across the window. */
  flagged: string[];
};

/**
 * A shift worth mentioning at all.
 *
 * Sentiment scores wobble session to session for reasons that have nothing to do
 * with how someone is — what they happened to talk about, how long they talked
 * for. A companion that announces a downturn every time the number dips reads as
 * anxious rather than attentive, so the band is wide on purpose.
 */
const TREND_BAND = 0.15;

/** Fewer than this and "the recent half" is one session, which is not a trend. */
const MIN_SESSIONS_FOR_DIRECTION = 4;

/**
 * Summarise recent episodes for `recall_mood`.
 *
 * Episodes arrive newest-first (LongTermStore.listEpisodes). Sessions with no
 * signals are skipped rather than counted as neutral — see the "absent means
 * absent" rule at the top of this file. Ten Hindi sessions and one English one
 * therefore produce a trend of ONE, which the tool reports honestly rather than
 * dressing up as a week.
 */
export function moodTrend(episodes: readonly Episode[]): MoodTrend | null {
  const scored = episodes
    .filter((e) => e.signals?.sentiment)
    .map((e) => ({
      score: e.signals!.sentiment!.score,
      flagged: e.signals!.flagged_intents ?? [],
    }));

  if (scored.length === 0) return null;

  const scores = scored.map((s) => s.score);
  const average = round2(mean(scores));

  // Newest-first, so the RECENT half is the front of the array.
  let direction: MoodTrend["direction"] = "unknown";
  if (scores.length >= MIN_SESSIONS_FOR_DIRECTION) {
    const half = Math.floor(scores.length / 2);
    const delta = mean(scores.slice(0, half)) - mean(scores.slice(half));
    direction = delta > TREND_BAND ? "brighter" : delta < -TREND_BAND ? "lower" : "steady";
  }

  const flagged = [...new Set(scored.flatMap((s) => s.flagged.map((f) => f.intent)))];

  return { sessions: scored.length, average, label: labelFor(average), direction, flagged };
}

// --- Guards ------------------------------------------------------------------

function labelFor(score: number): "positive" | "neutral" | "negative" {
  if (score > SENTIMENT_BREAK) return "positive";
  if (score < -SENTIMENT_BREAK) return "negative";
  return "neutral";
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function pick(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Finite numbers only. NaN and Infinity are missing data wearing a number's clothes. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
