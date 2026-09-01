/**
 * Spoken fillers and tool-failure fallbacks.
 *
 * SAME REVIEW STATUS AS src/copy/refusals.ts: only `en-IN` and `hi-IN` are
 * considered ready. The rest are placeholders flagged `needsNativeReview`, and
 * the same grammatical-gender caveat applies — Hindi, Marathi, Gujarati and
 * Punjabi inflect the verb for the SPEAKER's gender, so these strings depend on
 * which Bulbul voice is configured. They assume the default masculine `Shubh`.
 *
 * Fillers rotate rather than repeating one phrase. A companion that says the
 * identical words every single time it waits stops sounding like a person very
 * quickly.
 */

import type { LanguageCode } from "../domain/types.ts";
import type { FallbackKey, ProgressKey } from "../tools/types.ts";

export type CopySet = { variants: string[]; needsNativeReview: boolean };

const ready = (...variants: string[]): CopySet => ({ variants, needsNativeReview: false });
const draft = (...variants: string[]): CopySet => ({ variants, needsNativeReview: true });

/** Spoken while a slow tool runs. Short by design — it buys time, not attention. */
export const FILLERS: Record<LanguageCode, CopySet> = {
  "en-IN": ready("One moment.", "Let me check.", "Just a second."),
  "hi-IN": ready("एक मिनट।", "मैं देखता हूँ।", "ज़रा रुकिए।"),
  "bn-IN": draft("এক মুহূর্ত।", "আমি দেখছি।"),
  "ta-IN": draft("ஒரு நிமிடம்.", "நான் பார்க்கிறேன்."),
  "te-IN": draft("ఒక నిమిషం.", "నేను చూస్తాను."),
  "gu-IN": draft("એક મિનિટ.", "હું જોઉં છું."),
  "kn-IN": draft("ಒಂದು ನಿಮಿಷ.", "ನಾನು ನೋಡುತ್ತೇನೆ."),
  "ml-IN": draft("ഒരു നിമിഷം.", "ഞാൻ നോക്കട്ടെ."),
  "mr-IN": draft("एक मिनिट.", "मी बघतो."),
  "pa-IN": draft("ਇੱਕ ਮਿੰਟ।", "ਮੈਂ ਵੇਖਦਾ ਹਾਂ।"),
  "or-IN": draft("ଏକ ମିନିଟ୍।", "ମୁଁ ଦେଖୁଛି।"),
};

/**
 * What the agent says when a tool fails.
 *
 * Never surfaces the error code or upstream message — those are for logs. The
 * user needs to know what happened to *them*, not what happened to us.
 */
