/**
 * What the device says after a reading nobody looked at.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ NOT ONE OF THESE SENTENCES CONTAINS A NUMBER, AND NONE OF THEM EVER WILL.
 * The alert that triggered this knows the metric, the value and which bound it
 * crossed. The person is told none of it. "Your heart rate is one hundred and
 * ninety-five" spoken into a quiet room to somebody on their own is a device
 * frightening a person about a reading it cannot interpret, on the strength of
 * a wristband that may have slipped.
 *
 * SO THE QUESTION IS THE POINT, not the reading. Everything this path can
 * usefully learn is whether they are all right, and that is a question anyone
 * can answer. The number goes to the family, who can act on it; the person
 * gets asked how they are.
 *
 * A FALL GETS ITS OWN WORDS, and it is the one place vagueness would be worse
 * than specificity. "I noticed something" after somebody has gone down is a
 * device being coy at the moment that matters most — naming it lets them
 * answer "no, I dropped the band", which is the commonest true answer, and
 * tells somebody who really has fallen that the device knows.
 *
 * ⚠ NINE OF ELEVEN LANGUAGES ARE `draft`. Hindi and English are reviewed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { draft, ready, type Catalogue, type ReviewEntry } from "../i18n/types.ts";
import { reviewPending } from "../i18n/resolve.ts";

export type VitalsKey = "ask_reading" | "nudge_reading" | "ask_fall" | "nudge_fall";

export const VITALS_COPY: Catalogue<VitalsKey> = {
  /**
   * After a reading fell outside its band. Deliberately gives no reason: there
   * is no reason that can be given honestly in one sentence, and the honest
   * long version ("a sensor reported a number outside a range we chose") is
   * not something to say to somebody at eleven at night.
   */
  ask_reading: {
    "hi-IN": ready("मैं बस देखना चाहता था — आप ठीक महसूस कर रहे हैं?"),
    "en-IN": ready("I just wanted to check — are you feeling all right?"),
    "bn-IN": draft("আমি শুধু দেখতে চাইছিলাম — আপনি ভালো আছেন তো?"),
    "ta-IN": draft("சும்மா பார்க்க நினைத்தேன் — நீங்கள் நலமாக இருக்கிறீர்களா?"),
    "te-IN": draft("ఒకసారి చూద్దామని — మీరు బాగానే ఉన్నారా?"),
    "gu-IN": draft("બસ જોવા માંગતો હતો — તમે ઠીક લાગો છો?"),
    "kn-IN": draft("ಸುಮ್ಮನೆ ನೋಡೋಣ ಅಂತ — ನೀವು ಚೆನ್ನಾಗಿದ್ದೀರಾ?"),
    "ml-IN": draft("ഒന്ന് നോക്കാമെന്ന് കരുതി — സുഖമാണോ?"),
    "mr-IN": draft("मला फक्त बघायचं होतं — तुम्हाला बरं वाटतंय ना?"),
    "pa-IN": draft("ਮੈਂ ਬੱਸ ਵੇਖਣਾ ਚਾਹੁੰਦਾ ਸੀ — ਤੁਸੀਂ ਠੀਕ ਮਹਿਸੂਸ ਕਰ ਰਹੇ ਹੋ?"),
    "or-IN": draft("ମୁଁ କେବଳ ଦେଖିବାକୁ ଚାହୁଁଥିଲି — ଆପଣ ଭଲ ଅନୁଭବ କରୁଛନ୍ତି ତ?"),
  },
  nudge_reading: {
    "hi-IN": ready("फिर से पूछ रहा हूँ — सब ठीक है न? कुछ कहिए।"),
    "en-IN": ready("Asking once more — is everything all right? Say something if you can."),
    "bn-IN": draft("আবার জিজ্ঞেস করছি — সব ঠিক আছে তো? কিছু বলুন।"),
    "ta-IN": draft("மீண்டும் கேட்கிறேன் — எல்லாம் நலமா? ஏதாவது சொல்லுங்கள்."),
    "te-IN": draft("మళ్ళీ అడుగుతున్నాను — అంతా బాగుందా? ఏదైనా చెప్పండి."),
    "gu-IN": draft("ફરી પૂછું છું — બધું બરાબર છે ને? કંઈક કહો."),
    "kn-IN": draft("ಮತ್ತೊಮ್ಮೆ ಕೇಳುತ್ತಿದ್ದೇನೆ — ಎಲ್ಲಾ ಸರಿಯಾಗಿದೆಯೇ? ಏನಾದರೂ ಹೇಳಿ."),
    "ml-IN": draft("ഒന്നുകൂടി ചോദിക്കുന്നു — എല്ലാം ശരിയാണോ? എന്തെങ്കിലും പറയൂ."),
    "mr-IN": draft("पुन्हा विचारतो — सगळं ठीक आहे ना? काहीतरी बोला."),
    "pa-IN": draft("ਇੱਕ ਵਾਰ ਹੋਰ ਪੁੱਛ ਰਿਹਾ ਹਾਂ — ਸਭ ਠੀਕ ਹੈ ਨਾ? ਕੁਝ ਕਹੋ।"),
    "or-IN": draft("ପୁଣି ଥରେ ପଚାରୁଛି — ସବୁ ଠିକ୍ ଅଛି ତ? କିଛି କୁହନ୍ତୁ।"),
  },
  /**
   * After a fall was reported. Names it, because "I noticed something" at that
   * moment is a device being coy — and because "no, I dropped it" is the
   * commonest true answer and needs to be easy to give.
   */
  ask_fall: {
    "hi-IN": ready("लगा कि आप गिर गए हों — आप ठीक हैं? चोट तो नहीं लगी?"),
    "en-IN": ready("It looked like you may have had a fall — are you all right? Are you hurt?"),
    "bn-IN": draft("মনে হল আপনি পড়ে গেছেন — আপনি ঠিক আছেন? লেগেছে কি?"),
    "ta-IN": draft("நீங்கள் விழுந்தது போல் தெரிந்தது — நலமா? அடிபட்டதா?"),
    "te-IN": draft("మీరు పడిపోయినట్టు అనిపించింది — మీరు బాగానే ఉన్నారా? దెబ్బ తగిలిందా?"),
    "gu-IN": draft("લાગ્યું કે તમે પડી ગયા — તમે ઠીક છો? વાગ્યું તો નથી ને?"),
    "kn-IN": draft("ನೀವು ಬಿದ್ದಂತೆ ಅನಿಸಿತು — ನೀವು ಚೆನ್ನಾಗಿದ್ದೀರಾ? ಪೆಟ್ಟಾಯಿತೇ?"),
    "ml-IN": draft("നിങ്ങൾ വീണതായി തോന്നി — സുഖമാണോ? പരിക്കുണ്ടോ?"),
    "mr-IN": draft("तुम्ही पडलात असं वाटलं — तुम्ही ठीक आहात? लागलं तर नाही ना?"),
    "pa-IN": draft("ਲੱਗਿਆ ਕਿ ਤੁਸੀਂ ਡਿੱਗ ਪਏ — ਤੁਸੀਂ ਠੀਕ ਹੋ? ਸੱਟ ਤਾਂ ਨਹੀਂ ਲੱਗੀ?"),
    "or-IN": draft("ମନେ ହେଲା ଆପଣ ପଡ଼ିଯାଇଛନ୍ତି — ଆପଣ ଠିକ୍ ଅଛନ୍ତି? ଆଘାତ ଲାଗିଛି କି?"),
  },
  nudge_fall: {
    "hi-IN": ready("अभी भी कोई जवाब नहीं मिला। अगर सुन रहे हैं तो कुछ बोलिए।"),
    "en-IN": ready("I still haven't heard from you. Please say something if you can hear me."),
    "bn-IN": draft("এখনও কোনো সাড়া পাইনি। শুনতে পেলে কিছু বলুন।"),
    "ta-IN": draft("இன்னும் பதில் இல்லை. கேட்டால் ஏதாவது சொல்லுங்கள்."),
    "te-IN": draft("ఇంకా జవాబు రాలేదు. వినిపిస్తే ఏదైనా చెప్పండి."),
    "gu-IN": draft("હજી કોઈ જવાબ મળ્યો નથી. સંભળાય તો કંઈક કહો."),
    "kn-IN": draft("ಇನ್ನೂ ಉತ್ತರ ಬಂದಿಲ್ಲ. ಕೇಳಿಸಿದರೆ ಏನಾದರೂ ಹೇಳಿ."),
    "ml-IN": draft("ഇതുവരെ മറുപടി കിട്ടിയില്ല. കേൾക്കുന്നുണ്ടെങ്കിൽ എന്തെങ്കിലും പറയൂ."),
    "mr-IN": draft("अजून काही उत्तर मिळालं नाही. ऐकू येत असेल तर काहीतरी बोला."),
    "pa-IN": draft("ਹਾਲੇ ਤੱਕ ਕੋਈ ਜਵਾਬ ਨਹੀਂ ਮਿਲਿਆ। ਜੇ ਸੁਣ ਰਹੇ ਹੋ ਤਾਂ ਕੁਝ ਬੋਲੋ।"),
    "or-IN": draft("ଏପର୍ଯ୍ୟନ୍ତ କୌଣସି ଉତ୍ତର ମିଳିନାହିଁ। ଶୁଣୁଥିଲେ କିଛି କୁହନ୍ତୁ।"),
  },
};

