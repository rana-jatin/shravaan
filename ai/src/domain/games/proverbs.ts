/**
 * Finish the saying — the games whose content IS its language.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE CANNOT BE TRANSLATED, AND SO ARE NOT.
 *
 * Half of "अब पछताए होत क्या" is not a question about a bird eating a field. The
 * game is the rhythm and the familiarity — the second half arrives because the
 * first half has been heard a thousand times, in those words. Translate it and
 * you have a comprehension exercise about an unfamiliar metaphor, which is a
 * different and much worse activity.
 *
 * So every question here carries `language`, which means: speak this EXACTLY as
 * written and do not translate it (src/domain/games/types.ts). And it means the
 * kind is offered only where it is authored — `kindsFor` in catalogue.ts drops
 * it in the other nine languages, rather than offering a proverb game that would
 * arrive as nonsense.
 *
 * This is the same rule as "unconfigured means unregistered means never
 * described to the user" (tools/external.ts), applied to content rather than to
 * credentials. The one difference is that it cannot be enforced by the registry:
 * `schemasFor` filters by entitlement and does not know the turn's language, so
 * the tool answers with what it can play instead. See tools/games.ts.
 *
 * ⚠ REGIONAL VARIATION. Proverbs vary by region and by generation more than
 * ordinary copy does, and the accept-lists below carry the phrasings one author
 * knows. A speaker who learned a different second half is RIGHT and will be told
 * they are wrong. Widening these lists is native-speaker work, and is the first
 * thing to do before this kind ships to users.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";
import type { Question } from "./types.ts";

const CATEGORY = "sayings";

const q = (id: string, language: LanguageCode, prompt: string, answers: string[]): Question => ({
  id: `proverb:${id}`,
  kind: "proverbs",
  category: CATEGORY,
  prompt,
  answers,
  language,
});

const EN: readonly Question[] = [
  q("en-stitch", "en-IN", "Finish the saying: a stitch in time saves…", ["nine"]),
  q("en-cooks", "en-IN", "Finish the saying: too many cooks spoil the…", ["broth", "soup"]),
  q("en-chickens", "en-IN", "Finish the saying: don't count your chickens before they…", [
    "hatch",
    "are hatched",
  ]),
  q("en-early-bird", "en-IN", "Finish the saying: the early bird catches the…", ["worm"]),
  q("en-actions", "en-IN", "Finish the saying: actions speak louder than…", ["words"]),
  q("en-rome", "en-IN", "Finish the saying: when in Rome, do as the…", ["Romans do", "Romans"]),
  q("en-picture", "en-IN", "Finish the saying: a picture is worth a thousand…", ["words"]),
  q("en-late", "en-IN", "Finish the saying: better late than…", ["never"]),
  q("en-cloud", "en-IN", "Finish the saying: every cloud has a silver…", ["lining"]),
  q("en-practice", "en-IN", "Finish the saying: practice makes…", ["perfect"]),
];

const HI: readonly Question[] = [
  q("hi-pachtaye", "hi-IN", "कहावत पूरी कीजिए — अब पछताए होत क्या…", [
    "जब चिड़िया चुग गई खेत",
    "चिड़िया चुग गई खेत",
    "चिड़िया चुग गई",
  ]),
  q("hi-nach", "hi-IN", "कहावत पूरी कीजिए — नाच न जाने…", ["आँगन टेढ़ा", "आंगन टेढ़ा"]),
  q("hi-dhol", "hi-IN", "कहावत पूरी कीजिए — दूर के ढोल…", [
    "सुहावने",
    "सुहावने लगते हैं",
    "सुहावने होते हैं",
  ]),
  q("hi-andho", "hi-IN", "कहावत पूरी कीजिए — अंधों में…", ["काना राजा"]),
  q("hi-karni", "hi-IN", "कहावत पूरी कीजिए — जैसी करनी…", ["वैसी भरनी", "वैसी भरणी"]),
  q("hi-taali", "hi-IN", "कहावत पूरी कीजिए — एक हाथ से…", [
    "ताली नहीं बजती",
    "ताली नही बजती",
    "ताली नहीं बजती है",
  ]),
  q("hi-bandar", "hi-IN", "कहावत पूरी कीजिए — बंदर क्या जाने…", [
    "अदरक का स्वाद",
    "अदरक का स्वाद क्या",
  ]),
  q("hi-unt", "hi-IN", "कहावत पूरी कीजिए — ऊँट के मुँह में…", ["जीरा"]),
  q("hi-jal", "hi-IN", "कहावत पूरी कीजिए — जल में रहकर…", ["मगर से बैर", "मगर से वैर"]),
  q("hi-kala-akshar", "hi-IN", "कहावत पूरी कीजिए — काला अक्षर…", ["भैंस बराबर"]),
];

/** Language → the sayings authored in it. A language absent here has no such game. */
export const PROVERBS: Record<LanguageCode, readonly Question[]> = {
  "en-IN": EN,
  "hi-IN": HI,
};
