/**
 * What the device says about a tablet, in eleven languages.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS COPY IS PRE-TRANSLATED BECAUSE THE MODEL IS NOT IN THIS PATH AT ALL.
 * Every other sentence the companion speaks is composed by the LLM in whatever
 * language the turn is in. A reminder is not: it is spoken into a gap in a
 * conversation nobody started, so there is no turn, no prompt and no round.
 *
 * That is a feature and not a limitation. Handing a language model the job of
 * phrasing "take your blue tablet" invites it to add — a dose, a reason, a
 * reassurance about what the tablet does — and none of that is anything this
 * product knows or has any business saying. The device repeats the label the
 * person gave it, and nothing else.
 *
 * SO THE LABEL IS QUOTED, NEVER INTERPRETED. `{label}` is whatever the user
 * called it: "the blue tablet", "my sugar medicine", "Ecosprin". It is not
 * matched against a drug list, not corrected, and not translated — a person who
 * says "blood pressure wali goli" in a Hindi sentence should hear those words
 * back, not a Devanagari rendering of a generic name.
 *
 * ⚠ NINE OF ELEVEN LANGUAGES ARE `draft` AND THE SERVER SAYS SO AT BOOT. Hindi
 * and English are reviewed. The rest are machine-drafted placeholders and are
 * not shippable — this is the same state as the rest of `src/copy/`, and the
 * same warning covers them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { draft, ready, type Catalogue } from "../i18n/types.ts";
import { reviewPending } from "../i18n/resolve.ts";
import type { ReviewEntry } from "../i18n/types.ts";

export type MedicationKey = "reminder" | "nudge";

/**
 * Two lines, and the difference between them matters.
 *
 * `reminder` is the first thing said and assumes nothing. `nudge` comes ten
 * minutes later and has to acknowledge that it is asking again — a device that
 * says the identical sentence twice sounds broken, and a person who did hear
 * the first one is being told they were not listening.
 *
 * Neither asks a question. "Have you taken it?" invites an answer the device
 * then has to interpret, in a language the model is not in the loop for; the
 * `confirm_medication` tool handles the answer whenever it arrives, in the
 * ordinary turn that follows.
 */
export const MEDICATION_COPY: Catalogue<MedicationKey> = {
  reminder: {
    "hi-IN": ready("{label} लेने का समय हो गया है।"),
    "en-IN": ready("It's time for {label}."),
    "bn-IN": draft("{label} নেওয়ার সময় হয়েছে।"),
    "ta-IN": draft("{label} எடுத்துக்கொள்ள வேண்டிய நேரம்."),
    "te-IN": draft("{label} తీసుకోవలసిన సమయం."),
    "gu-IN": draft("{label} લેવાનો સમય થઈ ગયો છે."),
    "kn-IN": draft("{label} ತೆಗೆದುಕೊಳ್ಳುವ ಸಮಯ."),
    "ml-IN": draft("{label} കഴിക്കാനുള്ള സമയമായി."),
    "mr-IN": draft("{label} घेण्याची वेळ झाली आहे."),
    "pa-IN": draft("{label} ਲੈਣ ਦਾ ਸਮਾਂ ਹੋ ਗਿਆ ਹੈ।"),
    "or-IN": draft("{label} ନେବାର ସମୟ ହୋଇଛି।"),
  },
  nudge: {
    "hi-IN": ready("{label} की याद दिला रहा हूँ, अगर अभी तक नहीं ली हो तो।"),
    "en-IN": ready("Just a reminder about {label}, in case you haven't had it yet."),
    "bn-IN": draft("{label} এর কথা মনে করিয়ে দিচ্ছি, যদি এখনও না নিয়ে থাকেন।"),
    "ta-IN": draft("{label} பற்றி நினைவூட்டுகிறேன், இன்னும் எடுக்கவில்லை என்றால்."),
    "te-IN": draft("{label} గురించి గుర్తు చేస్తున్నాను, ఇంకా తీసుకోకపోతే."),
    "gu-IN": draft("{label} ની યાદ અપાવું છું, જો હજી લીધી ન હોય તો."),
    "kn-IN": draft("{label} ಬಗ್ಗೆ ನೆನಪಿಸುತ್ತಿದ್ದೇನೆ, ಇನ್ನೂ ತೆಗೆದುಕೊಳ್ಳದಿದ್ದರೆ."),
    "ml-IN": draft("{label} ഓർമ്മിപ്പിക്കുന്നു, ഇതുവരെ കഴിച്ചിട്ടില്ലെങ്കിൽ."),
    "mr-IN": draft("{label} ची आठवण करून देतो आहे, अजून घेतली नसेल तर."),
    "pa-IN": draft("{label} ਦੀ ਯਾਦ ਦਿਵਾ ਰਿਹਾ ਹਾਂ, ਜੇ ਹਾਲੇ ਨਹੀਂ ਲਈ ਤਾਂ।"),
    "or-IN": draft("{label} ର ମନେ ପକାଉଛି, ଯଦି ଏପର୍ଯ୍ୟନ୍ତ ନେଇ ନାହାନ୍ତି।"),
  },
};

/**
 * What the family is told, and it is in ENGLISH on purpose.
 *
 * The same choice the alarm makes: the recipient's language is not something
 * this system knows, the contact list carries an address and a name and nothing
 * else, and a message in the wrong Indian language is less readable to an adult
 * child abroad than English is. When contacts grow a language preference, this
 * becomes a catalogue like the one above.
 *
 * NOTE WHAT IT DOES NOT CLAIM. Not "they missed their dose" — the device does
 * not know that. Only that it asked and heard nothing back, which is the one
 * thing it actually observed.
 */
export function familyNotice(input: {
  label: string;
  dueAt: Date;
  timezone: string;
  attempts: number;
  everSpoken: boolean;
}): { subject: string; body: string; short: string } {
  const when = input.dueAt.toLocaleString("en-IN", {
    timeZone: input.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const observed = input.everSpoken
    ? `The device reminded them about ${input.label} at ${when} and has had no response since.`
    : `The device could not reach them at all to remind them about ${input.label}, due at ${when}.`;

  return {
    subject: `Unconfirmed: ${input.label}`,
    body: [
      observed,
      "",
      // Said plainly, because the alternative is a family member reading
      // "missed dose" and acting on a claim the device never made.
      "This is not a report that they missed it — the device only knows that it",
      "asked and heard nothing. They may have taken it, or be out of the room.",
      "",
      `Reminders attempted: ${input.attempts}.`,
      "",
      "If this seems wrong, checking on them is the only way to know.",
    ].join("\n"),
    short: `${input.label} at ${when} is unconfirmed — the device heard no response. Please check on them.`,
  };
}

/** For the boot-time review report. */
export function pendingMedicationReview(): ReviewEntry[] {
  return reviewPending("medication", MEDICATION_COPY);
}