/** Which pair of lines an alert of this kind uses. */
export function copyKeysFor(kind: "fall" | "anomaly"): {
  ask: VitalsKey;
  nudge: VitalsKey;
} {
  return kind === "fall"
    ? { ask: "ask_fall", nudge: "nudge_fall" }
    : { ask: "ask_reading", nudge: "nudge_reading" };
}

/** One out-of-range value, as the safety service described it. */
export type ObservedReading = {
  metric: string;
  value: number;
  direction: string;
  threshold: number;
};

/**
 * What the family is told. English, for the same reason the alarm is.
 *
 * ⚠ THIS ONE DOES CARRY THE NUMBERS, and the asymmetry is the design rather
 * than an inconsistency. The person is asked how they are because a reading is
 * not something they can act on and not something this device can interpret
 * for them. The family can act on it — they can decide whether it is worth a
 * phone call or a doctor, which is a judgement a person makes and a range
 * check cannot.
 *
 * It still claims nothing. "Outside the range the device watches for" is the
 * whole of what happened; "high", "abnormal" and "concerning" are conclusions
 * nothing here is entitled to draw.
 */
export function vitalsNotice(input: {
  kind: "fall" | "anomaly";
  observedAt: Date;
  timezone: string;
  readings: readonly ObservedReading[];
  attempts: number;
  everSpoken: boolean;
}): { subject: string; body: string; short: string } {
  const when = input.observedAt.toLocaleString("en-IN", {
    timeZone: input.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const what =
    input.kind === "fall"
      ? `Their device reported a possible fall at ${when}.`
      : `A reading at ${when} fell outside the range the device watches for.`;

  const asked = input.everSpoken
    ? "The device asked how they were and has had no reply."
    : "The device could not reach them at all to ask — it was never able to speak.";

  const detail =
    input.readings.length === 0
      ? []
      : ["", "What was recorded:", ...input.readings.map(describeReading)];

  return {
    subject: input.kind === "fall" ? "Possible fall, no reply" : "Unusual reading, no reply",
    body: [
      what,
      asked,
      ...detail,
      "",
      // The sentence that stops this being read as a diagnosis. A family
      // member glancing at a phone reads the subject and one line.
      "This is not a diagnosis and the device has not decided anything is",
      input.kind === "fall"
        ? "wrong. Fall detection is often wrong, and a dropped device looks the same."
        : "wrong. A loose strap or a cold finger produces readings like this.",
      "",
      `Attempts to reach them: ${input.attempts}.`,
      "",
      "A phone call would tell you more than this message can.",
    ].join("\n"),
    short:
      input.kind === "fall"
        ? `Possible fall at ${when} and no reply from them. Please call — the device cannot tell you more.`
        : `An unusual reading at ${when} and no reply from them. Please call — the device cannot tell you more.`,
  };
}

/** `heart rate 195 bpm, above 180`. Facts, in that order, and no adjective. */
function describeReading(reading: ObservedReading): string {
  const name = reading.metric.replace(/_/g, " ");
  return `  ${name}: ${reading.value} (${reading.direction === "low" ? "below" : "above"} ${reading.threshold})`;
}

/** For the boot-time review report. */
export function pendingVitalsReview(): ReviewEntry[] {
  return reviewPending("vitals", VITALS_COPY);
}
