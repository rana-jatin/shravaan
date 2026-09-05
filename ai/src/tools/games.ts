/**
 * `start_game`, `answer_game`, `end_game` — the second thing in this product
 * that spans more than one turn.
 *
 * Its own file rather than builtin.ts for the reason music.ts is: the built-ins
 * answer a question and hand the turn back, and these do not. A round is a small
 * machine that lives across five exchanges, and the machine itself is in
 * src/domain/games/ — this file is only the surface the model reaches it
 * through. Nothing here holds state; the round belongs to the session and
 * arrives through `ctx.host.games()`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A TOOL AND NOT A LINE IN THE SYSTEM PROMPT.
 *
 * The model could improvise a quiz with no code at all, and the cheap version of
 * this feature is a sentence in SYSTEM_PROMPT. Three things are wrong with that,
 * and the first is the same argument `get_time` makes: the prompt is a stable
 * cached prefix, so a sentence about games is paid for on EVERY turn of every
 * conversation, to serve something that happens a few times a week.
 *
 * The second is that an improvised quiz has no answer key — the model marks its
 * own homework, and a companion that confidently tells someone their right
 * answer was wrong is worse than one that never offered to play.
 *
 * The third is the score. `TURN_WINDOW` is 12, and a five-question round fills
 * it, so a model counting from its own context loses the opening question
 * somewhere around the fourth answer.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ THREE TOOLS IS A REAL COST, PAID BY EVERY TURN. The schemas go to the model
 * on every request whether or not anyone is playing, and builtin.ts already
 * notes that eight is more than a companion needs for most turns and that
 * selection quality under a realistic tool count is unmeasured (ADR 0003). This
 * takes the zero-configuration list to eleven, and a deployment with weather and
 * news to thirteen. If selection degrades, the fallback is one `play_game` tool
 * with an `action` parameter — more compact, but `validateArgs` cannot express
 * "required only when action is answer", so it trades precision for tokens.
 * Measure before making that trade.
 *
 * ⚠ AND IT IS NOT AN ASSESSMENT. Nothing here is scored against a norm, no
 * result is written anywhere, and none of it goes near care signals — see the
 * note in src/domain/games/numbers.ts. The descriptions below carry that into
 * the model's behaviour, because the tool can only refuse to record a score; it
 * cannot stop a reply from sounding like a diagnosis.
 */

import { TRIVIA_CATEGORIES } from "../domain/games/bank.ts";
import type { GameKind } from "../domain/games/types.ts";
import type { ToolSpec } from "./registry.ts";
import { INSTANT_MS } from "./types.ts";

/** English tokens, never translated values — see the note on `enum` in types.ts. */
const KINDS: GameKind[] = ["trivia", "numbers", "proverbs"];

/**
 * How the model is told to handle a question that must not be translated.
 *
 * Repeated in both tools that can serve a question, because a model that reads
 * only one of the two descriptions still has to get this right — and getting it
 * wrong means a Hindi saying arrives translated into English, which is not a
 * harder game, it is a different and broken one.
 */
const VERBATIM_RULE =
  "If verbatim_language is set, say the question EXACTLY as written and do not " +
  "translate it — it is a saying, and translating it destroys the game. If it is " +
  "null, ask the question naturally in whatever language the user is speaking.";

/**
 * How the model is told to behave about the score.
 *
 * This is the part that matters most and the part no type can enforce. The
 * people this product is for may be eighty, and a game that keeps telling
 * someone what they got wrong stops being a pastime within about two questions.
 */
const TONE_RULE =
  "Keep it light and warm. Never call the score a measure of their memory or " +
  "their mind, never diagnose anything, and do not dwell on wrong answers — say " +
  "the right one kindly and move on.";