export const FALLBACKS: Record<FallbackKey, Record<LanguageCode, CopySet>> = {
  "tool.timeout": {
    "en-IN": ready("That's taking longer than it should — shall we try again in a moment?"),
    "hi-IN": ready("इसमें ज़्यादा समय लग रहा है — थोड़ी देर में फिर कोशिश करें?"),
    "bn-IN": draft("এটা একটু বেশি সময় নিচ্ছে — একটু পরে আবার চেষ্টা করি?"),
    "ta-IN": draft(
      "இது எதிர்பார்த்ததை விட நேரம் எடுக்கிறது — சிறிது நேரம் கழித்து முயற்சிக்கலாமா?",
    ),
    "te-IN": draft("ఇది ఎక్కువ సమయం తీసుకుంటోంది — కొంచెం సేపటి తర్వాత మళ్ళీ ప్రయత్నిద్దామా?"),
    "gu-IN": draft("આમાં વધારે સમય લાગી રહ્યો છે — થોડી વારમાં ફરી પ્રયાસ કરીએ?"),
    "kn-IN": draft("ಇದು ಹೆಚ್ಚು ಸಮಯ ತೆಗೆದುಕೊಳ್ಳುತ್ತಿದೆ — ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸೋಣವೇ?"),
    "ml-IN": draft("ഇത് കുറച്ച് സമയമെടുക്കുന്നു — അല്പം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കാമോ?"),
    "mr-IN": draft("याला जास्त वेळ लागतोय — थोड्या वेळाने पुन्हा प्रयत्न करूया?"),
    "pa-IN": draft("ਇਸ ਵਿੱਚ ਜ਼ਿਆਦਾ ਸਮਾਂ ਲੱਗ ਰਿਹਾ ਹੈ — ਥੋੜ੍ਹੀ ਦੇਰ ਬਾਅਦ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੀਏ?"),
    "or-IN": draft("ଏଥିରେ ଅଧିକ ସମୟ ଲାଗୁଛି — ଟିକେ ପରେ ପୁଣି ଚେଷ୍ଟା କରିବା?"),
  },
  "tool.unavailable": {
    "en-IN": ready("I can't reach that right now. Can I help with something else?"),
    "hi-IN": ready("अभी वह उपलब्ध नहीं है। किसी और चीज़ में मदद करूँ?"),
    "bn-IN": draft("এখন ওটায় পৌঁছাতে পারছি না। অন্য কিছুতে সাহায্য করব?"),
    "ta-IN": draft("இப்போது அதை அணுக முடியவில்லை. வேறு ஏதாவது உதவி வேண்டுமா?"),
    "te-IN": draft("ప్రస్తుతం అది అందుబాటులో లేదు. వేరే ఏదైనా సహాయం కావాలా?"),
    "gu-IN": draft("અત્યારે એ ઉપલબ્ધ નથી. બીજું કંઈ મદદ કરું?"),
    "kn-IN": draft("ಈಗ ಅದು ಲಭ್ಯವಿಲ್ಲ. ಬೇರೇನಾದರೂ ಸಹಾಯ ಬೇಕೇ?"),
    "ml-IN": draft("ഇപ്പോൾ അത് ലഭ്യമല്ല. മറ്റെന്തെങ്കിലും സഹായിക്കട്ടെ?"),
    "mr-IN": draft("सध्या ते उपलब्ध नाही. दुसरं काही मदत करू?"),
    "pa-IN": draft("ਹੁਣ ਉਹ ਉਪਲਬਧ ਨਹੀਂ ਹੈ। ਹੋਰ ਕਿਸੇ ਚੀਜ਼ ਵਿੱਚ ਮਦਦ ਕਰਾਂ?"),
    "or-IN": draft("ବର୍ତ୍ତମାନ ତାହା ଉପଲବ୍ଧ ନାହିଁ। ଅନ୍ୟ କିଛିରେ ସାହାଯ୍ୟ କରିବି?"),
  },
  "tool.not_entitled": {
    "en-IN": ready("That isn't something I can do on your account."),
    "hi-IN": ready("यह आपके अकाउंट पर मैं नहीं कर सकता।"),
    "bn-IN": draft("এটা আপনার অ্যাকাউন্টে আমি করতে পারি না।"),
    "ta-IN": draft("இதை உங்கள் கணக்கில் என்னால் செய்ய முடியாது."),
    "te-IN": draft("ఇది మీ ఖాతాలో నేను చేయలేను."),
    "gu-IN": draft("આ તમારા ખાતામાં હું કરી શકતો નથી."),
    "kn-IN": draft("ಇದನ್ನು ನಿಮ್ಮ ಖಾತೆಯಲ್ಲಿ ನಾನು ಮಾಡಲಾಗುವುದಿಲ್ಲ."),
    "ml-IN": draft("ഇത് നിങ്ങളുടെ അക്കൗണ്ടിൽ എനിക്ക് ചെയ്യാൻ കഴിയില്ല."),
    "mr-IN": draft("हे तुमच्या खात्यावर मी करू शकत नाही."),
    "pa-IN": draft("ਇਹ ਤੁਹਾਡੇ ਖਾਤੇ 'ਤੇ ਮੈਂ ਨਹੀਂ ਕਰ ਸਕਦਾ।"),
    "or-IN": draft("ଏହା ଆପଣଙ୍କ ଖାତାରେ ମୁଁ କରିପାରିବି ନାହିଁ।"),
  },
  "tool.invalid_args": {
    "en-IN": ready("I didn't quite catch the details — could you say that again?"),
    "hi-IN": ready("मुझे पूरी जानकारी नहीं मिली — फिर से बताइएगा?"),
    "bn-IN": draft("বিস্তারিত ঠিক বুঝিনি — আবার বলবেন?"),
    "ta-IN": draft("விவரங்கள் சரியாகப் புரியவில்லை — மீண்டும் சொல்கிறீர்களா?"),
    "te-IN": draft("వివరాలు సరిగ్గా అర్థం కాలేదు — మళ్ళీ చెబుతారా?"),
    "gu-IN": draft("વિગતો બરાબર સમજાઈ નહીં — ફરી કહેશો?"),
    "kn-IN": draft("ವಿವರಗಳು ಸರಿಯಾಗಿ ಅರ್ಥವಾಗಲಿಲ್ಲ — ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?"),
    "ml-IN": draft("വിശദാംശങ്ങൾ ശരിക്ക് മനസ്സിലായില്ല — ഒന്നുകൂടി പറയാമോ?"),
    "mr-IN": draft("तपशील नीट समजले नाहीत — पुन्हा सांगाल?"),
    "pa-IN": draft("ਵੇਰਵੇ ਠੀਕ ਸਮਝ ਨਹੀਂ ਆਏ — ਦੁਬਾਰਾ ਦੱਸੋਗੇ?"),
    "or-IN": draft("ବିବରଣୀ ଠିକ୍ ବୁଝି ପାରିଲି ନାହିଁ — ପୁଣି କହିବେ କି?"),
  },
  "tool.generic": {
    "en-IN": ready("Something went wrong there. Shall we try something else?"),
    "hi-IN": ready("वहाँ कुछ गड़बड़ हो गई। कुछ और देखें?"),
    "bn-IN": draft("ওখানে কিছু একটা সমস্যা হয়েছে। অন্য কিছু দেখব?"),
    "ta-IN": draft("அங்கே ஏதோ தவறு நடந்தது. வேறு ஏதாவது பார்க்கலாமா?"),
    "te-IN": draft("అక్కడ ఏదో తప్పు జరిగింది. వేరే ఏదైనా చూద్దామా?"),
    "gu-IN": draft("ત્યાં કંઈક ખોટું થયું. બીજું કંઈ જોઈએ?"),
    "kn-IN": draft("ಅಲ್ಲಿ ಏನೋ ತಪ್ಪಾಯಿತು. ಬೇರೇನಾದರೂ ನೋಡೋಣವೇ?"),
    "ml-IN": draft("അവിടെ എന്തോ പിഴച്ചു. മറ്റെന്തെങ്കിലും നോക്കാമോ?"),
    "mr-IN": draft("तिथे काहीतरी चुकलं. दुसरं काही बघूया?"),
    "pa-IN": draft("ਉੱਥੇ ਕੁਝ ਗਲਤ ਹੋ ਗਿਆ। ਹੋਰ ਕੁਝ ਵੇਖੀਏ?"),
    "or-IN": draft("ସେଠାରେ କିଛି ଭୁଲ୍ ହେଲା। ଅନ୍ୟ କିଛି ଦେଖିବା?"),
  },
};

