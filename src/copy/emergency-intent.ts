/**
 * "Help", in eleven languages, matched LOCALLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS CANNOT BE AN LLM TURN.
 *
 * Every other capability in this product can afford to be wrong occasionally.
 * This one cannot, and it is the only path here where a slow answer and a wrong
 * answer are the same thing.
 *
 * Routing "help" through the model means the alert waits on: a rate limit that
 * ADR 0003 already documents as the system's ceiling, a retry, a token stream,
 * and a model that may decide the user was being figurative. Any one of those
 * turns a two-second alert into a thirty-second one, or into none at all. So
 * the phrase table below is checked before the language gate, before the media
 * short-circuit, and before any network call — the FIRST thing that happens to
 * a final transcript.
 *
 * The model keeps a tool (`raise_alarm`) for what this table cannot catch: "I
 * have fallen and I can't get up", "my chest hurts", "I think I'm having a
 * stroke". Two layers, because either alone has a gap the other covers.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ THE ASYMMETRY THAT SHAPES EVERY DECISION BELOW.
 *
 * A false positive is an email to two people who then ring to check. Mildly
 * embarrassing, over in a minute. A false negative is an eighty-year-old on the
 * floor of a room nobody is coming to. These are not comparable costs, and
 * nothing in this file should be tuned as though they were. WHEN IN DOUBT,
 * RAISE THE ALARM.
 *
 * ⚠ REVIEW STATUS — MORE SERIOUS HERE THAN ANYWHERE ELSE IN THIS REPO.
 *
 * Only `en-IN` and `hi-IN` are considered ready. The other nine are drafted
 * from common usage and are marked in PENDING_REVIEW. Elsewhere an unreviewed
 * string is a bad impression; here it is a call for help that does not
 * register. A native speaker must review these before a device ships to anyone
 * who speaks those languages, and the server says so at boot.
 */

import type { LanguageCode } from "../domain/types.ts";

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
 * ⚠ TWO TIERS, AND THE SPLIT IS THE MOST IMPORTANT DECISION IN THIS FILE.
 *
 * The header says a false positive is cheap. That is true ONCE. It stops being
 * true when the contacts learn that the alerts are usually nothing — a family
 * that skims this email is a family that misses the real one, and then the
 * feature is worse than never having existed.
 *
 * "Help" is the problem. "Help me pick a song", "help me remember his
 * birthday", "I need help with the television" are ordinary sentences from this
 * exact demographic, and they contain the word this feature listens for.
 *
 * So the phrases below are UNAMBIGUOUS: nobody says "I have fallen" or "bachao"
 * casually, and they fire whatever else is in the turn. The ambiguous ones are
 * in AMBIGUOUS_PHRASES and fire only in a SHORT turn, because that is what
 * distress actually sounds like — "help me", not "could you help me with
 * something in the kitchen".
 *
 * Both Latin transliteration and native script appear, because Saaras returns
 * native script for these languages and a transliteration-only table would
 * match nothing at all in practice.
 */