export const startGame: ToolSpec = {
  name: "start_game",
  description:
    "Start a short game when the user asks to play one, or when they say they are " +
    "bored and would like something to do. Five questions, asked one at a time. " +
    "Ask the question you get back, then wait for their answer and pass it to " +
    "answer_game — do not answer it yourself and do not guess at the answer, you " +
    "are not told it. " +
    VERBATIM_RULE +
    " " +
    "If the game that comes back is not the one that was asked for, the reply says " +
    "so in instead_of: mention it lightly and offer what you do have. " +
    TONE_RULE,
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "What sort of game. trivia is general knowledge; numbers is remembering " +
          "and simple arithmetic; proverbs is finishing a well-known saying, and " +
          "exists only in some languages. Omit to let the choice be made for you.",
        enum: [...KINDS],
      },
      category: {
        type: "string",
        description: "Subject for a trivia round, when the user asked for one.",
        enum: [...TRIVIA_CATEGORIES],
      },
    },
    // Neither is required: "play something" is the commonest way this is asked,
    // and forcing a choice would make the model invent a preference the user
    // never expressed. `strict` is therefore not claimed — see toSchema.
    required: [],
    additionalProperties: false,
  },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (args, ctx) => {
    const kind = typeof args["kind"] === "string" ? (args["kind"] as GameKind) : undefined;
    const category = typeof args["category"] === "string" ? args["category"] : undefined;

    const outcome = ctx.host.games().start({ kind, category, language: ctx.language });
    if (!outcome.started) return { started: false, reason: outcome.reason };

    // Flattened for the model rather than handed over nested. It reads this as
    // JSON on a turn where it also has to compose a sentence, and one level is
    // one less thing to get wrong.
    return {
      started: true,
      kind: outcome.kind,
      category: outcome.category,
      question: outcome.question.prompt,
      verbatim_language: outcome.question.verbatim_language,
      question_no: outcome.question.question_no,
      of: outcome.question.of,
      ...(outcome.instead_of ? { instead_of: outcome.instead_of } : {}),
    };
  },
};

export const answerGame: ToolSpec = {
  name: "answer_game",
  description:
    "Give the user's answer to the current game question and get the next one. " +
    "Pass what they actually said, in their own words — you are not marking it, " +
    "this tool is. If they say they do not know, or want to skip, or want the " +
    "answer, pass an EMPTY answer: that is a pass and it does not count against " +
    "them. " +
    "You get back whether they were right, the correct answer, the score so far, " +
    "and the next question. A verdict of 'close' means they had it — say so warmly " +
    "and give them the exact wording. " +
    VERBATIM_RULE +
    " " +
    TONE_RULE,
  parameters: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "What the user said, or an empty string if they are passing.",
      },
    },
    required: ["answer"],
    additionalProperties: false,
  },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (args, ctx) => {
    const outcome = ctx.host.games().answer(String(args["answer"] ?? ""));
    // A domain outcome, not an error: the model called this after a round ended,
    // or without one ever starting. Both are conversation, not infrastructure —
    // and an `ok: false` here would cost a spoken_fallback_key, which is eleven
    // translations. See the header of tools/builtin.ts.
    if (!outcome.judged) return { judged: false, reason: outcome.reason };

    const base = {
      judged: true,
      verdict: outcome.verdict,
      correct_answer: outcome.correct_answer,
      score: outcome.correct,
      asked: outcome.asked,
    };

    return outcome.finished
      ? { ...base, finished: true, kind: outcome.kind }
      : {
          ...base,
          finished: false,
          question: outcome.question.prompt,
          verbatim_language: outcome.question.verbatim_language,
          question_no: outcome.question.question_no,
          of: outcome.question.of,
        };
  },
};

export const endGame: ToolSpec = {
  name: "end_game",
  description:
    "Stop the game early, when the user has had enough or wants to talk about " +
    "something else. You get the score so far. Do not use this at the end of a " +
    "full round — that finishes on its own. " +
    TONE_RULE,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (_args, ctx) => {
    const outcome = ctx.host.games().end();
    return outcome.ended
      ? { ended: true, kind: outcome.kind, score: outcome.correct, asked: outcome.asked }
      : { ended: false, reason: outcome.reason };
  },
};

/**
 * Registered together or not at all. A deployment cannot sensibly have
 * `answer_game` without `start_game`.
 */
export const GAME_TOOLS: ToolSpec[] = [startGame, answerGame, endGame];
