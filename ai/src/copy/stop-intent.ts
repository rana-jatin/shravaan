/**
 * "Stop the music", in eleven languages, matched LOCALLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT AN LLM TURN, AND MUST NEVER BECOME ONE.
 *
 * While a station plays, the ASR keeps listening — and Saaras will happily
 * transcribe the SONG'S OWN LYRICS as user speech. Route that to the model and
 * the companion starts answering the words of the music: a stream of nonsense
 * turns, each one spending a request against the rate limit ADR 0003 calls the
 * system's concurrency ceiling, each one talking over the song the user asked
 * for.
 *
 * So while media plays the session listens for one thing only, matched against
 * the table below without a network call. Everything else is ignored until the
 * track ends or is stopped.
 *
 * The second reason matters more than the first. Stopping has to WORK — an
 * elderly user shouting at a device that will not stop playing is the worst
 * moment this product can produce, and it is worse than any wrong answer,
 * because it is loud, it is frightening, and they cannot escape it. A local
 * table match is far more robust over a channel full of music than an LLM round
 * trip that may be rate-limited, slow, or confused by the lyrics behind the
 * request.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ REVIEW STATUS. Only `en-IN` and `hi-IN` are considered ready. The other nine
 * are PLACEHOLDERS marked in PENDING_REVIEW below and must be replaced by a
 * native speaker before shipping. This copy carries more risk than the refusals
 * in refusals.ts: a refusal that reads awkwardly is a bad impression, while a
 * stop phrase that is not recognised means the music does not stop.
 *
 * MATCHING IS DELIBERATELY LOOSE. A phrase matches if the transcript CONTAINS
 * it, because ASR over music drops and mangles words, and a user who has said
 * "stop" twice already is not going to enunciate the third time. False positives
 * are cheap — the music stops and they ask for it again. False negatives are the
 * failure above. When in doubt, stop.
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";

/** Languages whose phrases still need a native speaker. */
export const PENDING_REVIEW: LanguageCode[] = [
  "bn-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "pa-IN",
  "or-IN",
];

/**
 * Lowercased substrings. English appears in every list on purpose: code-mixing
 * is first-class in this product, and "stop" is said in English by speakers of
 * all eleven languages.
 */
export const STOP_PHRASES: Record<LanguageCode, string[]> = {
  "en-IN": [
    "stop",
    "turn it off",
    "turn off",
    "switch it off",
    "shut it off",
    "enough",
    "that's enough",
    "quiet",
    "silence",
    "no more music",
    "stop the music",
  ],
  "hi-IN": [
    "stop",
    "band karo",
    "band kar",
    "bandh karo",
    "bas",
    "bas karo",
    "ruko",
    "ruk jao",
    "chup",
    "gaana band",
    "music band",
    "bandh kar do",
  ],
  "bn-IN": ["stop", "bondho koro", "bondho", "thamo", "gaan bondho", "aar na"],
  "ta-IN": ["stop", "niruthu", "niruthunga", "podhum", "paattu niruthu", "off pannu"],
  "te-IN": ["stop", "aapu", "aapandi", "chaalu", "paata aapu", "off cheyyi"],
  "gu-IN": ["stop", "bandh karo", "bandh", "bas", "gaanu bandh"],
  "kn-IN": ["stop", "nilsi", "nillisi", "saaku", "haadu nilsi", "off maadi"],
  "ml-IN": ["stop", "nirthu", "nirthuka", "mathi", "paattu nirthu", "off aakku"],
  "mr-IN": ["stop", "band kara", "band kar", "bas", "purey", "gaane band"],
  "pa-IN": ["stop", "band karo", "band kar", "bas", "hun bas", "gaana band"],
  "or-IN": ["stop", "bandha kara", "bandha", "bas", "gita bandha"],
};

/**
 * Does this transcript ask for the music to stop?
 *
 * Checks the session language AND English, because a Tamil speaker saying
 * "stop" mid-Tamil-conversation is the single most likely phrasing of all and
 * the ASR may well have tagged the turn as Tamil.
 */
export function isStopRequest(text: string, language: LanguageCode): boolean {
  const haystack = text.toLowerCase().trim();
  if (haystack === "") return false;

  const phrases = [...(STOP_PHRASES[language] ?? []), ...(STOP_PHRASES["en-IN"] ?? [])];
  return phrases.some((p) => haystack.includes(p));
}

