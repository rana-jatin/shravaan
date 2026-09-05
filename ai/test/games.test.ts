/**
 * Brain games and trivia.
 *
 * Three things are worth testing here and the rest is bookkeeping.
 *
 * THE MATCHER, because it decides whether a person is told they are wrong. It
 * takes free speech that has been through ASR, so the interesting cases are all
 * the ways a right answer arrives looking wrong — inside a sentence, in another
 * script, as a word instead of a digit, with a syllable dropped.
 *
 * THE BANK INVARIANTS, because a question whose answer is sitting in its own
 * prompt is not a question, and nothing but a test will notice.
 *
 * THE ROUND, because the score is the thing a user will remember and the thing
 * that survives longest in their head after the session ends.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { digitsOf, judge, levenshtein, normalizeAnswer } from "../src/domain/games/answer-match.ts";
import { TRIVIA, TRIVIA_CATEGORIES } from "../src/domain/games/bank.ts";
import { PROVERBS } from "../src/domain/games/proverbs.ts";
import { generateNumberQuestions } from "../src/domain/games/numbers.ts";
import { kindsFor, pickRound, ROUND_LENGTH } from "../src/domain/games/catalogue.ts";
import { GameController } from "../src/domain/games/controller.ts";
import type { Question } from "../src/domain/games/types.ts";
import { GAME_TOOLS, answerGame, startGame } from "../src/tools/games.ts";
import { ToolRegistry, toSchema, validateArgs } from "../src/tools/registry.ts";
import { ToolExecutor } from "../src/tools/executor.ts";
import { INSTANT_MS } from "../src/tools/types.ts";
import { fakeHost, invocation } from "./helpers.ts";

/** A linear congruential generator. Seeded, so a "random" round is a fixture. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const AUTHORED: Question[] = [...TRIVIA, ...Object.values(PROVERBS).flat()];

describe("answer matching", () => {
  it("accepts the answer inside a spoken sentence", () => {
    assert.equal(judge("umm, the Ganges I think", ["Ganga", "Ganges"]), "correct");
    assert.equal(judge("is it Jaipur?", ["Jaipur"]), "correct");
  });

  it("accepts an answer given in another script on the accept-list", () => {
    assert.equal(judge("गंगा", ["Ganga", "Ganges", "गंगा"]), "correct");
    assert.equal(judge("मुझे लगता है मोर", ["peacock", "मोर"]), "correct");
  });

  it("calls a near miss close rather than wrong", () => {
    // What Saaras does to a proper noun. Being told this is wrong is the failure
    // the whole tolerance exists to prevent.
    assert.equal(judge("ganja", ["Ganga"]), "close");
    assert.equal(judge("tendulker", ["Tendulkar"]), "close");
  });

  it("still says wrong when it is wrong", () => {
    assert.equal(judge("Yamuna", ["Ganga", "Ganges"]), "wrong");
    assert.equal(judge("a giraffe", ["camel"]), "wrong");
  });

  it("folds English number words to digits", () => {
    assert.equal(normalizeAnswer("Twenty-Three!"), "23");
    assert.equal(normalizeAnswer("one hundred"), "100");
    assert.equal(judge("ninety three", ["93"]), "correct");
    assert.equal(judge("I think it is eighty six", ["86"]), "correct");
  });

  it("composes a number spoken in hundreds", () => {
    // The leap-year question rejected its own answer before this: the fold runs
    // left to right, so "three hundred and sixty six" had already become
    // "300 and 66" by the time the tail was known.
    assert.equal(normalizeAnswer("three hundred and sixty six"), "366");
    assert.equal(normalizeAnswer("three hundred sixty six"), "366");
    assert.equal(judge("three hundred and sixty six", ["366"]), "correct");
    // A year is said as two pairs and stays two tokens — "19 47" — and it is the
    // digit comparison, not the fold, that matches it. That already worked, so
    // the hundreds pass must leave it alone.
    assert.equal(normalizeAnswer("nineteen forty seven"), "19 47");
    assert.equal(digitsOf(normalizeAnswer("nineteen forty seven")), "1947");
    assert.equal(judge("nineteen forty seven", ["1947"]), "correct");
  });

  it("reads a number out of a sentence that contains other numbers", () => {
    // "100" must NOT swallow the 7 here — composition needs a bare number after
    // it, and "minus" is not one.
    assert.equal(judge("100 minus 7, so 93", ["93"]), "correct");
    assert.equal(normalizeAnswer("100 minus 7"), "100 minus 7");
  });

  it("hears the honorific and answers the name underneath it", () => {
    // Almost nobody in this audience says "Gandhi" bare. The suffix costs two
    // edits — one more than a six-letter name is allowed — so every honorific
    // answer was landing on "wrong".
    assert.equal(judge("Gandhiji", ["Mahatma Gandhi", "Gandhi"]), "correct");
    assert.equal(judge("गांधीजी", ["गांधी"]), "correct");
    assert.equal(judge("Nehruji", ["Jawaharlal Nehru", "Nehru"]), "correct");
    assert.equal(judge("Lataji", ["Lata Mangeshkar", "Lata"]), "correct");
    // The floor that stops it eating short words that merely end in those letters.
    assert.equal(normalizeAnswer("raji"), "raji");
  });

  it("does not accept a number that merely ends in the right digit", () => {
    assert.equal(judge("17", ["7"]), "wrong");
    assert.equal(judge("seventy", ["7"]), "wrong");
  });

  it("compares a digit span however it is spaced", () => {
    assert.equal(judge("4 9 2 7", ["4 9 2 7"]), "correct");
    assert.equal(judge("the numbers were 4927", ["4 9 2 7"]), "correct");
    assert.equal(judge("4 9 7 2", ["4 9 2 7"]), "wrong");
  });

  it("reads Devanagari digits as digits", () => {
    assert.equal(normalizeAnswer("९३"), "93");
    assert.equal(judge("९३", ["93"]), "correct");
  });

  it("strips Latin diacritics without touching Indic vowel signs", () => {
    assert.equal(normalizeAnswer("café"), "cafe");
    // The mark here is Devanagari's own, not the Latin combining block. Stripping
    // it would not normalise the word, it would destroy it.
    assert.equal(normalizeAnswer("गंगा"), "गंगा");
  });

  it("has a levenshtein that agrees with the arithmetic", () => {
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.equal(levenshtein("", "abc"), 3);
    assert.equal(levenshtein("same", "same"), 0);
    assert.equal(digitsOf("4 9 2 7"), "4927");
  });

  it("treats an empty accept-list and empty speech as unmatched, not a crash", () => {
    assert.equal(judge("", ["Ganga"]), "wrong");
    assert.equal(judge("Ganga", []), "wrong");
  });
});

describe("the authored banks", () => {
  it("has no duplicate question ids", () => {
    const ids = AUTHORED.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("gives every question at least one non-empty answer", () => {
    for (const q of AUTHORED) {
      assert.ok(q.answers.length > 0, `${q.id} has no answers`);
      for (const a of q.answers)
        assert.notEqual(normalizeAnswer(a), "", `${q.id} has a blank answer`);
    }
  });

  it("never leaves the answer sitting inside its own question", () => {
    // The one bank where this is legitimate is `numbers` — a digit span asks you
    // to repeat back what it just said — which is why only the authored banks
    // are checked here.
    for (const q of AUTHORED) {
      const prompt = normalizeAnswer(q.prompt);
      for (const a of q.answers) {
        assert.ok(!prompt.includes(normalizeAnswer(a)), `${q.id} gives away "${a}"`);
      }
    }
  });

  it("keeps trivia language-neutral and sayings language-bound", () => {
    // The whole design in one assertion: trivia carries no language because the
    // model narrates it anywhere; a proverb carries its own because translating
    // it would break the game. See src/domain/games/types.ts.
    for (const q of TRIVIA) assert.equal(q.language, undefined, `${q.id} should be neutral`);
    for (const [code, questions] of Object.entries(PROVERBS)) {
      assert.ok(questions.length > 0, `${code} is listed with no sayings`);
      for (const q of questions) assert.equal(q.language, code, `${q.id} is filed under ${code}`);
    }
  });

  it("uses only declared trivia categories", () => {
    for (const q of TRIVIA) {
      assert.ok(
        (TRIVIA_CATEGORIES as readonly string[]).includes(q.category),
        `${q.id} has an undeclared category "${q.category}"`,
      );
    }
  });

  it("holds more questions than a round asks for", () => {
    assert.ok(TRIVIA.length > ROUND_LENGTH * 2);
  });

  it("accepts every answer on its own accept-list", () => {
    // The invariant that caught the leap-year defect: an entry the normaliser
    // mangles into something the matcher then cannot find is a question that
    // rejects its own answer, and no round-level test would show it.
    for (const q of AUTHORED) {
      for (const a of q.answers) {
        assert.equal(judge(a, q.answers), "correct", `${q.id} rejects its own answer "${a}"`);
      }
    }
  });

  it("carries no answer that is also an ordinary English word", () => {
    // A single-token answer is matched against the TOKENS of whatever the user
    // said, so "am" as a romanisation of आम would score "I am not sure" as
    // correct. Romanised entries must not collide with common speech.
    const ambiguous = new Set([
      "a",
      "am",
      "an",
      "and",
      "are",
      "as",
      "at",
      "be",
      "but",
      "do",
      "for",
      "i",
      "if",
      "in",
      "is",
      "it",
      "me",
      "my",
      "no",
      "not",
      "of",
      "oh",
      "on",
      "or",
      "so",
      "the",
      "to",
      "up",
      "was",
      "we",
      "yes",
      "you",
    ]);
    for (const q of AUTHORED) {
      for (const a of q.answers) {
        const norm = normalizeAnswer(a);
        if (norm.includes(" ")) continue;
        assert.ok(!ambiguous.has(norm), `${q.id} would accept the bare word "${norm}"`);
      }
    }
  });
});

describe("generated number games", () => {
  it("is reproducible from a seed", () => {
    const a = generateNumberQuestions(5, seeded(7));
    const b = generateNumberQuestions(5, seeded(7));
    assert.deepEqual(a, b);
  });

  it("produces the requested count with distinct ids", () => {
    const qs = generateNumberQuestions(5, seeded(42));
    assert.equal(qs.length, 5);
    assert.equal(new Set(qs.map((q) => q.id)).size, 5);
  });

  it("generates questions its own matcher accepts", () => {
    // A generator that emits an answer the matcher rejects is a game that cannot
    // be won, and the two halves live far enough apart to drift.
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of generateNumberQuestions(6, seeded(seed))) {
        assert.equal(judge(q.answers[0]!, q.answers), "correct", `${q.id} rejects its own answer`);
      }
    }
  });
});

describe("the catalogue", () => {
  it("offers sayings only where they are authored", () => {
    assert.deepEqual(kindsFor("hi-IN"), ["trivia", "numbers", "proverbs"]);
    assert.deepEqual(kindsFor("en-IN"), ["trivia", "numbers", "proverbs"]);
    assert.deepEqual(kindsFor("or-IN"), ["trivia", "numbers"]);
    assert.deepEqual(kindsFor("ta-IN"), ["trivia", "numbers"]);
  });

  it("falls back rather than refusing when a kind is unavailable", () => {
    const plan = pickRound({ kind: "proverbs", language: "or-IN", random: seeded(3) });
    assert.ok(plan);
    assert.equal(plan.kind, "trivia");
  });

  it("honours a kind the language does have", () => {
    const plan = pickRound({ kind: "proverbs", language: "hi-IN", random: seeded(3) });
    assert.equal(plan?.kind, "proverbs");
    assert.ok(plan?.questions.every((q) => q.language === "hi-IN"));
  });

  it("filters trivia by category, and ignores a category it does not know", () => {
    const food = pickRound({ category: "food", language: "en-IN", count: 3, random: seeded(5) });
    assert.equal(food?.category, "food");
    assert.ok(food?.questions.every((q) => q.category === "food"));

    const nonsense = pickRound({ category: "temples", language: "en-IN", random: seeded(5) });
    assert.equal(nonsense?.category, "mixed");
    assert.equal(nonsense?.questions.length, ROUND_LENGTH);
  });

  it("prefers unseen questions but still plays once the pool is exhausted", () => {
    const exclude = new Set(TRIVIA.map((q) => q.id));
    const plan = pickRound({ language: "en-IN", exclude, random: seeded(9) });
    assert.equal(plan?.questions.length, ROUND_LENGTH);
  });
});

describe("a round", () => {
  const controller = (seed = 11) => new GameController({ random: seeded(seed) });

  it("asks a question without handing over the answer", () => {
    const started = controller().start({ language: "en-IN" });
    assert.ok(started.started);
    // The key must not travel with the question — a model holding it telegraphs
    // it. See the header of src/domain/games/answer-match.ts.
    assert.deepEqual(Object.keys(started.question).sort(), [
      "of",
      "prompt",
      "question_no",
      "verbatim_language",
    ]);
    assert.equal(started.question.question_no, 1);
    assert.equal(started.question.of, ROUND_LENGTH);
  });

  it("marks a saying as verbatim and trivia as narratable", () => {
    const saying = controller().start({ kind: "proverbs", language: "hi-IN" });
    assert.ok(saying.started);
    assert.equal(saying.question.verbatim_language, "hi-IN");

    const trivia = controller().start({ kind: "trivia", language: "hi-IN" });
    assert.ok(trivia.started);
    assert.equal(trivia.question.verbatim_language, null);
  });

  it("says what it started instead of what was asked for", () => {
    const g = controller();
    const started = g.start({ kind: "proverbs", language: "or-IN" });
    assert.ok(started.started);
    assert.equal(started.kind, "trivia");
    assert.equal(started.instead_of, "proverbs");
  });

  it("does not claim a substitution when it played what was asked", () => {
    const started = controller().start({ kind: "numbers", language: "or-IN" });
    assert.ok(started.started);
    assert.equal(started.kind, "numbers");
    assert.equal(started.instead_of, undefined);
  });

  it("scores a full round and finishes", () => {
    const g = new GameController({ random: seeded(2), roundLength: 3 });
    const started = g.start({ kind: "numbers", language: "en-IN" });
    assert.ok(started.started);

    let outcome = g.answer("no idea at all");
    assert.ok(outcome.judged && !outcome.finished);
    assert.equal(outcome.verdict, "wrong");
    assert.equal(outcome.correct, 0);
    assert.equal(outcome.asked, 1);
    assert.equal(outcome.question.question_no, 2);

    outcome = g.answer("still no idea");
    assert.ok(outcome.judged && !outcome.finished);

    outcome = g.answer("nor this one");
    assert.ok(outcome.judged && outcome.finished);
    assert.equal(outcome.asked, 3);
    assert.equal(g.playing, false);
  });

  it("counts a right answer, and gives the canonical wording back either way", () => {
    const g = new GameController({ random: seeded(4), roundLength: 2 });
    g.start({ kind: "trivia", category: "food", language: "en-IN" });
    // Answer every accept-list entry at once: whatever the seeded round picked,
    // one of these is right, and the score has to move exactly once.
    const outcome = g.answer("turmeric milk rice mango");
    assert.ok(outcome.judged);
    assert.equal(outcome.verdict, "correct");
    assert.equal(outcome.correct, 1);
    assert.ok(outcome.correct_answer.length > 0);
  });

  it("scores a near miss as correct and still reports it as close", () => {
    // Built from whichever question the round actually served, because a fixed
    // near miss is only near for one answer — and a mangled answer is not always
    // a near miss anyway: mangle "Satyajit Ray" and the accept-list entry "Ray"
    // is still sitting there intact, so the round scores it outright correct.
    // Hunting for a seed that produces a genuine near miss keeps the assertion
    // exact without pinning the test to one row of the bank.
    for (let seed = 1; seed <= 50; seed++) {
      const g = new GameController({ random: seeded(seed), roundLength: 1 });
      const started = g.start({ kind: "trivia", language: "en-IN" });
      assert.ok(started.started);
      const near = nearMissFor(questionOf(started.question.prompt));
      if (near === null) continue;

      const outcome = g.answer(near);
      assert.ok(outcome.judged);
      assert.equal(outcome.verdict, "close");
      // The point of the whole tolerance: it counts. See the note on Verdict.
      assert.equal(outcome.correct, 1);
      return;
    }
    assert.fail("no seed produced a question with a genuine near miss");
  });

  it("treats an empty answer as a pass, not as a wrong answer", () => {
    const g = new GameController({ random: seeded(6), roundLength: 2 });
    g.start({ kind: "trivia", language: "en-IN" });
    const outcome = g.answer("   ");
    assert.ok(outcome.judged);
    // `asked` still rises — the tally stays honest — but nobody was marked wrong
    // for saying they did not know.
    assert.equal(outcome.verdict, "passed");
    assert.equal(outcome.correct, 0);
    assert.equal(outcome.asked, 1);
  });

  it("answers a question nobody asked with data, not an error", () => {
    const g = controller();
    assert.deepEqual(g.answer("Ganga"), { judged: false, reason: "no_game_running" });
    assert.deepEqual(g.end(), { ended: false, reason: "no_game_running" });
  });

  it("ends early and reports the score so far", () => {
    const g = new GameController({ random: seeded(8), roundLength: 5 });
    g.start({ kind: "numbers", language: "en-IN" });
    g.answer("wrong");
    const ended = g.end();
    assert.deepEqual(ended, { ended: true, kind: "numbers", correct: 0, asked: 1 });
    assert.equal(g.playing, false);
  });

  it("replaces a round in flight rather than running two at once", () => {
    const g = controller();
    g.start({ kind: "trivia", language: "en-IN" });
    const second = g.start({ kind: "numbers", language: "en-IN" });
    assert.ok(second.started);
    assert.equal(second.kind, "numbers");
    assert.equal(second.question.question_no, 1);
  });

  it("does not ask the same question twice in a session", () => {
    const g = new GameController({ random: seeded(13), roundLength: 5 });
    const seen: string[] = [];
    for (let round = 0; round < 3; round++) {
      const started = g.start({ kind: "trivia", language: "en-IN" });
      assert.ok(started.started);
      seen.push(started.question.prompt);
      for (let i = 1; i < 5; i++) {
        const outcome = g.answer("pass");
        if (outcome.judged && !outcome.finished) seen.push(outcome.question.prompt);
      }
    }
    assert.equal(new Set(seen).size, seen.length);
  });
});

/** Whichever authored question carries this prompt. */
function questionOf(prompt: string): Question {
  const found = AUTHORED.find((q) => q.prompt === prompt);
  assert.ok(found, `no authored question with prompt "${prompt}"`);
  return found;
}

