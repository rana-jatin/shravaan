# ADR 0009 — Deepgram Audio Intelligence: text, not audio; worker, not turn

**Status:** Accepted · **Date:** 2026-08-31
**Raises** [Q17](../05-open-questions.md) and [Q18](../05-open-questions.md).
Extends [02 §4.2](../02-data-contracts.md#42-episode--longitudinal-store-append-only)
with an optional `signals` field on the episode.

## Context

Deepgram markets four analyses under **Audio Intelligence**: summarisation, topic detection,
intent recognition and sentiment analysis. They are also sold as **Text Intelligence**, which
is the same four features on the same models reached at a different endpoint.

| | Audio Intelligence | Text Intelligence |
|---|---|---|
| Endpoint | `POST /v1/listen` (pre-recorded) | `POST /v1/read` |
| Input | audio file or hosted URL | `{"text"}` or `{"url"}`, `language=en` required |
| Params | `summarize=v2` · `topics` · `intents` · `sentiment` | the same four |
| Languages | English only | English only |
| Limits | 150K input tokens (400 over) · `summarize` needs >50 words | the same |

Both run the analysis over a **transcript**. The audio endpoint just transcribes first. Neither
reads prosody: nothing here can tell you an eighty-year-old *sounded* tired, breathless or
frightened, only that they used words a model scored low. That is worth stating plainly because
the product name implies otherwise, and a care product built on the implication would be built
on nothing.

Four facts about our own system decide what follows.

**1. Two of the four features already exist here, in eleven languages.** `LlmDistiller`
([memory/distiller.ts](../../src/memory/distiller.ts)) writes `summary`, `topics` and `mood`
onto every episode, in the language the person actually spoke. Deepgram's summarisation and
topic detection are an English-only duplicate of working code.

**2. There is no audio to send.** This system streams PCM and drops it. Using `/v1/listen`
would mean introducing recording and retention of an elderly person's home conversations —
a different product with a different consent story, not a feature flag.

**3. English only, against an eleven-language product.** Ten of our languages get nothing,
permanently. This is the same shape as the Flux ASR standby (ADR 0006), and it has the same
consequence: whatever we build must be correct when it is *absent*, because absent is the
common case.

**4. An English-only classifier handed a Hindi transcript does not fail loudly.** It returns a
number. That is D9 — Open-Meteo returning weather for Razavi Khorasan, fluent and confident and
about the wrong thing ([07 §D9](../07-defect-register.md)).

## Decision

### 1. `/v1/read`, never `/v1/listen`

The transcript is already in `mem:writes`. Sending it costs no new retention, no new consent
question about recording, and gets the identical analysis. The audio endpoint is not wired and
should not be.

### 2. It runs in the memory worker. Nothing on the voice path calls Deepgram

The analysis happens in `MemoryWorker` when a session closes — minutes to hours after the
person stopped talking, in a consumer loop nobody is waiting on. This is the only place in the
system where a third-party round trip costs a user nothing.

The turn loop never calls it. Not on a turn, not at session close, not behind a spoken filler.
A companion that pauses mid-conversation to have its user's mood scored would blow the latency
budget ([03](../03-latency-budget.md)) and would be the wrong product besides.

The one user-facing surface, `recall_mood`, reads episodes from the **local store** —
`listEpisodes` plus `moodTrend`, both in-process. Its deadline is the 2.5 s store budget, not
the 8 s network one, because it never touches a network.

### 3. Summarisation and topics are dropped; sentiment and intents are kept

`summarize` and `topics` stay off: the distiller already does both, better, in eleven
languages. What Deepgram adds that we do not have:

- **numeric, segment-level sentiment** (−1..1). `mood` is one coarse label from an LLM already
  doing five other jobs in the same call; a number is trendable across days.
- **`custom_intent` in `strict` mode** — a fixed, human-reviewed watch-list of care-relevant
  intents. Strict is the point: it returns only what we submitted, so nothing unreviewed can
  reach a caregiver.

### 4. Signals are written onto the episode, before it is written

`Episode.signals?: CareSignals`. Episodes are append-only and never edited
([02 §4.2](../02-data-contracts.md#42-episode--longitudinal-store-append-only)) — that
invariant is what makes "three weeks ago you said…" answerable — so the analysis completes
before the episode is constructed, or it is not part of it. The call is bounded by
`CARE_SIGNALS_DEADLINE_MS`; past that the episode is written without signals. Consumer lag is a
user-visible quality metric ([01 §7](../01-architecture.md)), and an unbounded HTTP call inside
the worker is how it stops being one.

No retries. A session whose analysis failed simply has none; the next session is a fresh chance
at the trend. Trading a missing data point for lag is the wrong way round.

### 5. It is never an alarm path

Tempting and wrong. [`emergency-intent.ts`](../../src/copy/emergency-intent.ts) is local,
pre-network and sub-second precisely because a call for help cannot wait on anything, and it
covers all eleven languages. Wiring a batch, English-only, third-party classifier to the
alerter would layer slow partial coverage over fast full coverage and invite someone to trust
the wrong one. `flagged_intents` informs a caregiver's reading of the week. Nothing more.

### 6. Off by default

Three independent reasons, any one sufficient: **residency** (transcripts leave India — Q14,
one notch down from routing the voice itself), **coverage** (ten of eleven languages get
nothing), and **consent** (scoring how someone sounded and keeping the trend is a different
promise from remembering what they told you). The server refuses to boot with the feature on
and no key, rather than silently writing nothing for a week.

## Consequences

**What we get.** A trend a caregiver can read, and a watch-list that fires retrospectively on
things the conversation itself did not escalate — for English-speaking users, on days they
talked for more than fifty words.

**What it costs.** A second provider in the memory path. Up to `CARE_SIGNALS_DEADLINE_MS` of
consumer lag per closed English session. A watch-list that is a product decision wearing
engineering clothes, and an intent-confidence floor that is a **guess** until someone tunes it
against real transcripts.

**What is unverified.** Every field name in
[`deepgram-read.ts`](../../src/providers/deepgram-read.ts) is reconstructed from documentation.
README's table records five such guesses about Sarvam that were wrong, two of which failed
*silently*. Here a wrong field name produces a 200, a `null`, a log line reading "no signals",
and a permanently flat trend that nobody questions. **Run `npm run verify:care` against a live
key before trusting any of it.**

## Alternatives rejected

**Sentiment on the live stream.** The feature pages carry a `Streaming:Nova` badge, but the
streaming feature matrix lists only Entity Detection under Intelligence — the two contradict
each other (Q17). Moot regardless: our Deepgram path is Flux `/v2/listen`, which has none of
these features, and a per-turn mood score is not information the model needs to answer.

**A model-callable `analyse_my_mood` tool.** Wrong latency, wrong language coverage, and an
assistant that introspects its user on demand mid-conversation is a different and worse
product.

**Attaching signals to the episode afterwards.** Requires editing an append-only record. The
bounded-and-before ordering is cheaper than a second mutable account of what happened.