export const EMERGENCY_PHRASES: Record<LanguageCode, string[]> = {
  "en-IN": [
    // NOTE: "help help" is deliberately NOT here — the repetition rule below
    // catches it at any length, and listing it twice would report the wrong
    // trigger in the alert email.
    "somebody help",
    "someone help",
    "anybody help",
    "call someone",
    "call my son",
    "call my daughter",
    "call the doctor",
    "call an ambulance",
    "ambulance",
    "emergency",
    "i have fallen",
    "i've fallen",
    "i fell down",
    "i can't get up",
    "i cannot get up",
    "chest pain",
    "can't breathe",
    "cannot breathe",
    "i am dying",
    "save me",
    "help me please",
    "please help",
  ],
  "hi-IN": [
    "bachao",
    "bachaao",
    "koi hai",
    "koi to aao",
    "doctor ko bulao",
    "ambulance bulao",
    "bete ko bulao",
    "gir gaya",
    "gir gayi",
    "uth nahi",
    "saans nahi",
    "seene mein dard",
    "bahut dard",
    "बचाओ",
    "कोई है",
    "गिर गया",
    "गिर गयी",
    "साँस नहीं",
    "सीने में दर्द",
  ],
  "bn-IN": ["bachao", "keu ache", "porey gechi", "daktar dako", "বাঁচাও", "কেউ আছে", "পড়ে গেছি"],
  "ta-IN": [
    "kapathunga",
    "yaaravadhu",
    "vizhundhuten",
    "doctor ah kupidunga",
    "காப்பாற்று",
    "விழுந்துவிட்டேன்",
  ],
  "te-IN": [
    "kapadandi",
    "evaraina unnara",
    "padipoyanu",
    "doctor ni pilavandi",
    "కాపాడండి",
    "పడిపోయాను",
  ],
  "gu-IN": ["bachavo", "koi che", "padi gayo", "doctor ne bolavo", "બચાવો", "પડી ગયો"],
  "kn-IN": ["kapadi", "yaaradru iddira", "biddhe", "doctor na kareyiri", "ಕಾಪಾಡಿ", "ಬಿದ್ದೆ"],
  "ml-IN": ["rakshikkanam", "aarenkilum", "veenu poyi", "doctore vilikku", "രക്ഷിക്കണം", "വീണു"],
  "mr-IN": ["vachva", "koni aahe", "padlo", "doctor la bolva", "वाचवा", "पडलो"],
  "pa-IN": ["bachao", "koi hai", "dig gaya", "doctor nu bulao", "ਬਚਾਓ", "ਡਿੱਗ ਗਿਆ"],
  "or-IN": ["bachao", "kehi achi", "padigali", "daktar daka", "ବଞ୍ଚାଅ", "ପଡ଼ିଗଲି"],
};

/**
 * Phrases that mean help ONLY when the turn is short.
 *
 * Matched as whole words, never as substrings — otherwise "helpful" and
 * "helping" fire, and the word appears in ordinary speech constantly.
 */
export const AMBIGUOUS_PHRASES: Record<LanguageCode, string[]> = {
  "en-IN": ["help", "help me"],
  "hi-IN": ["madad", "madad karo", "meri madad", "मदद", "मदद करो", "सहायता"],
  "bn-IN": ["sahajjo", "sahajyo koro", "সাহায্য"],
  "ta-IN": ["udhavi", "udavi seiyunga", "உதவி"],
  "te-IN": ["sahayam", "sahayam cheyandi", "సహాయం"],
  "gu-IN": ["madad", "madad karo", "મદદ"],
  "kn-IN": ["sahaya", "sahaya maadi", "ಸಹಾಯ"],
  "ml-IN": ["sahayam", "sahayam venam", "സഹായം"],
  "mr-IN": ["madat", "madat kara", "मदत"],
  "pa-IN": ["madad", "madad karo", "ਮਦਦ"],
  "or-IN": ["sahajya", "sahajya kara", "ସାହାଯ୍ୟ"],
};

/**
 * Words that, said TWICE in one turn, are a cry for help at any length.
 *
 * "Help help" is the phrasing in the product brief, and it is in the brief
 * because it is what people actually do — repetition is the thing that
 * separates distress from a request.
 */
const REPEATABLE = new Set([
  "help",
  "madad",
  "bachao",
  "bachaao",
  "madat",
  "sahayam",
  "sahaya",
  "sahajya",
  "sahajjo",
  "udhavi",
  "मदद",
  "बचाओ",
  "सहायता",
  "मदत",
  "সাহায্য",
  "উদ্ধার",
  "உதவி",
  "సహాయం",
  "મદદ",
  "ಸಹಾಯ",
  "സഹായം",
  "ਮਦਦ",
  "ସାହାଯ୍ୟ",
]);

/**
 * At most this many words for an ambiguous phrase to count.
 *
 * Four, because "help me please" is three and "can you help me pick a song" is
 * seven. Tuned toward firing: a turn of four words containing "help" and
 * nothing else is far more likely to be a call than a request.
 */
const SHORT_TURN_WORDS = 4;

/** Punctuation and filler the ASR sprinkles through a shouted transcript. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?;:।॥"'()-]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
}

export type EmergencyMatch = {
  /** The phrase that fired, for the alert email and the log. */
  matched: string;
  /** `repeated` is the "help help" case; `phrase` is everything else. */
  kind: "phrase" | "repeated" | "bare";
};

/**
 * Does this transcript ask for help?
 *
 * Checks the session language AND English, for the same reason as the stop
 * matcher: a Tamil speaker shouting "help" is the single most likely phrasing,
 * and the ASR will have tagged the turn as Tamil.
 *
 * MATCHING IS DELIBERATELY LOOSE, and more so than the stop matcher. A
 * transcript of someone in distress is short, mangled, and half-caught. The
 * cost of loosening it is a phone call; the cost of tightening it is in the
 * header of this file.
 */