/**
 * One substitution that the matcher genuinely calls a near miss — roughly what
 * ASR does to a name. Null when no single edit lands in that band, which is the
 * normal case for a short answer: one edit in "milk" is a different word.
 */
function nearMissFor(question: Question): string | null {
  const answer = question.answers[0]!;
  for (let at = 1; at < answer.length; at++) {
    const chars = [...answer];
    chars[at] = chars[at] === "x" ? "z" : "x";
    const candidate = chars.join("");
    // Judged against the WHOLE accept-list, the way the round will judge it —
    // an alternate left intact by the edit makes this outright correct, which
    // is not what this test is looking for.
    if (judge(candidate, question.answers) === "close") return candidate;
  }
  return null;
}

describe("the game tools", () => {
  const hostWith = (g: GameController) => fakeHost({ games: () => g });

  it("registers exactly the three that make a playable set", () => {
    assert.deepEqual(
      GAME_TOOLS.map((t) => t.name),
      ["start_game", "answer_game", "end_game"],
    );
    // In-process work. The 8 s default is sized for a network call, and a filler
    // pinned at the deadline can never fire — "one moment" before an instant
    // answer makes a fast companion feel slow. Same shape as the built-ins.
    for (const t of GAME_TOOLS) {
      assert.equal(t.deadline_ms, INSTANT_MS);
      assert.equal(t.filler_threshold_ms, INSTANT_MS);
      assert.equal(t.progress_key, undefined);
      assert.equal(t.mutates_context ?? false, false);
      // Games need no key, no feed and no upstream, so nothing gates them.
      assert.equal(t.requires_entitlement, undefined);
    }
  });

  it("never puts the answer key in what start_game returns", async () => {
    // The invariant the whole design exists to hold. A model that can see the
    // answer telegraphs it, so this is asserted against the SERIALISED result —
    // the exact bytes the model would receive.
    const host = hostWith(new GameController({ random: seeded(21) }));
    const data = await startGame.handler({}, invocation({ host, language: "en-IN" }));

    const wire = JSON.stringify(data);
    for (const answer of questionOf(String(data["question"])).answers) {
      assert.ok(!wire.includes(answer), `start_game leaked "${answer}"`);
    }
    assert.equal(data["question_no"], 1);
    assert.equal(data["of"], ROUND_LENGTH);
  });

  it("releases the answer only once it has been earned", async () => {
    const g = new GameController({ random: seeded(21), roundLength: 2 });
    const host = hostWith(g);
    const started = await startGame.handler({}, invocation({ host, language: "en-IN" }));
    const answer = questionOf(String(started["question"])).answers[0]!;

    const judged = await answerGame.handler({ answer }, invocation({ host, language: "en-IN" }));
    assert.equal(judged["verdict"], "correct");
    assert.equal(judged["score"], 1);
    assert.equal(judged["correct_answer"], answer);
  });

  it("passes an empty answer through as a pass", async () => {
    const g = new GameController({ random: seeded(22), roundLength: 2 });
    const host = hostWith(g);
    await startGame.handler({}, invocation({ host, language: "en-IN" }));
    const judged = await answerGame.handler({ answer: "" }, invocation({ host }));
    assert.equal(judged["verdict"], "passed");
    assert.equal(judged["score"], 0);
  });

  it("tells the model which question must not be translated", async () => {
    const g = new GameController({ random: seeded(23) });
    const saying = await startGame.handler(
      { kind: "proverbs" },
      invocation({ host: hostWith(g), language: "hi-IN" }),
    );
    assert.equal(saying["verbatim_language"], "hi-IN");

    const trivia = await startGame.handler(
      { kind: "trivia" },
      invocation({ host: hostWith(new GameController({ random: seeded(23) })), language: "hi-IN" }),
    );
    assert.equal(trivia["verbatim_language"], null);
  });

  it("says what it played when the language has no such game", async () => {
    const g = new GameController({ random: seeded(24) });
    const started = await startGame.handler(
      { kind: "proverbs" },
      invocation({ host: hostWith(g), language: "or-IN" }),
    );
    assert.equal(started["kind"], "trivia");
    assert.equal(started["instead_of"], "proverbs");
  });

  it("answers a game nobody started with data, not an error", async () => {
    // The distinction the whole tool layer turns on: `ok: false` costs a
    // spoken_fallback_key and every key costs eleven translations. "There is no
    // game running" is conversation, not infrastructure. See tools/builtin.ts.
    const registry = new ToolRegistry();
    for (const spec of GAME_TOOLS) registry.register(spec);
    const executor = new ToolExecutor({
      registry,
      uid: "u1",
      sid: "s1",
      host: hostWith(new GameController({ random: seeded(25) })),
      speakFiller: () => {},
    });

    const result = await executor.execute(
      { call_id: "c1", name: "answer_game", args: { answer: "Ganga" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.ok(result.ok);
    assert.equal(result.data["judged"], false);
    assert.equal(result.data["reason"], "no_game_running");
  });

  it("runs a whole round through the executor", async () => {
    const registry = new ToolRegistry();
    for (const spec of GAME_TOOLS) registry.register(spec);
    const host = hostWith(new GameController({ random: seeded(26), roundLength: 3 }));
    const executor = new ToolExecutor({
      registry,
      uid: "u1",
      sid: "s1",
      host,
      speakFiller: () => {},
    });
    const call = (name: string, args: Record<string, unknown>) =>
      executor.execute(
        { call_id: `c-${name}-${Math.random()}`, name, args },
        { language: "en-IN", jsonContext: null },
      );

    const started = await call("start_game", { kind: "numbers" });
    assert.ok(started.ok);
    assert.equal(started.data["kind"], "numbers");

    let finished = false;
    for (let i = 0; i < 3 && !finished; i++) {
      const judged = await call("answer_game", { answer: "" });
      assert.ok(judged.ok);
      finished = judged.data["finished"] === true;
    }
    assert.ok(finished, "a three-question round should finish in three answers");

    // Nothing is left in flight on any path — the invariant executor.ts exists
    // to hold.
    assert.equal(executor.pendingCount, 0);

    const ended = await call("end_game", {});
    assert.ok(ended.ok);
    assert.equal(ended.data["ended"], false);
  });

  it("claims strict mode only where its schema actually conforms", () => {
    // `strict` with an optional property is a 400 from OpenAI and an untested
    // path on Sarvam. start_game deliberately has optional arguments, so it must
    // not claim it; answer_game requires its one argument, so it may.
    // Through the registry, because that is what fills in the deadline defaults
    // a `ToolSpec` leaves out — and it is the registered definition the model
    // is actually shown.
    const registry = new ToolRegistry();
    for (const spec of GAME_TOOLS) registry.register(spec);
    const schemas = Object.fromEntries(registry.all().map((t) => [t.name, toSchema(t)] as const));
    assert.equal("strict" in schemas["answer_game"]!.function, true);
    assert.equal("strict" in schemas["end_game"]!.function, true);
    assert.equal("strict" in schemas["start_game"]!.function, false);
  });

  it("rejects an argument the model invented", () => {
    const start = new ToolRegistry().register(startGame).get("start_game")!;
    // A stray key on a tool that DOES declare parameters is a hallucination, and
    // acting on it means acting on something the user never asked for.
    assert.equal(validateArgs(start, { kind: "trivia", difficulty: "hard" }).ok, false);
    assert.equal(validateArgs(start, { kind: "crossword" }).ok, false);
    assert.equal(validateArgs(start, { kind: "trivia", category: "food" }).ok, true);
    assert.equal(validateArgs(start, {}).ok, true);
  });
});
