/**
 * The trivia bank.
 *
 * A TYPED MODULE RATHER THAN A JSON ASSET, on purpose. A malformed question
 * fails `npm run typecheck` instead of failing in front of a user, and there is
 * no file to locate at runtime — `HOLDING_AUDIO_DIR` is already one path in this
 * repo that resolves relative to whichever directory the process happened to
 * start in, and one is enough.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITTEN IN ENGLISH, ASKED IN ELEVEN LANGUAGES.
 *
 * None of these carry a `language`, which means the model narrates them in
 * whatever language the turn is in — exactly what `get_news` does with an
 * English RSS headline that ends up read aloud in Hindi. A question about which
 * river runs past Varanasi is the same question in Odia; only the words change,
 * and the model is the component that changes words.
 *
 * The accept-lists are the part that is NOT language-neutral, and they are
 * written accordingly: an answer that has a common Devanagari form carries it,
 * because a Hindi speaker will say "गंगा" and the matcher compares text, not
 * meaning (src/domain/games/answer-match.ts). Answers in the other nine scripts
 * are missing, and that is a known gap rather than an oversight — the matcher's
 * near-miss tolerance does not bridge scripts, so a Malayalam speaker answering
 * in Malayalam script may be marked wrong. The same missing multilingual
 * embedder that limits `recall` limits this. See README, "Known gaps".
 *
 * KEEP THE QUESTIONS ANSWERABLE. This is a pastime for someone who may be
 * eighty, not a pub quiz. A question nobody in the room can answer is not a
 * harder game, it is a worse one — the pleasure here is in remembering, and a
 * bank of obscurities produces a round of five silences.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Question } from "./types.ts";

/** English tokens, never translated values — see the note on `enum` in tools/types.ts. */
export const TRIVIA_CATEGORIES = [
  "india",
  "nature",
  "history",
  "cinema",
  "sport",
  "food",
  "everyday",
] as const;

export type TriviaCategory = (typeof TRIVIA_CATEGORIES)[number];

const q = (id: string, category: TriviaCategory, prompt: string, answers: string[]): Question => ({
  id: `trivia:${id}`,
  kind: "trivia",
  category,
  prompt,
  answers,
});