/**
 * Spoken while a specific slow tool runs, in place of the generic filler.
 *
 * WHY THESE EXIST WHEN THE MODEL USUALLY SPEAKS FIRST. The prompt now asks the
 * model to announce its own tool calls and gets that about 78% of the time (the
 * measurements are in SYSTEM_PROMPT). Its line is better than anything here —
 * specific to the question, and genuinely fluent in the nine languages where
 * these are still placeholder text.
 *
 * These are the other 22%. Roughly one tool turn in four still begins in
 * silence, and that is the turn these were written for.
 *
 * These are for the external tools in the plan, none of which exist yet. Written
 * ahead of the tools on the same principle as the pre-rendered outage audio: the
 * moment you need the words is the worst moment to be writing them.
 *
 * Phrased as a person, not a process. "Fetching weather data" is a machine
 * describing itself; "let me check the weather" is someone helping you.
 */
export const PROGRESS: Record<ProgressKey, Record<LanguageCode, CopySet>> = {
  "progress.weather": {
    "en-IN": ready("Let me check the weather.", "Just looking that up."),
    "hi-IN": ready("मैं मौसम देखता हूँ।", "ज़रा देखता हूँ।"),
    "bn-IN": draft("আমি আবহাওয়া দেখছি।"),
    "ta-IN": draft("வானிலையைப் பார்க்கிறேன்."),
    "te-IN": draft("వాతావరణం చూస్తాను."),
    "gu-IN": draft("હું હવામાન જોઉં છું."),
    "kn-IN": draft("ಹವಾಮಾನ ನೋಡುತ್ತೇನೆ."),
    "ml-IN": draft("കാലാവസ്ഥ നോക്കട്ടെ."),
    "mr-IN": draft("मी हवामान बघतो."),
    "pa-IN": draft("ਮੈਂ ਮੌਸਮ ਵੇਖਦਾ ਹਾਂ।"),
    "or-IN": draft("ମୁଁ ପାଣିପାଗ ଦେଖୁଛି।"),
  },
  "progress.news": {
    "en-IN": ready("Let me see what's happening.", "Checking the news now."),
    "hi-IN": ready("मैं ख़बरें देखता हूँ।", "ज़रा ख़बर देखता हूँ।"),
    "bn-IN": draft("আমি খবর দেখছি।"),
    "ta-IN": draft("செய்திகளைப் பார்க்கிறேன்."),
    "te-IN": draft("వార్తలు చూస్తాను."),
    "gu-IN": draft("હું સમાચાર જોઉં છું."),
    "kn-IN": draft("ಸುದ್ದಿ ನೋಡುತ್ತೇನೆ."),
    "ml-IN": draft("വാർത്ത നോക്കട്ടെ."),
    "mr-IN": draft("मी बातम्या बघतो."),
    "pa-IN": draft("ਮੈਂ ਖ਼ਬਰਾਂ ਵੇਖਦਾ ਹਾਂ।"),
    "or-IN": draft("ମୁଁ ଖବର ଦେଖୁଛି।"),
  },
  "progress.calendar": {
    "en-IN": ready("Let me look at your calendar.", "Checking your diary."),
    "hi-IN": ready("मैं आपका कैलेंडर देखता हूँ।", "ज़रा देखता हूँ क्या रखा है।"),
    "bn-IN": draft("আমি আপনার ক্যালেন্ডার দেখছি।"),
    "ta-IN": draft("உங்கள் நாட்காட்டியைப் பார்க்கிறேன்."),
    "te-IN": draft("మీ క్యాలెండర్ చూస్తాను."),
    "gu-IN": draft("હું તમારું કૅલેન્ડર જોઉં છું."),
    "kn-IN": draft("ನಿಮ್ಮ ಕ್ಯಾಲೆಂಡರ್ ನೋಡುತ್ತೇನೆ."),
    "ml-IN": draft("നിങ്ങളുടെ കലണ്ടർ നോക്കട്ടെ."),
    "mr-IN": draft("मी तुमचं कॅलेंडर बघतो."),
    "pa-IN": draft("ਮੈਂ ਤੁਹਾਡਾ ਕੈਲੰਡਰ ਵੇਖਦਾ ਹਾਂ।"),
    "or-IN": draft("ମୁଁ ଆପଣଙ୍କ କ୍ୟାଲେଣ୍ଡର ଦେଖୁଛି।"),
  },
  "progress.mail": {
    "en-IN": ready("Sending that now.", "One moment, sending."),
    "hi-IN": ready("मैं अभी भेज रहा हूँ।", "एक मिनट, भेज रहा हूँ।"),
    "bn-IN": draft("আমি এখনই পাঠাচ্ছি।"),
    "ta-IN": draft("இப்போது அனுப்புகிறேன்."),
    "te-IN": draft("ఇప్పుడే పంపుతున్నాను."),
    "gu-IN": draft("હું હમણાં મોકલું છું."),
    "kn-IN": draft("ಈಗ ಕಳುಹಿಸುತ್ತಿದ್ದೇನೆ."),
    "ml-IN": draft("ഇപ്പോൾ അയയ്ക്കുന്നു."),
    "mr-IN": draft("मी आत्ता पाठवतो."),
    "pa-IN": draft("ਮੈਂ ਹੁਣੇ ਭੇਜ ਰਿਹਾ ਹਾਂ।"),
    "or-IN": draft("ମୁଁ ଏବେ ପଠାଉଛି।"),
  },
};