export function matchEmergency(text: string, language: LanguageCode): EmergencyMatch | null {
  const haystack = text.toLowerCase().trim();
  if (haystack === "") return null;

  // Tier 1: nobody says these casually. Fire regardless of what else is said.
  const unambiguous = [
    ...(EMERGENCY_PHRASES[language] ?? []),
    ...(EMERGENCY_PHRASES["en-IN"] ?? []),
  ];
  for (const p of unambiguous) {
    if (haystack.includes(p)) return { matched: p, kind: "phrase" };
  }

  const w = words(haystack);

  // Tier 2: repetition. "Help help" at any length — a person saying it twice in
  // one breath is not asking for assistance with something.
  const repeated = w.filter((token) => REPEATABLE.has(token));
  if (repeated.length >= 2) {
    return { matched: repeated.slice(0, 2).join(" "), kind: "repeated" };
  }

  // Tier 3: the ambiguous word, but only in a short turn. This is what keeps
  // "help me pick a song" from emailing two people at midnight.
  if (w.length <= SHORT_TURN_WORDS) {
    const ambiguous = [
      ...(AMBIGUOUS_PHRASES[language] ?? []),
      ...(AMBIGUOUS_PHRASES["en-IN"] ?? []),
    ];
    for (const p of ambiguous) {
      const parts = p.split(" ");
      // Whole words only: "helpful" and "helping" must not count.
      for (let i = 0; i + parts.length <= w.length; i++) {
        if (parts.every((part, j) => w[i + j] === part)) {
          return { matched: p, kind: "bare" };
        }
      }
    }
  }

  return null;
}

/**
 * What the companion says the instant an alarm is raised, before the email has
 * even been attempted.
 *
 * Naming the people matters. "I have called for help" is frightening and vague;
 * "I am telling Harsh and Aman right now" tells the user a PERSON they know is
 * coming, which is the reassurance that actually helps. `{names}` is filled in
 * from the configured contacts.
 *
 * ⚠ Same review status as the phrases: en-IN and hi-IN only.
 */
export const EMERGENCY_ACK: Record<LanguageCode, string> = {
  "en-IN":
    "I'm getting you help right now. I'm telling {names}. Stay where you are — I'm here with you.",
  "hi-IN":
    "मैं अभी आपके लिए मदद बुला रहा हूँ। मैं {names} को बता रहा हूँ। आप वहीं रहिए — मैं आपके साथ हूँ।",
  "bn-IN": "আমি এখনই সাহায্য আনছি। আমি {names}-কে জানাচ্ছি। আপনি ওখানেই থাকুন — আমি আছি।",
  "ta-IN":
    "நான் இப்போதே உதவி பெறுகிறேன். {names} அவர்களுக்குச் சொல்கிறேன். அங்கேயே இருங்கள் — நான் இருக்கிறேன்.",
  "te-IN":
    "నేను ఇప్పుడే సహాయం తీసుకువస్తున్నాను. {names} కి చెబుతున్నాను. అక్కడే ఉండండి — నేను ఉన్నాను.",
  "gu-IN": "હું અત્યારે જ મદદ બોલાવું છું. હું {names} ને જણાવું છું. તમે ત્યાં જ રહો — હું છું.",
  "kn-IN":
    "ನಾನು ಈಗಲೇ ಸಹಾಯ ಕರೆಸುತ್ತಿದ್ದೇನೆ. {names} ಅವರಿಗೆ ತಿಳಿಸುತ್ತಿದ್ದೇನೆ. ಅಲ್ಲಿಯೇ ಇರಿ — ನಾನಿದ್ದೇನೆ.",
  "ml-IN":
    "ഞാൻ ഇപ്പോൾ തന്നെ സഹായം എത്തിക്കുന്നു. {names} നോട് പറയുന്നു. അവിടെ തന്നെ ഇരിക്കൂ — ഞാനുണ്ട്.",
  "mr-IN": "मी आत्ताच मदत बोलावतो आहे. मी {names} ला सांगतो आहे. तुम्ही तिथेच थांबा — मी आहे.",
  "pa-IN": "ਮੈਂ ਹੁਣੇ ਮਦਦ ਬੁਲਾ ਰਿਹਾ ਹਾਂ। ਮੈਂ {names} ਨੂੰ ਦੱਸ ਰਿਹਾ ਹਾਂ। ਤੁਸੀਂ ਉੱਥੇ ਹੀ ਰਹੋ — ਮੈਂ ਹਾਂ।",
  "or-IN": "ମୁଁ ବର୍ତ୍ତମାନ ସାହାଯ୍ୟ ଆଣୁଛି। ମୁଁ {names} ଙ୍କୁ କହୁଛି। ସେଠାରେ ରୁହନ୍ତୁ — ମୁଁ ଅଛି।",
};

