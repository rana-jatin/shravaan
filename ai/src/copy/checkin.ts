/**
 * Asking somebody how they are, once a day.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HARDEST THING ABOUT THIS COPY IS NOT THE TRANSLATION. It is that the
 * device is not actually asking after their health — it is checking whether
 * anybody is there — and the sentence has to be honest about being a greeting
 * rather than an examination. "Are you feeling unwell today?" invites an answer
 * this system has no business collecting and cannot act on. "Good morning, are
 * you there?" is an interrogation. What is wanted is the thing a person who
 * lives nearby would say through a doorway.
 *
 * SO IT OPENS A CONVERSATION AND MEANS IT. Any reply settles the check-in —
 * "theek hoon", "kaun hai", a complaint about the heat — because the only bit
 * being measured is whether somebody answered. The reply then runs as an
 * ordinary turn, so the companion actually talks to them, which is the point.
 *
 * ⚠ NINE OF ELEVEN LANGUAGES ARE `draft`. Hindi and English are reviewed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { draft, ready, type Catalogue, type ReviewEntry } from "../i18n/types.ts";
import { reviewPending } from "../i18n/resolve.ts";

export type CheckinKey = "ask" | "nudge";

/**
 * `nudge` is not a repeat, and this is the same rule the medication copy
 * follows: saying the identical sentence twenty minutes later tells somebody
 * who did hear the first one that they were not listening, and tells somebody
 * who did not that the device is stuck.
 */
export const CHECKIN_COPY: Catalogue<CheckinKey> = {
  ask: {
    "hi-IN": ready("नमस्ते! आज कैसा लग रहा है आपको?"),
    "en-IN": ready("Hello! How are you doing today?"),
    "bn-IN": draft("নমস্কার! আজ আপনার কেমন লাগছে?"),
    "ta-IN": draft("வணக்கம்! இன்று எப்படி இருக்கிறீர்கள்?"),
    "te-IN": draft("నమస్కారం! ఈ రోజు ఎలా ఉన్నారు?"),
    "gu-IN": draft("નમસ્તે! આજે કેવું લાગે છે?"),
    "kn-IN": draft("ನಮಸ್ಕಾರ! ಇಂದು ಹೇಗಿದ್ದೀರಿ?"),
    "ml-IN": draft("നമസ്കാരം! ഇന്ന് സുഖമാണോ?"),
    "mr-IN": draft("नमस्कार! आज कसं वाटतंय?"),
    "pa-IN": draft("ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਅੱਜ ਕਿਵੇਂ ਲੱਗ ਰਿਹਾ ਹੈ?"),
    "or-IN": draft("ନମସ୍କାର! ଆଜି କେମିତି ଲାଗୁଛି?"),
  },
  nudge: {
    "hi-IN": ready("बस देखने के लिए बोल रहा हूँ — सब ठीक है न?"),
    "en-IN": ready("Just checking in again — is everything all right?"),
    "bn-IN": draft("শুধু আবার দেখে নিচ্ছি — সব ঠিক আছে তো?"),
    "ta-IN": draft("மீண்டும் பார்க்கிறேன் — எல்லாம் நலமா?"),
    "te-IN": draft("మళ్ళీ ఒకసారి చూస్తున్నాను — అంతా బాగుందా?"),
    "gu-IN": draft("ફરી એકવાર પૂછું છું — બધું બરાબર છે ને?"),
    "kn-IN": draft("ಮತ್ತೊಮ್ಮೆ ಕೇಳುತ್ತಿದ್ದೇನೆ — ಎಲ್ಲಾ ಸರಿಯಾಗಿದೆಯೇ?"),
    "ml-IN": draft("ഒന്നുകൂടി ചോദിക്കുന്നു — എല്ലാം ശരിയാണോ?"),
    "mr-IN": draft("पुन्हा एकदा विचारतो — सगळं ठीक आहे ना?"),
    "pa-IN": draft("ਇੱਕ ਵਾਰ ਹੋਰ ਪੁੱਛ ਰਿਹਾ ਹਾਂ — ਸਭ ਠੀਕ ਹੈ ਨਾ?"),
    "or-IN": draft("ପୁଣି ଥରେ ପଚାରୁଛି — ସବୁ ଠିକ୍ ଅଛି ତ?"),
  },
};

/**
 * What the family is told. English, for the same reason the alarm is.
 *
 * ⚠ IT REPORTS SILENCE AND NOTHING ELSE. Not how they sounded, not what they
 * said, not a mood — nothing here reads a reply, and if this message ever grows
 * a sentence about how somebody seemed, that is a wellbeing assessment nobody
 * agreed to and it belongs behind the same consent as care signals (ADR 0009).
 */
export function checkinNotice(input: {
  askedAt: Date;
  timezone: string;
  attempts: number;
  everSpoken: boolean;
}): { subject: string; body: string; short: string } {
  const when = input.askedAt.toLocaleString("en-IN", {
    timeZone: input.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const observed = input.everSpoken
    ? `The device said hello at ${when} and has had no reply since.`
    : `The device could not reach them at all for the ${when} check-in — it was never able to speak.`;

  return {
    subject: "No reply to today's check-in",
    body: [
      observed,
      "",
      "The device only knows that nobody answered it. It does not know where",
      "they are or how they are, and it has not listened to anything to decide",
      "that. They may be out, asleep, or simply not in the room.",
      "",
      `Attempts: ${input.attempts}.`,
      "",
      "A phone call would tell you more than this message can.",
    ].join("\n"),
    short: `No reply to the ${when} check-in. The device heard nothing — a call would tell you more.`,
  };
}

/** For the boot-time review report. */
export function pendingCheckinReview(): ReviewEntry[] {
  return reviewPending("checkin", CHECKIN_COPY);
}