/**
 * "Turn it down" / "turn it up", same local matching as stop and for the same
 * reason: it must work over the music it is trying to change, without an LLM
 * round trip that the song is actively drowning out.
 *
 * Volume is the request this demographic makes most after "stop", and it is the
 * one that keeps the device usable at all — a companion that can only be at
 * full volume or silent is a companion you switch off.
 *
 * ⚠ Same review status as STOP_PHRASES: en-IN and hi-IN only.
 */
export const QUIETER_PHRASES: Record<LanguageCode, string[]> = {
  "en-IN": [
    "quieter",
    "lower",
    "turn it down",
    "turn down",
    "volume down",
    "too loud",
    "softer",
    "reduce the volume",
    "not so loud",
  ],
  "hi-IN": [
    "dheere",
    "dheere karo",
    "aawaz kam",
    "awaz kam",
    "kam karo",
    "halka karo",
    "volume kam",
    "zor se mat",
    "bahut tez",
  ],
  "bn-IN": ["aste", "kom koro", "awaj kom", "volume kom"],
  "ta-IN": ["kammi", "kuraiyunga", "sathham kammi", "volume kammi"],
  "te-IN": ["thagginchu", "takkuva", "volume thagginchu", "sannaga"],
  "gu-IN": ["dhime", "ochu karo", "awaj ochi", "volume ochu"],
  "kn-IN": ["kammi maadi", "kammi", "shabda kammi", "volume kammi"],
  "ml-IN": ["kuraykku", "kuravu", "shabdam kuraykku", "volume kuraykku"],
  "mr-IN": ["hallu", "kami kara", "awaj kami", "volume kami"],
  "pa-IN": ["hauli", "ghat karo", "awaz ghat", "volume ghat"],
  "or-IN": ["aste", "kam kara", "swara kam", "volume kam"],
};

export const LOUDER_PHRASES: Record<LanguageCode, string[]> = {
  "en-IN": [
    "louder",
    "turn it up",
    "turn up",
    "volume up",
    "too quiet",
    "can't hear",
    "cannot hear",
    "increase the volume",
    "speak up",
  ],
  "hi-IN": [
    "tez karo",
    "zor se",
    "aawaz badhao",
    "awaz badhao",
    "badhao",
    "volume badhao",
    "sunai nahi",
    "tez",
  ],
  "bn-IN": ["jore", "baro koro", "awaj baro", "volume baro"],
  "ta-IN": ["jasti", "athigam", "sathham jasti", "volume jasti"],
  "te-IN": ["penchu", "ekkuva", "volume penchu", "gattiga"],
  "gu-IN": ["motu karo", "vadharo", "awaj vadharo", "volume vadharo"],
  "kn-IN": ["jaasti maadi", "jaasti", "shabda jaasti", "volume jaasti"],
  "ml-IN": ["koottu", "kooduthal", "shabdam koottu", "volume koottu"],
  "mr-IN": ["motha kara", "vadhva", "awaj vadhva", "volume vadhva"],
  "pa-IN": ["uchi", "vadha karo", "awaz vadha", "volume vadha"],
  "or-IN": ["jore", "badhao", "swara badhao", "volume badhao"],
};

/** What the user asked of the player, or null for anything else. */
export type MediaIntent = "stop" | "quieter" | "louder";

/**
 * Match one player intent, locally.
 *
 * ORDER MATTERS. `stop` is checked first and wins ties: "bas" is a stop word in
 * Hindi, and mistaking a stop for a volume change leaves the music playing,
 * which is the failure that must never happen.
 */
export function matchMediaIntent(text: string, language: LanguageCode): MediaIntent | null {
  if (isStopRequest(text, language)) return "stop";

  const haystack = text.toLowerCase().trim();
  if (haystack === "") return null;

  const hit = (table: Record<LanguageCode, string[]>): boolean =>
    [...(table[language] ?? []), ...(table["en-IN"] ?? [])].some((p) => haystack.includes(p));

  // Quieter before louder: "not so loud" contains "loud".
  if (hit(QUIETER_PHRASES)) return "quieter";
  if (hit(LOUDER_PHRASES)) return "louder";
  return null;
}

/** Languages with no reviewed phrases yet. Reported at boot, like the copy tables. */
export function pendingStopReview(): LanguageCode[] {
  return [...PENDING_REVIEW];
}
