# ADR 0010 — Brain games and trivia: a bank the tool marks, not a quiz the model improvises

**Status:** Accepted · **Date:** 2026-09-04
Extends [02 §5](../02-data-contracts.md#5-tool-call-contract) with the first tool that spans
turns. Constrains [ADR 0009](0009-audio-intelligence.md): nothing here feeds care signals.

## Context

A companion device that only answers questions is a utility. The thing people actually ask a
companion for, once the novelty of asking it the time has worn off, is something to *do* — and
for the audience this product is built for, that is overwhelmingly a quiz, a puzzle or a
familiar saying to finish.

Three facts about this system decide the shape of the answer.

**1. Every user-facing string costs eleven translations, and nine of them are placeholders.**
Six short fillers and five refusals are still unreviewed
([copy/fillers.ts](../../ai/src/copy/fillers.ts)), and the server warns about it at boot. A
question bank translated eleven ways would be an order of magnitude more text than the entire
existing copy surface, with a correctness requirement on top of a fluency one. That route is
not a large job; it is an unshippable one.

**2. The model is already multilingual, and is already in the loop.** `get_news` fetches an
English RSS headline and it reaches the user in Hindi, because the model narrates it. Nothing
about a trivia question is different — "which river flows past Varanasi" is the same question
in Odia.

**3. The turn window is twelve.** A five-question round with a reply on each side fills it, so
anything remembered only in the model's context is lost partway through the round that
produced it.

## Decision

**Games are tools, and the tool marks the answer.**

`start_game` returns a question and no key. `answer_game` takes what the user said, judges it
locally, and returns the verdict, the canonical answer and the score. `end_game` stops early.
The round lives on the session ([domain/games/controller.ts](../../ai/src/domain/games/controller.ts)),
reached through `SessionToolHost` the way `play_music` reaches the device.

**Content is split by whether it survives translation**, which is the load-bearing decision:

| Kind | Source | Available in |
|---|---|---|
| `trivia` | authored once in English, narrated by the model | all eleven |
| `numbers` | **generated** — digit span, serial sevens, sequences | all eleven |
| `proverbs` | authored per language | `en-IN`, `hi-IN` |

`numbers` is the kind that pays for itself twice: digits are not a language, so it costs no
content at all and cannot be factually wrong, and it is the only one of the three that is a
brain game in the literal sense rather than a recall game.

**A score is never presented as a measurement of the person.** A near miss counts as correct,
an "I don't know" costs nothing, the round is five questions and not twenty, and — the part
that is a decision rather than a preference — **no game result reaches care signals, ever.**

## Why not the alternatives

**Let the model improvise the quiz.** Free, and it works in all eleven languages tomorrow. It
has no answer key: the model marks its own homework, and a companion that confidently tells an
eighty-year-old their right answer was wrong is worse than one that never offered. It also
cannot avoid repeating itself across days, and it puts the instructions in `SYSTEM_PROMPT` —
a stable cached prefix, paid for on every turn of every conversation to serve something that
happens twice a week. This is the argument `get_time` already makes for being a tool.

**Let the model judge, with the key in its context.** Removes the matcher entirely and handles
paraphrase for free. It also leaks: a model holding "Ganga" writes "starts with a G?" without
being asked to, and the game is over before it began. The key now reaches the model exactly
once, in the result of the answer that earned it.

**Fetch questions from a trivia API.** English-only, third-party-hosted, and it would drag the
whole opt-in residency apparatus ([external.ts](../../ai/src/tools/external.ts), Q14) behind a
static dataset that does not change. The bank ships in the repo.

**A translated bank.** See context (1).

**Gate it behind `GAMES_ENABLED`.** Games need no key, no feed and no upstream, so the rule
that governs every other optional tool — unconfigured means unregistered — has nothing to bite
on. A flag with no configuration behind it would be a knob for a problem nobody has measured.

## Consequences

- **The zero-configuration tool list goes from eight to eleven**, and a deployment with weather
  and news to thirteen. `builtin.ts` already notes that eight is more than a companion needs
  for most turns and that selection quality at a realistic tool count is unmeasured (ADR 0003).
  This makes that the first thing to measure, not a background worry. If it degrades, the
  fallback is one `play_game` tool with an `action` argument — more compact, but `validateArgs`
  cannot express "required only when action is answer", so it trades precision for tokens.
- **Accept-lists are English and Devanagari.** A Malayalam speaker answering in Malayalam
  script may be marked wrong. This is the same missing multilingual embedder that limits
  `recall`, and it is the largest known hole in the feature.
- **Sayings need native review before shipping.** Proverbs vary by region and generation more
  than ordinary copy, and a speaker who learned a different second half is right and will be
  told otherwise.
- **A round does not survive the session.** Nothing is written to Redis or to long-term memory,
  so "what did I score yesterday" has no answer. The distiller will summarise a session that
  contained a game like any other, which gives continuity for free without a new store — and
  a durable score would need a per-user store this repo does not have, since a score is not a
  `Fact`.
- **The model must not be allowed to translate a saying.** `verbatim_language` on the returned
  question says so, and both tool descriptions repeat the rule, but nothing enforces it.