/** Rotates through variants so a waiting companion does not sound like a loop. */
export function resolveFiller(language: LanguageCode, turnIndex: number): string {
  const set = FILLERS[language] ?? FILLERS["hi-IN"] ?? FILLERS["en-IN"]!;
  return set.variants[turnIndex % set.variants.length]!;
}

export function resolveFallback(key: FallbackKey, language: LanguageCode): string {
  const table = FALLBACKS[key];
  const set = table[language] ?? table["hi-IN"] ?? table["en-IN"]!;
  return set.variants[0]!;
}

/**
 * A tool's own progress line. Rotates like the generic filler, because someone
 * who asks about the weather twice in an evening should not hear the identical
 * sentence both times.
 */
export function resolveProgress(key: ProgressKey, language: LanguageCode, turnIndex = 0): string {
  const table = PROGRESS[key];
  const set = table[language] ?? table["hi-IN"] ?? table["en-IN"]!;
  return set.variants[turnIndex % set.variants.length]!;
}

/** Languages whose filler, fallback or progress copy is still placeholder text. */
export function pendingCopyReview(): Array<{ scope: string; language: LanguageCode }> {
  const out: Array<{ scope: string; language: LanguageCode }> = [];
  for (const [lang, set] of Object.entries(FILLERS)) {
    if (set.needsNativeReview) out.push({ scope: "filler", language: lang });
  }
  for (const table of [FALLBACKS, PROGRESS]) {
    for (const [key, byLanguage] of Object.entries(table)) {
      for (const [lang, set] of Object.entries(byLanguage)) {
        if (set.needsNativeReview) out.push({ scope: key, language: lang });
      }
    }
  }
  return out;
}
