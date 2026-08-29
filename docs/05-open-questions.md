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

**How to settle it.** Open the socket three ways — `language_code=auto`,
`language_code=unknown`, omitted entirely — and speak a Hindi→English switch mid-stream.
Observe whether the connection is accepted, whether finals carry a `language` field, and
whether the text follows the switch. Half a day. See [Slice 0](04-milestones.md#slice-0--two-listening-tests-half-a-day-no-product).

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

---

## Resolved during research

Recorded so they are not re-litigated.

| Question | Answer | Source |
|---|---|---|
| What is the language scope? | **Bulbul's 11 languages, final**: `hi-IN`, `bn-IN`, `ta-IN`, `te-IN`, `gu-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `pa-IN`, `od-IN`, `en-IN`, plus Hinglish and code-mixing within that set | Product decision, 2026-08-29 |
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
