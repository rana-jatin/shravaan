# 05 — Open questions

Everything that could not be resolved from the documentation. Recorded rather than guessed.

Each entry states the question, why it matters, what the docs actually say, and how to
settle it. Ordered by how much they block.

---

## Blocking — must be answered before code

### Q1. What is the auto-detect token on `saaras:v3-realtime`, and does per-turn switching work on the raw socket?

**Why it matters.** Free language switching on any turn is a product requirement. This
question decides whether it is buildable on our default ASR provider.

**What the docs say — three pages, two tokens, one contradiction:**

| Page | Claim |
|---|---|
| [Saaras model](https://docs.sarvam.ai/api/getting-started/models/saaras.md) | Auto-detects "when not specified or set to **`unknown`**", returning `language_probability` |
| [Realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming) | `language_code` accepts 24 values **including `auto`**; partials and finals then carry a detected `language` field |
| [Streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api) | `language_code` is **"Required"**; auto-detect exists only on the translate endpoint |

Complicating it: Sarvam's *managed* Voice Agents demonstrably does mid-conversation
switching — "Switch language during call", "Auto-detected language switch",
`AGENT_LANGUAGE = "unknown"`
([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) —
but that runs in **their** orchestration layer, which we are not using
([00 §7.5](00-provider-research.md#75-sarvam-voice-agents-cannot-host-this-architecture--proven-not-inferred)).
The capability clearly exists in the model; what is unconfirmed is what the raw socket
exposes.

**ANSWERED — 2026-08-29, against a live key. The token is `auto`.**

The socket was opened with every candidate. `auto` is accepted; `unknown` is rejected
outright, and the rejection names the supported set:

```
4000 Unsupported language_code 'unknown'. Supported values: auto, hi-IN, bn-IN,
kn-IN, ml-IN, mr-IN, or-IN, pa-IN, ta-IN, te-IN, …
```

So the **realtime streaming page was right** and the Saaras model page — the source of
`unknown`, and of our default — describes the batch endpoint, not this socket. Two
consequences, both now fixed:

- `ASR_AUTODETECT_TOKEN` defaulted to `unknown`, which is every session with no profile
  and no locale hint. It now defaults to `auto`.
- The list says **`or-IN`**. We used `od-IN` throughout, which is not an ISO 639-1 code
  and was rejected — Odia could never have worked. Renamed repo-wide.

Also confirmed live: `hi-IN` speech transcribes, and finals carry a detected language
(`gate2` logged `detected: hi-IN` from a Hindi clip).

**Still open:** whether a *mid-stream* switch works — `config.update` with a new
`language_code`, or `auto` following the speaker from Hindi into English within one
connection. That needs the bilingual utterance from
[Slice 0](04-milestones.md#slice-0--two-listening-tests-half-a-day-no-product), and a
person to speak it.

---

### Q2. Is a Bulbul speaker the same perceived person across languages?

**Why it matters.** A companion has one persona. If speaker `Shubh` sounds like a different
person in Hindi than in Tamil, free language switching breaks the character the user has
formed a relationship with. For a phone agent this is cosmetic; here it is the product.

**What the docs say.** Nothing. Bulbul v3 lists 30+ speakers across 11 languages
([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)), and the
voice-and-language page was read directly — it **does not address voice identity across a
language switch**
([speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)).

**Partial mitigations, both documented, both insufficient alone:** a per-language
pronunciation dictionary (JSON, ≤5 MB) fixes names, not timbre; voice cloning is
enterprise-only.

**How to settle it.** Synthesise the same content with one speaker across `hi-IN`, `en-IN`
and `ta-IN` and listen. This is a judgement call, not a metric — get more than one person
to listen.

---

### Q3. Does one Bulbul voice carry a code-mixed sentence without a seam?

**Why it matters.** Hinglish is how the target users actually speak. If the TTS produces an
audible break at every English word inside a Hindi sentence, either the output is degraded
or the LLM must be constrained to single-language responses — which changes the prompt
contract and the product's voice.

**What the docs say.** Nothing for Bulbul. The only code-switching TTS claim anywhere in
either provider's documentation is that five Aura-2 **Spanish** voices "support codeswitching
between Spanish and English" ([voices](https://developers.deepgram.com/docs/tts-models)) —
which tells us the capability is something vendors call out when present, and Sarvam has not
called it out.

**How to settle it.** Synthesise twenty realistic Hinglish sentences and listen. Use the
register the LLM will actually produce, not textbook sentences.

---

## Significant — shape the design, needed before the affected slice

### Q4. Does Sarvam streaming expose any ASR confidence?

**Why it matters.** The degradation rule "low ASR confidence → targeted reprompt naming the
uncertain slot" has no documented input on our default provider.

**What the docs say.** `language_probability` is documented — but it scores *language
identification*, not transcription
([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)). The realtime page
documents `return_timestamps` adding utterance-level `start_s`/`end_s`, and no confidence
field ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)).
Deepgram Flux, by contrast, exposes `word.confidence` per word.

**If the answer is no**, we need a substitute trigger. Candidates: LLM-side slot uncertainty;
a mandatory confirmation policy on high-stakes slots; or routing confidence-critical
interactions to Deepgram where the language allows. `SlotValue.asr_confidence` is already
optional in [02](02-data-contracts.md) for this reason.

**How to settle it.** Inspect a raw `transcript.final` frame. Ten minutes with an API key.

---

### Q5. What are Sarvam's actual latency numbers?

**Why it matters.** Three of the eight stages in [03](03-latency-budget.md) have no
documented basis at all.

**What the docs say.** Nothing quantitative, anywhere. TTS is graded qualitatively —
"Lowest on a warm connection"
([which API](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-api-to-use)).
No STT figure, no LLM first-token figure, none in the Voice Agents docs.

**Caveat worth chasing first.** Sarvam's three marketing pages —
`www.sarvam.ai/speech-to-text`, `/text-to-speech`, `/models` — **all returned HTTP 403** to
automated fetching. If Sarvam publishes latency claims anywhere, that is the likely place.
**Someone should open these in a browser** before we conclude the numbers do not exist.

**How to settle it.** The harness in [03 §5](03-latency-budget.md#5-what-must-be-measured-before-this-is-a-budget).

---

### Q6. What are the real VAD and endpointing defaults?

**Why it matters.** Endpointing latency dominates the largest stage in the budget, and
`silence_duration_ms` directly trades responsiveness against false turn-ends.

**What the docs say.** The realtime socket accepts `threshold`, `silence_duration_ms` and
`min_speech_duration_ms` — **with no defaults, ranges or units guidance published**
([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)).
Sarvam's managed product exposes them only as qualitative sliders: "Sound sensitivity"
(Low–High), "Eagerness to respond" (Patient–Eager)
([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)).
Deepgram by contrast publishes exact ranges and defaults for all three Flux parameters.

**How to settle it.** Empirical sweep during slice 2.

---

### Q6b. Where does the memory worker's idempotency ledger live?

**Why it matters.** `mem:writes` is at-least-once, so the worker dedupes on
`event_id`. That ledger is currently **in-process**, which is correct for one
replica and wrong for two: a second worker would not see the first's history, and
duplicated facts in a companion read as the bot repeating itself.

**Not a provider question — ours.** The fix is a Redis `SET`/`SETNX` keyed on
`event_id` with a TTL comfortably longer than the retry window. Needed before the
worker is ever run with more than one replica, and worth deciding before that
happens accidentally.

**Related:** an embedding model must also be chosen before retrieval is trusted.
The current `HashingEmbedder` is lexical only — it cannot match "They live in
Bengaluru" against "वे बेंगलुरु में रहते हैं", and our facts are multilingual by
construction. There is a test asserting that failure so it stays visible.
See [ADR 0004](adr/0004-vector-store.md).

### Q7. Does `mem:writes` get buffered during a Redis outage, or is the gap accepted? — **RESOLVED**

**Answer: buffered, bounded, and every drop counted.** A 500-event in-process buffer; on
overflow it evicts the oldest event of the *lowest priority* present
(`correction` > `session_closed` > `explicit_recall` > `turn_completed`), because losing a
correction leaves a superseded fact standing as current and that is worse than losing a
detail. `droppedCount` is a product metric beside consumer lag, not a debug counter.

Rejected: dropping silently (forbidden by [02 §6](02-data-contracts.md#6-invalidation-rules)),
buffering without limit (turns a memory outage into an OOM), and blocking the turn path
(inverts the asymmetry the seam exists to create).

**The accepted residual loss:** the buffer is in-process, so a crash during an outage loses
the backlog. A durable write-ahead log is a second storage system introduced to survive an
outage of the first; `droppedCount` in production is the evidence that would justify it.

**Decided in** [ADR 0008](adr/0008-degradation-policy.md). Built in slice 8.

---

## Worth knowing — do not block, but affect planning

### Q8. Does `saaras:v4` have a realtime variant?

`saaras:v4` is described as the latest model, adding Global English on top of the same 22
Indic languages ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)). But
**the realtime socket accepts only `saaras:v3-realtime`**
([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)),
and the managed agent product also pins Saaras v3
([models](https://docs.sarvam.ai/conversations/build/models)). Whether a v4 realtime variant
is coming, and on what timeline, affects whether we design around v3's characteristics.

### Q9. Is the agent canvas's pitch control inert on Bulbul v3?

The model page says v3 "does **not** support pitch/loudness"
([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)); the canvas exposes a
pitch slider ([speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)).
Either the control is inert or the model page is stale. Minor, but pitch is a lever a
companion persona would plausibly want.

### Q10. Does Sarvam support diarization on streaming?

Not documented for streaming; priced only as a batch add-on (₹45/hr vs ₹30/hr base)
([pricing](https://docs.sarvam.ai/api/getting-started/pricing)). Not needed for a
single-user device — becomes relevant only if shared-device use appears, where telling
family members apart would matter for memory attribution.

### Q11. How do Sarvam's concurrency and rate limits interact for long idle sessions?

Two different limits: STT WebSocket **concurrent connections** (20 Starter / 100 Pro / 100
Business) and Sarvam-105B **requests per minute** (40 / 60 / 120)
([rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)). A companion holds
sockets open through long silences, so concurrent connections may bind well before request
rate does. Unclear whether an idle socket counts against the limit for its whole lifetime,
and whether TTS sockets closed by the ~1 minute idle timeout free their slot immediately.

Materially affects cost per concurrent user and the plan tier we need.

### Q12. Does the Voice Agents SDK channel publish its audio contract anywhere?

The deploy page says non-browser clients "connect over the Voice Agents WebSocket
interface. Handle audio frames, turn events, and tool-call signals" — but publishes **no
encodings, sample rates, endpoint URLs or event schema**
([deploy with code](https://docs.sarvam.ai/conversations/deploy/deploy-with-code)).
Relevant only as a reference implementation for our own protocol; the BYO-models prohibition
rules the product itself out ([ADR 0001](adr/0001-orchestrator.md)).

### Q13. Will Deepgram add Indic TTS?

Deepgram's Indic **STT** coverage is expanding steadily — Gujarati in April 2026, Nepali and
Punjabi in August 2026 ([changelog](https://developers.deepgram.com/changelog)). Its Indic
**TTS** coverage has not moved at all: still `en`, `es`, `de`, `fr`, `nl`, `it`, `ja`
([TTS overview](https://developers.deepgram.com/docs/tts-models-languages-overview.md)).

If Aura-2 ever ships Hindi, the accepted single point of failure in
[ADR 0005](adr/0005-tts-provider-split.md) becomes solvable. **Do not plan around it** — but
it is worth a quarterly check of the changelog, since it would change a decision we have
consciously accepted risk on.

### Q14. Does Deepgram have an India region on any roadmap?

Regional endpoints exist for EU (`api.eu.deepgram.com`) and Australia
(`api.au.deepgram.com`) ([EU](https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available),
[AU](https://deepgram.com/learn/deepgram-australia-endpoint-now-generally-available)). No
India region. Sarvam is India-resident by design
([overview](https://docs.sarvam.ai/conversations/overview.md)). If data residency becomes a
hard requirement, the **Hindi ASR standby** is now the only part of the stack that would ever
leave the country — and since it only engages during a Sarvam outage, dropping it entirely
would make the system fully India-resident at the cost of Hindi's one redundant stage. Worth
knowing before that becomes a compliance conversation rather than a technical one.

**Escalated by slice 8, and now a live product question rather than a planning note.** The
failover is built and works. It is shipped **disabled by default**
(`ASR_FAILOVER_ENABLED=false`) precisely because enabling it means a network blip can relocate
a user's voice out of India, mid-conversation, with nobody having decided that. Somebody who
owns the data-protection posture has to answer this before the flag is turned on in any
environment with real users. See [ADR 0008 §6](adr/0008-degradation-policy.md).

**Widened by the external tools.** The ASR standby is no longer the only way out of the
country. `get_weather` reaches Open-Meteo, which is EU-hosted, so an enabled deployment sends a
**place name** abroad on every weather question — and unlike the failover, which fires only
during an outage, this one fires whenever the user asks. The exposure is much smaller (a city
name against an audio stream) and the same mitigation applies: `WEATHER_ENABLED=false` by
default, and nothing is registered when it is off, so the model never even sees the tool.

`get_news` is deliberately **not** in the same position. It takes RSS feed URLs rather than a
vendor (`NEWS_FEEDS`), so pointing it at a domestic outlet keeps that hop inside India — the
configuration shape is itself the mitigation. No default feeds ship, which also means no
default egress.

Both belong in the same conversation as the failover flag, and both are answerable
independently of it: a deployment can run news-only and stay fully India-resident.

---

## Resolved during research

Recorded so they are not re-litigated.

| Question | Answer | Source |
|---|---|---|
| What is the language scope? | **Bulbul's 11 languages, final**: `hi-IN`, `bn-IN`, `ta-IN`, `te-IN`, `gu-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `pa-IN`, `or-IN`, `en-IN`, plus Hinglish and code-mixing within that set | Product decision, 2026-08-29 |
| What about the 12 languages Saaras hears but Bulbul cannot speak? | **Out of scope, refused at session open.** No second TTS vendor, no translation substitution. Urdu is the accepted loss | [ADR 0005](adr/0005-tts-provider-split.md) |
| Can Deepgram carry any part of the TTS path? | **No.** Aura-2 has no Indic voice, and non-Indic is out of scope — Deepgram TTS is entirely unused | [TTS overview](https://developers.deepgram.com/docs/tts-models-languages-overview.md) |
| Can Deepgram carry the ASR path? | **No.** `flux-general-multi` reaches one Indic language. Foreclosed by the scope decision | [language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md) |
| Can we bring our own LLM/TTS/STT to Sarvam Voice Agents? | **No** — "does *not* support bringing your own models at any part of the stack (ASR, LLM, or TTS)". The LLM is not even selectable | [models](https://docs.sarvam.ai/conversations/build/models) |
| Can we bring our own STT to Deepgram Voice Agent? | **No** — "only Deepgram is supported". BYO LLM and BYO TTS **are** supported | [configure](https://developers.deepgram.com/docs/configure-voice-agent.md) |
| Does Deepgram support streaming language detection? | **No** — "Language Detection is not currently supported for streaming". Batch only | [language detection](https://developers.deepgram.com/docs/language-detection.md) |
| Does Deepgram have any Hindi voice? | **No.** No Indic TTS of any kind | [TTS overview](https://developers.deepgram.com/docs/tts-models-languages-overview.md) |
| Is 8 kHz supported on both? | Yes, both — though moot for a device client, which runs 16 kHz in | [encoding](https://developers.deepgram.com/docs/encoding.md), [realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming) |
| Does Deepgram support streaming diarization? | Yes, `diarize_model=v1|latest`; speaker without confidence on streaming | [diarization](https://developers.deepgram.com/docs/diarization.md) |
| Is there a barge-in trigger we should use? | Yes — `vad.speech_start` or early partials, **never** `transcript.final` (Sarvam); `StartOfTurn` (Deepgram) | [conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings), [Flux state](https://developers.deepgram.com/docs/flux/state.md) |
| Can the JS SDK reach Sarvam's `codemix` mode? | **No** — "any `mode` you pass is silently dropped" | [streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api) |

### Q15. Who confirms a destructive calendar change, and how?

`add_appointment` ships; **`cancel_appointment` deliberately does not.**

The asymmetry is the whole point. Creating a wrong appointment is recoverable and audible —
the companion reads it back, and a spurious entry is an annoyance. Deleting the right one is
neither. A voice agent that mishears "cancel the physio" can remove a hospital appointment,
and the user has **no screen on which to notice it is gone**. They find out by not being
there.

Three things have to be decided before a delete tool exists:

1. **What confirmation sounds like.** A spoken read-back and a yes/no is a *turn*, not a tool
   call — the model would have to hold a pending action across turns, which nothing in the
   orchestrator does today. It is closer to the media-stop path in
   [`stop-intent.ts`](../src/copy/stop-intent.ts) than to a tool.
2. **Whether "yes" is enough.** Elderly users are documented as agreeing readily with a
   confident assistant. A confirmation that is easy to say yes to is not a safeguard.
3. **Whether delete should be soft.** The API offers only `DELETE`. Moving an event to a
   "cancelled by the companion" calendar instead would be reversible, at the cost of leaving
   the real appointment in place if the user genuinely meant it.

Until those are answered, the credential can still be shared as **"See all event details"**
rather than "Make changes", which removes the capability at the source rather than trusting
the code not to use it. Referenced from [`calendar.ts`](../src/tools/calendar.ts).

### Q16. Which Google credential does a real deployment use?

Settled enough to build against, recorded because the reasoning is easy to lose.

An **API key cannot serve this product**. It answers "which project is calling", carries no
user identity and therefore no OAuth scope; Google's
[discovery document](https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest) lists a
required scope on every write method, and there is no public-write scope to match
`calendar.events.public.readonly` on the read side. So a key reads public calendars and does
nothing else — verified live: an unauthenticated call to a **public** calendar is already a
403.

**OAuth** works but needs a consent screen, a token store and a refresh cycle, and an app left
in Testing mode expires refresh tokens after seven days.

**A service account is the fit**, and the reason is a product one rather than a technical one:
the user shares their calendar with the account's `client_email` exactly as they would share
with a person. No consent screen ever, and it works on a consumer Gmail calendar rather than
only Workspace — which matters, because the constraint that shaped this whole feature is that
the end user cannot complete an OAuth flow.

Open part: **whose** Google Cloud project holds that service account in a real deployment, and
what happens to the shared calendars when its key is rotated.

---

### Q17. Do Deepgram's intelligence features work on a live stream, or not?

Deepgram's documentation contradicts itself, and the two halves are one click apart.

The feature pages for [sentiment](https://developers.deepgram.com/docs/sentiment-analysis.md),
[topics](https://developers.deepgram.com/docs/topic-detection.md),
[intents](https://developers.deepgram.com/docs/intent-recognition.md) and
[summarisation](https://developers.deepgram.com/docs/summarization.md) each carry a
**`Streaming:Nova`** badge alongside `Pre-recorded`. But the
[streaming feature matrix](https://developers.deepgram.com/docs/stt-streaming-feature-overview.md)
lists exactly one feature under *Intelligence* — Entity Detection — and none of these four.

Nothing we ship depends on the answer, which is why this is a question and not a defect:
[ADR 0009](adr/0009-audio-intelligence.md) puts the analysis in the memory worker on a batch
endpoint, and our streaming path is Flux `/v2/listen`, which has none of these features under
either reading. It matters only if someone later wants a live signal — at which point the
badge must be tested, not believed.

The same intent page also badges itself **"All available languages"** while its own parameter
table says `language` `en` — "Only English is supported at this time". We build on the table.

---

### Q18. What does `/v1/read` cost?

Unknown, and deliberately not guessed at. Deepgram's Text Intelligence pricing was not fetched
during this work, so nothing in [ADR 0009](adr/0009-audio-intelligence.md) reasons about cost —
the decisions there are made on residency, coverage and consent, all of which hold at any
price.

What is known: the input cap is 150K tokens, and `summarize` on an input under 50 words returns
the input unbilled. We do not send `summarize` at all, and the `MIN_WORDS` floor in
[`care-signals.ts`](../src/domain/care-signals.ts) keeps short sessions off the wire entirely,
so the billed volume is roughly "one call per closed English session over fifty words". Someone
with console access should price that before a fleet of devices runs it nightly.

---

## Pages that could not be fetched

Repeated from [00 §8](00-provider-research.md#8-pages-that-could-not-be-fetched) because
they are themselves open questions. Three were named explicitly in the research brief and
all three refuse automated access:

- `https://www.sarvam.ai/models` — HTTP 403
- `https://www.sarvam.ai/speech-to-text` — HTTP 403
- `https://www.sarvam.ai/text-to-speech` — HTTP 403

**These should be opened manually in a browser.** They are the most likely home for Sarvam
latency and benchmark claims, whose absence is currently the largest hole in
[03-latency-budget.md](03-latency-budget.md).
