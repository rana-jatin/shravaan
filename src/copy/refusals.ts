/**
 * Refusal copy for the speakability gate.
 *
 * These are the only words some users will ever hear from this product. They are
 * written, not generated, and keyed rather than inlined.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REVIEW STATUS — READ BEFORE SHIPPING
 *
 * Only `en-IN` and `hi-IN` below are considered ready. The other nine are
 * PLACEHOLDERS and are marked `needsNativeReview: true`. They must be replaced by
 * a native speaker before any user hears them. Shipping machine-quality copy as a
 * companion's first words is a bad first impression that no amount of downstream
 * quality recovers.
 *
 * GRAMMATICAL GENDER. Hindi, Marathi, Gujarati, Punjabi and others inflect the
 * verb for the SPEAKER's gender. The correct form therefore depends on which
 * Bulbul voice is configured — "बोल पाता हूँ" (masculine) vs "बोल पाती हूँ"
 * (feminine). The copy below assumes the default masculine voice (`Shubh`).
 * Changing TTS_SPEAKER to a feminine voice REQUIRES revisiting these strings.
 * This is tracked as a real defect risk, not a nicety.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { LanguageCode, MessageKey } from "../domain/types.ts";

export type CopyEntry = {
  text: string;
  needsNativeReview: boolean;
};

type CopyTable = Record<MessageKey, Record<LanguageCode, CopyEntry>>;

const ready = (text: string): CopyEntry => ({ text, needsNativeReview: false });
const draft = (text: string): CopyEntry => ({ text, needsNativeReview: true });

export const COPY: CopyTable = {
  "gate.unsupported_language": {
    "en-IN": ready(
      "Sorry — I can't speak that language yet. I can talk in Hindi, English, and nine other Indian languages. Would any of those work?",
    ),
    "hi-IN": ready(
      "माफ़ कीजिए, मैं अभी वह भाषा नहीं बोल पाता। मैं हिन्दी, अंग्रेज़ी और नौ और भारतीय भाषाओं में बात कर सकता हूँ। क्या इनमें से कोई ठीक रहेगी?",
    ),
    "bn-IN": draft(
      "দুঃখিত, আমি এখনও সেই ভাষায় কথা বলতে পারি না। আমি হিন্দি, ইংরেজি এবং আরও নয়টি ভারতীয় ভাষায় কথা বলতে পারি।",
    ),
    "ta-IN": draft(
      "மன்னிக்கவும், என்னால் இன்னும் அந்த மொழியில் பேச முடியாது. நான் இந்தி, ஆங்கிலம் மற்றும் மேலும் ஒன்பது இந்திய மொழிகளில் பேச முடியும்.",
    ),
    "te-IN": draft(
      "క్షమించండి, నేను ఇంకా ఆ భాషలో మాట్లాడలేను. నేను హిందీ, ఇంగ్లీష్ మరియు మరో తొమ్మిది భారతీయ భాషల్లో మాట్లాడగలను.",
    ),
    "gu-IN": draft(
      "માફ કરશો, હું હજી એ ભાષા બોલી શકતો નથી. હું હિન્દી, અંગ્રેજી અને બીજી નવ ભારતીય ભાષાઓમાં વાત કરી શકું છું.",
    ),
    "kn-IN": draft(
      "ಕ್ಷಮಿಸಿ, ನನಗೆ ಇನ್ನೂ ಆ ಭಾಷೆಯಲ್ಲಿ ಮಾತನಾಡಲು ಬರುವುದಿಲ್ಲ. ನಾನು ಹಿಂದಿ, ಇಂಗ್ಲಿಷ್ ಮತ್ತು ಇನ್ನೂ ಒಂಬತ್ತು ಭಾರತೀಯ ಭಾಷೆಗಳಲ್ಲಿ ಮಾತನಾಡಬಲ್ಲೆ.",
    ),
    "ml-IN": draft(
      "ക്ഷമിക്കണം, എനിക്ക് ഇതുവരെ ആ ഭാഷ സംസാരിക്കാൻ കഴിയില്ല. എനിക്ക് ഹിന്ദി, ഇംഗ്ലീഷ്, മറ്റ് ഒമ്പത് ഇന്ത്യൻ ഭാഷകളിൽ സംസാരിക്കാൻ കഴിയും.",
    ),
    "mr-IN": draft(
      "क्षमस्व, मला अजून ती भाषा बोलता येत नाही. मी हिंदी, इंग्रजी आणि आणखी नऊ भारतीय भाषांमध्ये बोलू शकतो.",
    ),
    "pa-IN": draft(
      "ਮਾਫ਼ ਕਰਨਾ, ਮੈਂ ਅਜੇ ਉਹ ਭਾਸ਼ਾ ਨਹੀਂ ਬੋਲ ਸਕਦਾ। ਮੈਂ ਹਿੰਦੀ, ਅੰਗਰੇਜ਼ੀ ਅਤੇ ਹੋਰ ਨੌਂ ਭਾਰਤੀ ਭਾਸ਼ਾਵਾਂ ਵਿੱਚ ਗੱਲ ਕਰ ਸਕਦਾ ਹਾਂ।",
    ),
    "od-IN": draft(
      " କ୍ଷମା କରନ୍ତୁ, ମୁଁ ଏପର୍ଯ୍ୟନ୍ତ ସେହି ଭାଷାରେ କଥା ହୋଇପାରୁ ନାହିଁ। ମୁଁ ହିନ୍ଦୀ, ଇଂରାଜୀ ଏବଂ ଆଉ ନଅଟି ଭାରତୀୟ ଭାଷାରେ କଥା ହୋଇପାରେ।",
    ),
  },

  "gate.switch_declined": {
    "en-IN": ready("I can't follow you into that language, but I'm happy to keep going in this one."),
    "hi-IN": ready("उस भाषा में मैं आपका साथ नहीं दे पाऊँगा, पर इसी में बात जारी रख सकते हैं।"),
    "bn-IN": draft("আমি ওই ভাষায় যেতে পারব না, তবে এই ভাষাতেই কথা চালিয়ে যেতে পারি।"),
    "ta-IN": draft("அந்த மொழியில் என்னால் தொடர முடியாது, ஆனால் இதிலேயே பேசலாம்."),
    "te-IN": draft("ఆ భాషలో నేను కొనసాగలేను, కానీ ఇందులోనే మాట్లాడుకుందాం."),
    "gu-IN": draft("એ ભાષામાં હું સાથ નહીં આપી શકું, પણ આમાં વાત ચાલુ રાખી શકીએ."),
    "kn-IN": draft("ಆ ಭಾಷೆಯಲ್ಲಿ ನಾನು ಮುಂದುವರಿಯಲಾರೆ, ಆದರೆ ಇದರಲ್ಲೇ ಮಾತನಾಡೋಣ."),
    "ml-IN": draft("ആ ഭാഷയിൽ എനിക്ക് തുടരാനാവില്ല, പക്ഷേ ഇതിൽ തുടരാം."),
    "mr-IN": draft("त्या भाषेत मी सोबत करू शकत नाही, पण याच भाषेत बोलणे सुरू ठेवू शकतो."),
    "pa-IN": draft("ਉਸ ਭਾਸ਼ਾ ਵਿੱਚ ਮੈਂ ਸਾਥ ਨਹੀਂ ਦੇ ਸਕਦਾ, ਪਰ ਇਸੇ ਵਿੱਚ ਗੱਲ ਜਾਰੀ ਰੱਖ ਸਕਦੇ ਹਾਂ।"),
    "od-IN": draft("ସେହି ଭାଷାରେ ମୁଁ ସାଥ ଦେଇପାରିବି ନାହିଁ, କିନ୍ତୁ ଏଥିରେ କଥା ଜାରି ରଖିପାରିବା।"),
  },
};

/**
 * Resolve copy. Falls back down the ladder rather than throwing — a missing
 * translation must never become silence.
 */
export function resolveCopy(key: MessageKey, language: LanguageCode): CopyEntry {
  const table = COPY[key];
  return table[language] ?? table["hi-IN"] ?? table["en-IN"]!;
}

/** Languages whose copy is still placeholder text. Surfaced at boot. */
export function pendingNativeReview(): Array<{ key: MessageKey; language: LanguageCode }> {
  const out: Array<{ key: MessageKey; language: LanguageCode }> = [];
  for (const key of Object.keys(COPY) as MessageKey[]) {
    for (const [language, entry] of Object.entries(COPY[key])) {
      if (entry.needsNativeReview) out.push({ key, language });
    }
  }
  return out;
}
