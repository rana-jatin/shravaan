/**
 * The live round. One per session.
 *
 * IN `domain/` AND NOT `orchestrator/`, unlike MediaController next door, and
 * the difference is the whole reason the layering rule is worth having:
 * MediaController sends control frames to a device, so it takes a `sendControl`
 * and belongs beside the session. This touches nothing outside the process — it
 * is a score, an index and a list — so it is pure, unit-testable without a
 * session, and lives with the rest of the game domain.
 *
 * It is a class rather than a reducer for the same reason ToolExecutor is: the
 * registry is built ONCE per deployment and shared by every concurrent session,
 * so the round cannot live next to the tool definitions. The session owns one of
 * these and hands it in at execution time through `SessionToolHost`.
 *
 * WHY THE ROUND IS NOT KEPT IN THE TURN WINDOW. It would be the cheaper design —
 * the model can see its own last few messages and could count its own score. But
 * `TURN_WINDOW` is 12 (shared/src/domain/redis-keys.ts) and a five-question round
 * with a reply each side is ten entries before anyone says anything else, so the
 * opening question falls out of the window somewhere around the fourth answer.
 * A companion that loses the score halfway through a game it started is worse
 * than one that never offered.
 */

import { judge } from "./answer-match.ts";
import { pickRound, ROUND_LENGTH } from "./catalogue.ts";
import type {
  AnswerOutcome,
  AskedQuestion,
  EndOutcome,
  GameHost,
  GameKind,
  Question,
  StartOutcome,
  Verdict,
} from "./types.ts";
import type { LanguageCode } from "@sp-i/shared/domain/types.ts";

type Round = {
  kind: GameKind;
  category: string;
  questions: Question[];
  /** Index of the question awaiting an answer. */
  index: number;
  correct: number;
  asked: number;
};

export type GameControllerDeps = {
  /** Injected so a round is reproducible in a test. */
  random?: () => number;
  roundLength?: number;
};

function asked(question: Question, index: number, of: number): AskedQuestion {
  return {
    prompt: question.prompt,
    // Null is not "English", it is "this text is a carrier, say it in whatever
    // language the turn is in". A proverb carries its language and must not be
    // translated. See src/domain/games/types.ts.
    verbatim_language: question.language ?? null,
    question_no: index + 1,
    of,
  };
}

export class GameController implements GameHost {
  #round: Round | null = null;
  /** Asked at least once this session. Kept across rounds so a second round is new. */
  readonly #seen = new Set<string>();
  readonly #random: () => number;
  readonly #length: number;

  constructor(deps: GameControllerDeps = {}) {
    this.#random = deps.random ?? Math.random;
    this.#length = deps.roundLength ?? ROUND_LENGTH;
  }

  get playing(): boolean {
    return this.#round !== null;
  }

  /**
   * Begin a round, replacing any round in flight.
   *
   * Replacing rather than refusing, for the reason MediaController.start
   * replaces a playing station: the user asked for a game, and two games at once
   * is the one outcome nobody could recover from by talking. The abandoned score
   * is not returned, and does not need to be — it was in the model's context
   * from the results that produced it.
   */
  start(opts: {
    kind?: GameKind | undefined;
    category?: string | undefined;
    language: LanguageCode;
  }): StartOutcome {
    const plan = pickRound({
      kind: opts.kind,
      category: opts.category,
      language: opts.language,
      count: this.#length,
      exclude: this.#seen,
      random: this.#random,
    });
    if (!plan) return { started: false, reason: "nothing_playable" };

    this.#round = { ...plan, index: 0, correct: 0, asked: 0 };
    const first = plan.questions[0]!;
    this.#seen.add(first.id);

    return {
      started: true,
      kind: plan.kind,
      category: plan.category,
      question: asked(first, 0, plan.questions.length),
      // Only when they asked for something else — the caller says so out loud,
      // which is the honest version of a capability this language does not have.
      ...(opts.kind && opts.kind !== plan.kind ? { instead_of: opts.kind } : {}),
    };
  }

  /**
   * Judge, score, and serve the next one.
   *
   * An EMPTY answer is a pass, not a wrong answer, and it does not count against
   * the score — `asked` still rises, so the tally stays honest, but nobody is
   * marked wrong for saying they do not know. That distinction is the difference
   * between a pastime and a test, and this audience can tell.
   */
  answer(spoken: string): AnswerOutcome {
    const round = this.#round;
    if (!round) return { judged: false, reason: "no_game_running" };

    const current = round.questions[round.index]!;
    const verdict: Verdict = spoken.trim() === "" ? "passed" : judge(spoken, current.answers);
    // `close` scores as correct on purpose — see the note on Verdict in types.ts.
    if (verdict === "correct" || verdict === "close") round.correct++;
    round.asked++;
    round.index++;

    const base = {
      judged: true as const,
      verdict,
      correct_answer: current.answers[0]!,
      correct: round.correct,
      asked: round.asked,
    };

    const next = round.questions[round.index];
    if (!next) {
      const kind = round.kind;
      this.#round = null;
      return { ...base, finished: true, kind };
    }

    this.#seen.add(next.id);
    return {
      ...base,
      finished: false,
      question: asked(next, round.index, round.questions.length),
    };
  }

  end(): EndOutcome {
    const round = this.#round;
    if (!round) return { ended: false, reason: "no_game_running" };
    this.#round = null;
    return { ended: true, kind: round.kind, correct: round.correct, asked: round.asked };
  }
}