/**
 * What it says when the email did not go out.
 *
 * The user MUST hear this. A companion that says "I've told them" and has not
 * is worse than one with no alarm at all, because it stops them trying anything
 * else — which is the entire reason the send result is spoken rather than
 * merely logged.
 */
export const EMERGENCY_FAILED: Record<LanguageCode, string> = {
  "en-IN":
    "I could not reach anyone just now. Please try to call someone yourself if you can — I will keep trying.",
  "hi-IN":
    "मैं अभी किसी तक नहीं पहुँच पाया। हो सके तो आप खुद किसी को फ़ोन कीजिए — मैं कोशिश करता रहूँगा।",
  "bn-IN": "আমি এখন কারও কাছে পৌঁছাতে পারিনি। পারলে নিজে কাউকে ফোন করুন — আমি চেষ্টা করে যাব।",
  "ta-IN":
    "என்னால் இப்போது யாரையும் தொடர்பு கொள்ள முடியவில்லை. முடிந்தால் நீங்களே யாரையாவது அழையுங்கள் — நான் முயற்சி செய்கிறேன்.",
  "te-IN":
    "నేను ఇప్పుడు ఎవరినీ చేరుకోలేకపోయాను. వీలైతే మీరే ఎవరికైనా ఫోన్ చేయండి — నేను ప్రయత్నిస్తూ ఉంటాను.",
  "gu-IN":
    "હું અત્યારે કોઈ સુધી પહોંચી શક્યો નથી. બની શકે તો તમે જાતે કોઈને ફોન કરો — હું પ્રયત્ન કરતો રહીશ.",
  "kn-IN":
    "ನನಗೆ ಈಗ ಯಾರನ್ನೂ ತಲುಪಲು ಆಗಲಿಲ್ಲ. ಸಾಧ್ಯವಾದರೆ ನೀವೇ ಯಾರಿಗಾದರೂ ಕರೆ ಮಾಡಿ — ನಾನು ಪ್ರಯತ್ನಿಸುತ್ತೇನೆ.",
  "ml-IN":
    "എനിക്ക് ഇപ്പോൾ ആരെയും വിളിക്കാൻ കഴിഞ്ഞില്ല. കഴിയുമെങ്കിൽ നിങ്ങൾ തന്നെ ആരെയെങ്കിലും വിളിക്കൂ — ഞാൻ ശ്രമിച്ചുകൊണ്ടിരിക്കും.",
  "mr-IN":
    "मला आत्ता कोणापर्यंत पोहोचता आले नाही. शक्य असल्यास तुम्ही स्वतः कोणाला तरी फोन करा — मी प्रयत्न करत राहीन.",
  "pa-IN":
    "ਮੈਂ ਹੁਣੇ ਕਿਸੇ ਤੱਕ ਨਹੀਂ ਪਹੁੰਚ ਸਕਿਆ। ਜੇ ਹੋ ਸਕੇ ਤਾਂ ਤੁਸੀਂ ਖੁਦ ਕਿਸੇ ਨੂੰ ਫੋਨ ਕਰੋ — ਮੈਂ ਕੋਸ਼ਿਸ਼ ਕਰਦਾ ਰਹਾਂਗਾ।",
  "or-IN":
    "ମୁଁ ଏବେ କାହା ପାଖରେ ପହଞ୍ଚି ପାରିଲି ନାହିଁ। ସମ୍ଭବ ହେଲେ ଆପଣ ନିଜେ କାହାକୁ ଫୋନ କରନ୍ତୁ — ମୁଁ ଚେଷ୍ଟା କରୁଥିବି।",
};

/** Boot-time list of what a native speaker still has to sign off. */
export function pendingEmergencyReview(): LanguageCode[] {
  return [...PENDING_REVIEW];
}
