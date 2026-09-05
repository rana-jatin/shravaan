/**
 * What a game is, and the surface a tool is allowed to drive it through.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DISTINCTION THIS FILE EXISTS TO CARRY: does the content survive
 * translation?
 *
 * A trivia question does. "Which river flows through Varanasi?" reaches the user
 * in Odia because the model narrates it there, the same way get_news reads an
 * English RSS headline aloud in Hindi. A proverb does not — half of "अब पछताए
 * होत क्या" IS the Hindi, and a translated proverb is not a harder game, it is a
 * broken one.
 *
 * So `Question.language` is the whole design. Absent means the text is a neutral
 * carrier the model may say in whatever language the turn is in. Present means
 * the text is the game, and it is offered ONLY in that language.
 *
 * The alternative — one bank, eleven translations — is what makes this feature
 * unshippable. Nine of eleven languages still have placeholder copy for six
 * short fillers (src/copy/fillers.ts); a translated question bank would be an
 * order of magnitude more text with a correctness requirement on top.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";

/**
 * The three shapes of game, which are three different content economics.
 *
 *   trivia   — authored once in English, narrated everywhere. See above.
 *   numbers  — GENERATED, never authored (src/domain/games/numbers.ts). Digits
 *              are language-neutral, so this kind costs no content at all and
 *              cannot go stale or be wrong. It is also the only one of the three
 *              that is a brain game in the literal sense: working memory and
 *              attention rather than recall of facts.
 *   proverbs — authored per language, offered only where authored.
 */
export type GameKind = "trivia" | "numbers" | "proverbs";

export type Question = {
  /** Stable. Used to avoid asking the same thing twice in a session. */
  id: string;
  kind: GameKind;
  /** English token, never a translated value — see the note on `enum` in tools/types.ts. */
  category: string;
  /** Asked aloud. */
  prompt: string;
  /**
   * Everything that counts. The first entry is the canonical phrasing, and it is
   * the one spoken back when the user did not get it.
   *
   * Written as an accept-list rather than one string because the answer arrives
   * through ASR from someone speaking freely: "Ganga", "Ganges" and "गंगा" are
   * the same answer, and a game that accepts only one of them is a game that
   * tells honest people they are wrong.
   */
  answers: string[];
  /**
   * Present ⇒ the prompt IS this language and must be spoken verbatim. Absent ⇒
   * the prompt is a neutral carrier, to be narrated in the turn's language.
   */
  language?: LanguageCode;
};

/** Where a round stands, as the caller sees it. Never carries an unasked answer. */
export type AskedQuestion = {
  prompt: string;
  /** Non-null ⇒ say it exactly as written, do not translate. See `Question.language`. */
  verbatim_language: LanguageCode | null;
  question_no: number;
  of: number;
};

/**
 * `close` is a near miss on the accept-list — a dropped syllable, a mangled
 * vowel, the sort of thing ASR does to a name. It SCORES AS CORRECT and is
 * reported separately only so the reply can offer the exact word back.
 *
 * The generosity is deliberate and is about who is playing. Marking an elderly
 * user wrong because Saaras heard "Ganja" for "Ganga" is a defect wearing a
 * score's clothing.
 */
export type Verdict = "correct" | "close" | "wrong" | "passed";

export type StartOutcome =
  | {
      started: true;
      kind: GameKind;
      category: string;
      question: AskedQuestion;
      /**
       * Set when the user asked for a kind this language has no content for, so
       * the reply can offer what there is instead of withdrawing an offer. The
       * registry cannot prevent this the way it prevents an unconfigured tool
       * being described: `schemasFor` filters by entitlement, and does not know
       * the turn's language. See tools/games.ts.
       */
      instead_of?: GameKind;
    }
  | { started: false; reason: "nothing_playable" };

export type AnswerOutcome =
  | { judged: false; reason: "no_game_running" }
  | {
      judged: true;
      verdict: Verdict;
      /** The canonical answer. Released only now — never before the user has answered. */
      correct_answer: string;
      correct: number;
      asked: number;
      finished: false;
      question: AskedQuestion;
    }
  | {
      judged: true;
      verdict: Verdict;
      correct_answer: string;
      correct: number;
      asked: number;
      finished: true;
      kind: GameKind;
    };

export type EndOutcome =
  | { ended: false; reason: "no_game_running" }
  | { ended: true; kind: GameKind; correct: number; asked: number };

/**
 * The live round, as a tool sees it.
 *
 * Narrow for the same reason `SessionToolHost` is narrow: the registry is built
 * once per deployment and shared by every concurrent session, so a game handler
 * must reach THIS conversation's round and nothing else. The session hands it in
 * at execution time (tools/types.ts).
 */
export interface GameHost {
  readonly playing: boolean;
  start(opts: {
    kind?: GameKind | undefined;
    category?: string | undefined;
    language: LanguageCode;
  }): StartOutcome;
  /** An empty answer is a pass, not a wrong answer. See tools/games.ts. */
  answer(spoken: string): AnswerOutcome;
  end(): EndOutcome;
}
