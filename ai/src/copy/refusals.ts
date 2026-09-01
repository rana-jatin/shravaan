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

import type { LanguageCode, MessageKey } from "@sp-i/shared/domain/types.ts";

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
    "or-IN": draft(
      " କ୍ଷମା କରନ୍ତୁ, ମୁଁ ଏପର୍ଯ୍ୟନ୍ତ ସେହି ଭାଷାରେ କଥା ହୋଇପାରୁ ନାହିଁ। ମୁଁ ହିନ୍ଦୀ, ଇଂରାଜୀ ଏବଂ ଆଉ ନଅଟି ଭାରତୀୟ ଭାଷାରେ କଥା ହୋଇପାରେ।",
    ),
  },

  "gate.switch_declined": {
    "en-IN": ready(
      "I can't follow you into that language, but I'm happy to keep going in this one.",
    ),
    "hi-IN": ready("उस भाषा में मैं आपका साथ नहीं दे पाऊँगा, पर इसी में बात जारी रख सकते हैं।"),
    "bn-IN": draft("আমি ওই ভাষায় যেতে পারব না, তবে এই ভাষাতেই কথা চালিয়ে যেতে পারি।"),
    "ta-IN": draft("அந்த மொழியில் என்னால் தொடர முடியாது, ஆனால் இதிலேயே பேசலாம்."),
    "te-IN": draft("ఆ భాషలో నేను కొనసాగలేను, కానీ ఇందులోనే మాట్లాడుకుందాం."),
    "gu-IN": draft("એ ભાષામાં હું સાથ નહીં આપી શકું, પણ આમાં વાત ચાલુ રાખી શકીએ."),
    "kn-IN": draft("ಆ ಭಾಷೆಯಲ್ಲಿ ನಾನು ಮುಂದುವರಿಯಲಾರೆ, ಆದರೆ ಇದರಲ್ಲೇ ಮಾತನಾಡೋಣ."),
    "ml-IN": draft("ആ ഭാഷയിൽ എനിക്ക് തുടരാനാവില്ല, പക്ഷേ ഇതിൽ തുടരാം."),
    "mr-IN": draft("त्या भाषेत मी सोबत करू शकत नाही, पण याच भाषेत बोलणे सुरू ठेवू शकतो."),
    "pa-IN": draft("ਉਸ ਭਾਸ਼ਾ ਵਿੱਚ ਮੈਂ ਸਾਥ ਨਹੀਂ ਦੇ ਸਕਦਾ, ਪਰ ਇਸੇ ਵਿੱਚ ਗੱਲ ਜਾਰੀ ਰੱਖ ਸਕਦੇ ਹਾਂ।"),
    "or-IN": draft("ସେହି ଭାଷାରେ ମୁଁ ସାଥ ଦେଇପାରିବି ନାହିଁ, କିନ୍ତୁ ଏଥିରେ କଥା ଜାରି ରଖିପାରିବା।"),
  },

  // ---------------------------------------------------------------------------
  // Slice 8 — the three ways this system can lose the ability to hold a
  // conversation. Only these get spoken; a shallow degradation (no memory, no
  // tools, no profile) is never announced, because a companion filing an
  // operations report is worse than one that is quietly a little thinner today.
  // See src/domain/degradation.ts
  //
  // All three are written to be SHORT. They are the last thing the user hears,
  // they play while something is already broken, and in the voice case they are
  // pre-rendered — every extra clause is another file to regenerate whenever the
  // voice changes.
  // ---------------------------------------------------------------------------

  /**
   * Bulbul is down. THIS ONE CANNOT BE SYNTHESISED — it is rendered ahead of time
   * and shipped as PCM (src/audio/holding-audio.ts). It deliberately does not
   * promise a time, because we do not know one.
   */
  "degraded.voice_unavailable": {
    "en-IN": ready(
      "I'm losing my voice — something's wrong on my end. Let's pick this up again shortly.",
    ),
    "hi-IN": ready("मेरी आवाज़ में कुछ दिक्कत आ रही है। थोड़ी देर बाद फिर बात करते हैं।"),
    "bn-IN": draft("আমার গলায় সমস্যা হচ্ছে। একটু পরে আবার কথা বলি।"),
    "ta-IN": draft("என் குரலில் ஏதோ சிக்கல். சிறிது நேரம் கழித்து மீண்டும் பேசலாம்."),
    "te-IN": draft("నా గొంతులో ఏదో సమస్య వచ్చింది. కొంచెం సేపటి తర్వాత మళ్ళీ మాట్లాడుకుందాం."),
    "gu-IN": draft("મારા અવાજમાં કંઈક તકલીફ થઈ રહી છે. થોડી વાર પછી ફરી વાત કરીએ."),
    "kn-IN": draft("ನನ್ನ ಧ್ವನಿಯಲ್ಲಿ ಏನೋ ತೊಂದರೆಯಾಗಿದೆ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಮಾತನಾಡೋಣ."),
    "ml-IN": draft("എന്റെ ശബ്ദത്തിന് എന്തോ കുഴപ്പമുണ്ട്. അല്പം കഴിഞ്ഞ് വീണ്ടും സംസാരിക്കാം."),
    "mr-IN": draft("माझ्या आवाजात काहीतरी अडचण येतेय. थोड्या वेळाने पुन्हा बोलूया."),
    "pa-IN": draft("ਮੇਰੀ ਆਵਾਜ਼ ਵਿੱਚ ਕੁਝ ਦਿੱਕਤ ਆ ਰਹੀ ਹੈ। ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਫਿਰ ਗੱਲ ਕਰਦੇ ਹਾਂ।"),
    "or-IN": draft("ମୋ ସ୍ୱରରେ କିଛି ଅସୁବିଧା ହେଉଛି। ଟିକେ ପରେ ପୁଣି କଥା ହେବା।"),
  },

  /** ASR is gone. We can still speak, so this one is synthesised normally. */
  "degraded.hearing_unavailable": {
    "en-IN": ready(
      "I can't hear you at the moment — that's my end, not yours. Let's try again in a bit.",
    ),
    "hi-IN": ready(
      "अभी मुझे आपकी आवाज़ नहीं आ रही — गड़बड़ मेरी तरफ़ है। थोड़ी देर में फिर कोशिश करते हैं।",
    ),
    "bn-IN": draft("এখন আপনার কথা শুনতে পাচ্ছি না — সমস্যা আমার দিকে। একটু পরে আবার চেষ্টা করি।"),
    "ta-IN": draft(
      "இப்போது உங்கள் குரல் கேட்கவில்லை — பிரச்சினை என் பக்கம். சிறிது நேரம் கழித்து முயற்சிக்கலாம்.",
    ),
    "te-IN": draft(
      "ప్రస్తుతం మీ మాట వినిపించడం లేదు — సమస్య నా వైపు. కొంచెం సేపటి తర్వాత ప్రయత్నిద్దాం.",
    ),
    "gu-IN": draft(
      "અત્યારે તમારો અવાજ સંભળાતો નથી — તકલીફ મારી બાજુ છે. થોડી વારમાં ફરી પ્રયાસ કરીએ.",
    ),
    "kn-IN": draft(
      "ಈಗ ನಿಮ್ಮ ಧ್ವನಿ ಕೇಳಿಸುತ್ತಿಲ್ಲ — ತೊಂದರೆ ನನ್ನ ಕಡೆ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸೋಣ.",
    ),
    "ml-IN": draft(
      "ഇപ്പോൾ നിങ്ങളുടെ ശബ്ദം കേൾക്കുന്നില്ല — കുഴപ്പം എന്റെ ഭാഗത്താണ്. അല്പം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കാം.",
    ),
    "mr-IN": draft(
      "आत्ता तुमचा आवाज ऐकू येत नाही — अडचण माझ्या बाजूची आहे. थोड्या वेळाने पुन्हा प्रयत्न करूया.",
    ),
    "pa-IN": draft(
      "ਹੁਣ ਮੈਨੂੰ ਤੁਹਾਡੀ ਆਵਾਜ਼ ਨਹੀਂ ਆ ਰਹੀ — ਦਿੱਕਤ ਮੇਰੇ ਪਾਸੇ ਹੈ। ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਫਿਰ ਕੋਸ਼ਿਸ਼ ਕਰਦੇ ਹਾਂ।",
    ),
    "or-IN": draft(
      "ବର୍ତ୍ତମାନ ଆପଣଙ୍କ ସ୍ୱର ଶୁଣି ପାରୁନାହିଁ — ଅସୁବିଧା ମୋ ପଟେ। ଟିକେ ପରେ ପୁଣି ଚେଷ୍ଟା କରିବା।",
    ),
  },

  /**
   * ONE turn failed. The session continues.
   *
   * This is the exception to "only announce what ends the session", and the
   * distinction is worth being precise about: we are not reporting a degraded
   * state, we are answering the turn. The user asked something and is owed a
   * response either way — the same rule as a failed tool call. Silence after a
   * "one moment" filler is the worst of both.
   */
  "degraded.turn_failed": {
    "en-IN": ready("Sorry — I lost that one. Say it again?"),
    "hi-IN": ready("माफ़ कीजिए, वह मुझसे छूट गया। फिर से कहिए?"),
    "bn-IN": draft("দুঃখিত, ওটা ধরতে পারিনি। আবার বলবেন?"),
    "ta-IN": draft("மன்னிக்கவும், அது தவறிவிட்டது. மீண்டும் சொல்லுங்கள்?"),
    "te-IN": draft("క్షమించండి, అది నాకు అందలేదు. మళ్ళీ చెబుతారా?"),
    "gu-IN": draft("માફ કરશો, એ મારાથી છૂટી ગયું. ફરી કહેશો?"),
    "kn-IN": draft("ಕ್ಷಮಿಸಿ, ಅದು ನನಗೆ ಸಿಗಲಿಲ್ಲ. ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?"),
    "ml-IN": draft("ക്ഷമിക്കണം, അത് എനിക്ക് കിട്ടിയില്ല. ഒന്നുകൂടി പറയാമോ?"),
    "mr-IN": draft("क्षमस्व, ते माझ्याकडून सुटलं. पुन्हा सांगाल?"),
    "pa-IN": draft("ਮਾਫ਼ ਕਰਨਾ, ਉਹ ਮੈਥੋਂ ਰਹਿ ਗਿਆ। ਦੁਬਾਰਾ ਕਹੋਗੇ?"),
    "or-IN": draft("କ୍ଷମା କରନ୍ତୁ, ତାହା ମୋ ଠାରୁ ଛାଡ଼ି ଗଲା। ପୁଣି କହିବେ କି?"),
  },

  /**
   * The LLM is unreachable after backoff, repeatedly. Distinct from a single lost
   * turn above: this is said once and the session ends.
   */
  "degraded.thinking_unavailable": {
    "en-IN": ready(
      "My head's gone quiet — I can't put an answer together right now. Let's talk again soon.",
    ),
    "hi-IN": ready("अभी मैं जवाब नहीं बना पा रहा हूँ। थोड़ी देर बाद फिर बात करते हैं।"),
    "bn-IN": draft("এখন আমি উত্তর তৈরি করতে পারছি না। একটু পরে আবার কথা বলি।"),
    "ta-IN": draft("இப்போது என்னால் பதில் தர முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் பேசலாம்."),
    "te-IN": draft(
      "ప్రస్తుతం నేను సమాధానం ఇవ్వలేకపోతున్నాను. కొంచెం సేపటి తర్వాత మళ్ళీ మాట్లాడుకుందాం.",
    ),
    "gu-IN": draft("અત્યારે હું જવાબ આપી શકતો નથી. થોડી વાર પછી ફરી વાત કરીએ."),
    "kn-IN": draft("ಈಗ ನನಗೆ ಉತ್ತರ ಕೊಡಲು ಆಗುತ್ತಿಲ್ಲ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಮಾತನಾಡೋಣ."),
    "ml-IN": draft("ഇപ്പോൾ എനിക്ക് മറുപടി പറയാൻ കഴിയുന്നില്ല. അല്പം കഴിഞ്ഞ് വീണ്ടും സംസാരിക്കാം."),
    "mr-IN": draft("आत्ता मला उत्तर देता येत नाहीये. थोड्या वेळाने पुन्हा बोलूया."),
    "pa-IN": draft("ਹੁਣ ਮੈਂ ਜਵਾਬ ਨਹੀਂ ਬਣਾ ਪਾ ਰਿਹਾ। ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਫਿਰ ਗੱਲ ਕਰਦੇ ਹਾਂ।"),
    "or-IN": draft("ବର୍ତ୍ତମାନ ମୁଁ ଉତ୍ତର ଦେଇପାରୁ ନାହିଁ। ଟିକେ ପରେ ପୁଣି କଥା ହେବା।"),
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