export const TRIVIA: readonly Question[] = [
  // --- india ---------------------------------------------------------------
  q("ganga", "india", "Which river flows past Varanasi?", ["Ganga", "Ganges", "गंगा"]),
  q("capital", "india", "What is the capital of India?", [
    "New Delhi",
    "Delhi",
    "नई दिल्ली",
    "दिल्ली",
  ]),
  q("pink-city", "india", "Which city is known as the Pink City?", ["Jaipur", "जयपुर"]),
  q("taj", "india", "Which monument did Shah Jahan build at Agra in memory of his wife?", [
    "Taj Mahal",
    "ताज महल",
  ]),
  q("national-bird", "india", "What is India's national bird?", ["peacock", "peafowl", "मोर"]),
  q("national-flower", "india", "What is India's national flower?", ["lotus", "कमल"]),
  q("largest-state", "india", "Which is the largest Indian state by area?", [
    "Rajasthan",
    "राजस्थान",
  ]),
  q("backwaters", "india", "Which state is famous for its backwaters?", ["Kerala", "केरल"]),
  q("gateway", "india", "The Gateway of India stands in which city?", [
    "Mumbai",
    "Bombay",
    "मुंबई",
  ]),
  q("lake-city", "india", "Which city is called the City of Lakes?", ["Udaipur", "उदयपुर"]),
  q("diwali", "india", "Which festival is known as the festival of lights?", [
    "Diwali",
    "Deepavali",
    "दिवाली",
    "दीपावली",
  ]),

  // --- history -------------------------------------------------------------
  q("independence", "history", "In which year did India become independent?", ["1947"]),
  q("bapu", "history", "Who is known as the Father of the Nation in India?", [
    "Mahatma Gandhi",
    "Gandhi",
    "Mohandas Gandhi",
    "महात्मा गांधी",
    "गांधी",
  ]),
  q("first-pm", "history", "Who was India's first Prime Minister?", [
    "Jawaharlal Nehru",
    "Nehru",
    "नेहरू",
    "जवाहरलाल नेहरू",
  ]),
  q("first-woman-pm", "history", "Who was India's first woman Prime Minister?", [
    "Indira Gandhi",
    "Indira",
    "इंदिरा गांधी",
  ]),
  q("first-president", "history", "Who was the first President of India?", [
    "Rajendra Prasad",
    "राजेंद्र प्रसाद",
  ]),
  q("red-fort", "history", "Which Mughal emperor built the Red Fort in Delhi?", [
    "Shah Jahan",
    "शाहजहाँ",
    "शाहजहां",
  ]),
  q("anthem", "history", "Who wrote India's national anthem?", [
    "Rabindranath Tagore",
    "Tagore",
    "रवीन्द्रनाथ ठाकुर",
    "टैगोर",
  ]),
  q("iron-man", "history", "Who was called the Iron Man of India?", [
    "Sardar Patel",
    "Vallabhbhai Patel",
    "Patel",
    "सरदार पटेल",
    "पटेल",
  ]),

  // --- nature --------------------------------------------------------------
  q("blue-whale", "nature", "Which is the largest animal on earth?", [
    "blue whale",
    "whale",
    "व्हेल",
  ]),
  q("spider-legs", "nature", "How many legs does a spider have?", ["8", "आठ"]),
  q("desert-ship", "nature", "Which animal is called the ship of the desert?", ["camel", "ऊँट"]),
  q("bees", "nature", "What do bees make?", ["honey", "शहद"]),
  q("giraffe", "nature", "Which is the tallest animal in the world?", ["giraffe", "जिराफ़"]),
  q("banyan", "nature", "What is India's national tree?", ["banyan", "बरगद"]),
  q("cheetah", "nature", "Which is the fastest animal on land?", ["cheetah", "चीता"]),
  q("rainbow", "nature", "How many colours are there in a rainbow?", ["7", "सात"]),

  // --- cinema --------------------------------------------------------------
  q("nightingale", "cinema", "Which singer was known as the Nightingale of India?", [
    "Lata Mangeshkar",
    "Lata",
    "लता मंगेशकर",
    "लता",
  ]),
  q("shahenshah", "cinema", "Which actor is known as the Shahenshah of Bollywood?", [
    "Amitabh Bachchan",
    "Amitabh",
    "अमिताभ बच्चन",
    "अमिताभ",
  ]),
  q("sitar", "cinema", "Which instrument did Ravi Shankar play?", ["sitar", "सितार"]),
  q("ray", "cinema", "Which director made the Apu trilogy?", [
    "Satyajit Ray",
    "Ray",
    "सत्यजित राय",
  ]),

  // --- sport ---------------------------------------------------------------
  q("cricket-eleven", "sport", "How many players from one team are on the field in cricket?", [
    "11",
    "ग्यारह",
  ]),
  q("sachin", "sport", "Which sport is Sachin Tendulkar famous for?", ["cricket", "क्रिकेट"]),
  q("shuttlecock", "sport", "Which game is played with a shuttlecock?", ["badminton", "बैडमिंटन"]),
  q("kabaddi", "sport", "How many players are on court in a kabaddi team?", ["7", "सात"]),

  // --- food ----------------------------------------------------------------
  q("turmeric", "food", "Which spice gives curry its yellow colour?", [
    "turmeric",
    "haldi",
    "हल्दी",
  ]),
  q("paneer", "food", "What is paneer made from?", ["milk", "दूध"]),
  q("idli", "food", "Which grain are idli and dosa mainly made from?", ["rice", "chawal", "चावल"]),
  q("mango", "food", "Which fruit is called the king of fruits in India?", ["mango", "आम"]),

  // --- everyday ------------------------------------------------------------
  q("red-planet", "everyday", "Which planet is known as the red planet?", ["Mars", "मंगल"]),
  q("hour-minutes", "everyday", "How many minutes are there in an hour?", ["60", "साठ"]),
  q("week-days", "everyday", "How many days are there in a week?", ["7", "सात"]),
  q("frozen-water", "everyday", "What do we call water when it freezes?", ["ice", "बर्फ"]),
  q("heart", "everyday", "Which organ pumps blood around the body?", ["heart", "दिल", "हृदय"]),
  q("leap-year", "everyday", "How many days are there in a leap year?", ["366"]),
];
