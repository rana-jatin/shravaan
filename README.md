# SP-I — multilingual companion voice agent

A companion bot on a dedicated device. Speaks 11 Indian languages, remembers across
days, and lets you switch language mid-conversation.

Design lives in [`docs/`](docs/) and is the spec; this code implements a slice of it.
Start with [docs/01-architecture.md](docs/01-architecture.md).

---

## Status

**Slice 1** (end-to-end exchange) · **Slice 2, server half** (echo guard) ·
**Slice 3** (working memory) · **Slice 4** (continuity across days) ·
**Slice 6** (tools and fillers) · **Slice 7** (speakability gate) ·
**Slice 8** (degradation).
See [docs/04-milestones.md](docs/04-milestones.md) for the full slice plan.

| Built | Not yet |
|---|---|
| Device WebSocket transport | **AEC (device side — needs hardware)** |
| Sarvam ASR / LLM / TTS clients | Wake word |
| Turn state machine + barge-in | **Pre-rendered outage audio beyond `en-IN`/`hi-IN`** |
| **Speakability gate — all three gates** | **Durable memory backend ([ADR 0004](docs/adr/0004-vector-store.md) still Proposed)** |
| **Echo guard — the self-interruption defence** | **A real multilingual embedder** |
| **Working memory: 12-turn window, idle TTLs, turn lock, resume** | Live failure injection (slice 8's exit criterion) |
| **Long-term memory: `mem:writes`, distiller, supersede/soft-delete, profile** | |
| **Function calling: OpenAI-style, verified on sarvam-105b** | Tool selection quality at scale (unmeasured) |
| **8 built-in tools + entitlement gating, deadlines, fillers** | |
| **Degradation: ledger, circuit breaker, jittered backoff, buffered `mem:writes`** | |
| **Deepgram Flux ASR standby** (`hi-IN`/`en-IN`, off by default) | |
| **Care signals** — post-session sentiment + care watch-list (`en` only, off by default) | **Care-signal field names against a live key (`npm run verify:care`)** |
| Clause chunker (streams TTS at clause boundaries) | |
| Spoken copy in 11 languages | |

---

## The provider contract, now verified

The endpoint paths, auth header and message field names in `src/providers/*` were
reconstructed from Sarvam's guide pages, because the API-reference pages returned
404 during research ([Q12](docs/05-open-questions.md)). They have now been run
against a live key. **The paths and the `api-subscription-key` header were right;
five field-level guesses were wrong**, and are fixed:

| Guessed | Actually | Symptom while wrong |
|---|---|---|
| `language_code=unknown` for auto-detect | **`auto`** | socket closed 4000 on every keyless-profile session |
| Odia is `od-IN` | **`or-IN`** | closed 4000 — Odia never worked at all |
| ASR frames keyed on `type` | **`event`** | every ASR frame silently dropped |
| ASR audio as `{type:"audio_input", audio:<base64>}` | **raw binary frames** | accepted and ignored; no VAD, no transcript, no error |
| TTS config flat, `language_code`, speaker `Shubh` | **nested in `data`, `target_language_code`, `shubh`** | 422 on connect, reconnect loop, never spoke |

Two of these fail *silently* — the socket stays open and healthy-looking and simply
never produces a transcript. Assume nothing here is right because it doesn't throw.

### And then Deepgram, where the same mistake was made twice

The Flux standby was reconstructed the same way, from documentation, and dialled against a
live key on 2026-09-01 with `npm run verify:asr`. The auth header (`Authorization: Token`),
the `/v2/listen` path and the model name were all right. One field-level guess was wrong:

| Guessed | Actually | Symptom while wrong |
|---|---|---|
| Flux frames keyed on `type` | **`type: "TurnInfo"`, name in `event`** | the entire ASR standby emitted nothing, ever |
| `language`, a string | **`languages`, an array** | the standby never reported a language |

**Look at row three of the Sarvam table.** It is the same defect — frames keyed on `type`
when the name lives in `event` — found once, written down, and then made again in the next
ASR client. A lesson recorded in a README is not a lesson applied to the next file.

The standby had been shipped, tested by 566 passing tests, and was incapable of hearing a
single word. See [D11](docs/07-defect-register.md).

Still open:

- **Whether one Bulbul speaker sounds like the same person across languages.**
  Undocumented, and the free-switching persona depends on it.
  ([Q2](docs/05-open-questions.md)) — needs a human listening, not a test.
- **Whether per-turn switching works on the raw socket.** `auto` is accepted and
  `hi-IN` detection is confirmed; a mid-stream Hindi→English switch is not yet
  exercised. ([Q1](docs/05-open-questions.md))

---

## Language set

**11 languages. This is the whole product.**

Hindi `hi-IN` · Bengali `bn-IN` · Tamil `ta-IN` · Telugu `te-IN` · Gujarati `gu-IN` ·
Kannada `kn-IN` · Malayalam `ml-IN` · Marathi `mr-IN` · Punjabi `pa-IN` ·
Odia `or-IN` · English `en-IN`

Hinglish and code-mixing within that set are first-class.

**The ceiling is Bulbul's, not Saaras's.** Sarvam's ASR transcribes 22 Indian
languages; its TTS speaks 10. Twelve languages — Urdu, Assamese, Nepali, Konkani,
Kashmiri, Sindhi, Sanskrit, Santali, Manipuri, Bodo, Maithili, Dogri — are heard
perfectly and cannot be answered. They are refused at session open.
See [ADR 0005](docs/adr/0005-tts-provider-split.md).

That asymmetry is why [the speakability gate](docs/06-speakability-gate.md) exists.
It is the only failure in this system that is silent by construction: the ASR
succeeds, the LLM succeeds, and the user hears nothing.

---

## Run

```bash
npm install
cp .env.example .env      # add SARVAM_API_KEY
npm run check             # format + lint + typecheck + test, in that order
npm run dev               # device WebSocket server on :8080
npm run device            # the other half: mic in, speaker out (needs ffmpeg)
```

Requires Node ≥ 22.6 (uses native TypeScript type stripping — no build step).

`npm run check` is what CI runs. The parts are also available on their own:

| Command | What it does |
|---|---|
| `npm test` | 616 tests. **No credentials, no network** — every provider and tool takes an injectable client, so the suite must never need a key. |
| `npm run typecheck` | `tsc --noEmit`, strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. |
| `npm run lint` | eslint, type-checked rules. Tuned for defects, not style. |
| `npm run format` | prettier. Markdown is deliberately excluded — see `.prettierignore`. |

These need a real key and are **not** part of `check`:

| Command | What it proves |
|---|---|
| `npm run render:holding` | Renders the outage apology. Needs a working Bulbul — see below. |
| `npm run verify:tools` | Re-checks the tool-calling contract against the live model. |
| `npm run verify:care` | Checks `/v1/read` field names before you trust a trend. |
| `npm run verify:asr` | Proves the ASR standby can actually hear. |
| `npm run verify:alert` | Sends one real alert, to prove the emergency path delivers. |

**Working memory** falls back to an in-process store when `REDIS_URL` is unset —
fine for development, useless across restarts or replicas. Setting it also enables
the Redis half of the store contract suite, which is **written but has never been
executed** (no Redis was reachable in the environment where this was built):

```bash
docker run -d -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm test    # runs the contract against both stores
```

Do that before trusting the Redis path. The in-memory store passing proves the
contract is coherent, not that `ioredis` behaves as assumed.

---

## ⚠ Before a Bulbul outage, not during one

Bulbul is the only voice in this system and there is **no Indic TTS failover**
anywhere in either provider ([ADR 0005](docs/adr/0005-tts-provider-split.md)). When
it goes, the one message worth saying is the one message that cannot be
synthesised — so it is rendered ahead of time and shipped as bytes:

```bash
npm run render:holding    # writes assets/holding/*.pcm + manifest.json
```

`assets/holding/` currently holds **`en-IN` and `hi-IN` only**. The other nine
languages fall down the refusal ladder to Hindi, which is the ladder working as
designed rather than a gap — but a Bulbul outage during an Odia conversation
apologises in Hindi. Without any clip at all the server logs
`no pre-rendered audio — closing in silence` rather than letting that pass as
normal. Regenerate whenever `TTS_SPEAKER` or the copy changes, or the apology
arrives in a different voice from the rest of the conversation.

**ASR failover is off by default, and not because of the coverage gap.** Deepgram
Flux reaches `hi-IN` and `en-IN` of our eleven — but it also publishes **no India
region**, while Sarvam is India-resident by design. Enabling
`ASR_FAILOVER_ENABLED=true` means a network blip can relocate a user's voice out
of the country mid-conversation. That is a decision for whoever owns the
data-protection posture ([Q14](docs/05-open-questions.md)).

---

## Function calling

OpenAI-shaped, and **verified against a live key** rather than assumed —
`npm run verify:tools`. [ADR 0003](docs/adr/0003-llm.md) had flagged sarvam-105b's
tool-calling as undocumented and named this as the thing that had to be tested
before anything was built on it.

It speaks the dialect: `{index, id, type, function:{name, arguments}}` deltas,
long arguments fragmented token by token, all four `tool_choice` forms honoured,
multiple calls in a single round, and `role:"tool"` results round-tripping into
prose.

**One divergence, and it was silent.** For a short or empty argument object
Sarvam sends the finished value whole and then sends it *again* — so the obvious
`args += fragment` yields `{}{}`, `JSON.parse` throws, and the original parser's
catch handed the tool **empty arguments**. Accidentally correct for a
no-argument tool; silent data loss for every other one. Handled in
`accumulateArgs`, with the captured frames as a regression test.

The built-ins, all of which need nothing but the session itself — no key, no URL,
no network, so a fresh clone has a working companion:

| Tool | Does |
|---|---|
| `get_time` | Clock + timezone. A tool rather than a prompt line, so the cached prefix stays byte-stable |
| `repeat_that` | Returns the previous reply verbatim — regenerating gives different words, which is exactly wrong |
| `set_language` | An **explicitly requested** switch. Routed through the same speakability verdict as gates 2 and 3 |
| `set_speaking_pace` | Slower / faster / normal, clamped |
| `remember_this` | Explicit memory write — the first producer of `explicit_recall` |
| `forget_this` | Soft delete at the user's request, on strong matches only |
| `recall` | On-demand search. Bounded exception to keeping memory off the turn path |
| `end_conversation` | Closes *after* the farewell drains, never mid-word |

And two that leave the process. These are **factories, registered only where the
deployment configured them**, because a tool the operator cannot serve must never
be described to the user — an agent that offers the weather and then withdraws it
is worse than one that never mentioned it.

| Tool | Does | Off unless |
|---|---|---|
| `get_weather` | Current conditions + today's forecast, via Open-Meteo. Geocodes the place name first | `WEATHER_ENABLED=true` |
| `get_news` | Today's headlines from RSS. Categories are whatever you point it at | `NEWS_FEEDS` is set |

⚠ **`get_weather` is the one hop that is not Sarvam and not in India.** Open-Meteo
is EU-hosted, so an enabled deployment sends a place name abroad on every weather
question. That is much less than the ASR failover risks — a city name, not the
user's voice — but it is the same decision, which is why it is opt-in and why the
boot log says so out loud. `get_news` takes feed URLs rather than a vendor
precisely so a domestic outlet keeps that hop inside India
([Q14](docs/05-open-questions.md)).

**While a slow tool runs, the user hears something.** One progress line per
round — not per call, since calls now run concurrently and two slow tools would
otherwise stutter two fillers back to back. Tools that can genuinely run long
declare a `progress_key` and get their own line ("let me check the weather");
everything else falls back to the generic rotating filler. The eight built-ins
declare none, because none of them can be slow enough to need one — they are
capped at 250 ms with the filler pinned above the deadline, so it can never fire.
`get_weather` and `get_news` are the first tools that can genuinely be slow, and
they claim the `progress.weather` and `progress.news` copy that has been sitting
in `src/copy/fillers.ts` since slice 6, written ahead of the tools on the same
principle as the pre-rendered outage audio.

The prompt asks the model to announce its own call before making one. On
`sarvam-105b` that worked on roughly 78% of tool turns, and getting there took
measurement rather than politeness: a plain instruction scored 0/9, a forceful
imperative plus an inline example scored 7/9, and neither lever worked alone
([ADR 0003](docs/adr/0003-llm.md) has the table).

**That prompt does not transfer to `sarvam-105b-conversations`, which is what we
now run.** Re-measured on the shipped prompt, same nine asks, twice: **2/9 —
22%**, and both preambles were the Hindi asks. Every English one called silently.
So the progress copy is now carrying roughly four tool turns in five rather than
one in five, and the prompt needs re-tuning against this model.

It matters far less than that inversion suggests, because the silence it covers
also collapsed. An un-preambled tool turn is now quiet for a median of **1.0 s**
(min 0.64, max 1.73) against the **12.8 s** it would have been on the reasoning
model. The preamble was defending against a thirteen-second void; it is now
defending against about a second.

Three rules these follow, and any tool added later should too:

- **A domain outcome is data, not an error.** `ok: false` costs a
  `spoken_fallback_key`, and every key costs eleven translations — nine still
  placeholder. `{repeated: false, reason: "nothing_said_yet"}` gets narrated
  correctly in Odia for free. Errors stay for infrastructure that broke.
- **Enum tokens stay English identifiers.** A model reasoning in Hindi will
  answer a translated enum in Hindi, and validation then rejects a call the user
  legitimately made.
- **Deadlines are conversational, not network-sized.** The 8 s default suits a
  backend call; every built-in is in-process and capped at 250 ms, with fillers
  pinned above the deadline so they can never fire.

**Tools multiply the binding rate limit.** Sarvam-105B is 40 req/min *per
account* — the system's real concurrency ceiling ([ADR 0003](docs/adr/0003-llm.md)).
A turn with no tools is one request; a turn that goes three tool rounds is four.
Calls within a round now run concurrently, so a round costs the slowest call
rather than the sum, but rounds are still serial by construction and each one is
another request against a limit shared by every live conversation.

---

## Care signals — and what "Audio Intelligence" is not

Deepgram's four intelligence features (sentiment, intents, topics, summarisation) are wired
here as an **opt-in, post-session** read of the transcript. Two things about that sentence are
the whole design.

**Post-session.** The analysis runs in the memory worker after a session closes, on the batch
`/v1/read` endpoint, and its result is attached to the episode. **Nothing on the voice path
calls Deepgram for this** — not on a turn, not at close, not behind a filler. The one tool the
model can call, `recall_mood`, reads episodes out of the local store and never opens a socket.

**A read of the transcript.** Despite the name, Audio Intelligence does not hear anything: it
analyses text, and the audio endpoint simply transcribes first. It cannot tell you someone
*sounded* tired or breathless, only that they used words a model scored low. A care product
built on the other reading would be built on nothing.

What we take, and what we deliberately leave:

| Feature | Used? | Why |
|---|---|---|
| `sentiment` | **yes** | numeric and segment-level, so it trends across days |
| `intents` + `custom_intent` (strict) | **yes** | a fixed, reviewable watch-list — pain, falls, sleep, loneliness |
| `summarize` | no | `LlmDistiller` already writes a summary, in the user's own language |
| `topics` | no | same — and ours are not English-only |

```bash
CARE_SIGNALS_ENABLED=true    # needs DEEPGRAM_API_KEY; server refuses to boot without it
npm run verify:care          # before trusting a single number
```

**Off by default for three reasons, any one sufficient.** Transcripts leave India
([Q14](docs/05-open-questions.md)); the features are **English only**, so ten of our eleven
languages are never analysed and the gate refuses code-mixed sessions outright rather than
scoring half of one; and keeping a trend of how someone sounded is a different promise from
remembering what they told you.

**It is not an alarm path, by design.** `src/copy/emergency-intent.ts` is local, pre-network,
sub-second and covers all eleven languages. A batch English-only classifier arriving hours
later must never sit in front of that. See
[ADR 0009](docs/adr/0009-audio-intelligence.md).

---

## Device protocol

```
device → server   binary   linear16 PCM @ 16 kHz mono
device → server   json     { type: "hello", uid, locale_hint? }

server → device   binary   linear16 PCM @ 24 kHz mono
server → device   json     { type: "ready", sid }
                           { type: "clear_audio" }        ← barge-in: drop playback NOW
                           { type: "session_closed", reason }
```

**Audio rates are not free choices.** Sarvam's realtime STT socket accepts only
8000 or 16000 and closes with code `4000` otherwise; Bulbul streaming is capped at
24 kHz. `src/config/env.ts` refuses to boot on a bad value rather than letting you
discover it as a dropped connection.

**`clear_audio` is the barge-in signal.** The server decides, the device executes —
buffered audio lives on the device, so only the device can drop it.

---

## Layout

```
src/
  server.ts             device-facing WebSocket server: protocol, boot order,
                        socket lifecycle. Wiring lives in composition/.
  composition/          how a deployment is assembled — one module per concern,
                        each returning what the boot log needs to report
    memory.ts           store, mem:writes, long-term store, worker
    tools.ts            registry + which tools this deployment actually has
    calendars.ts        iCal and Google, read and the three-way write gate
    alerting.ts         contacts, mail transport, the alerter
    url.ts              isHttpUrl + redactUrl (a feed URL IS the credential)
  config/
    languages.json      the matrix — SINGLE source of truth, do not duplicate
    env.ts              boot-time validation; Config is nested by concern
  domain/               pure, no I/O, fully unit-tested
    languages.ts        speakability verdict
    gate.ts             gates 1, 2, 3
    turn-state.ts       provider-agnostic turn state machine
    clause-chunker.ts   streams TTS at clause boundaries
    redis-keys.ts       key formats + TTLs (idle windows, not call lengths)
    degradation.ts      what is broken, and whether we can still talk
    backoff.ts          jittered retry, bounded by the user's patience
    circuit-breaker.ts  stops an outage becoming a latency problem
    asr-failover.ts     which languages actually have a second ASR (two)
    care-signals.ts     the English gate, the watch-list, the trend
    ical.ts             enough iCalendar to read a diary aloud
    types.ts            mirrors docs/02-data-contracts.md
  providers/            raw WebSocket, not the SDK
    sarvam-{asr,llm,tts}.ts
    deepgram-asr.ts     Flux standby — hi-IN/en-IN, hearing only
    deepgram-read.ts    /v1/read — batch, off the voice path entirely
    factories.ts        the ONLY place outside server.ts naming a concrete
                        provider — which is what makes the turn loop testable
    http.ts             the injectable fetch surface + getText/getJson
  memory/
    worker.ts           consumes mem:writes, distils, commits
    stream.ts           mem:writes — in-memory, plus an UNWIRED Redis stream
    care-signals-analyser.ts  gate → call → map, bounded, never throws
  orchestrator/
    session.ts          the turn loop: gates, barge-in, tool rounds, degradation
    session-deps.ts     what a Session is handed, and the five bounds it obeys
    prompt.ts           buildMessages + profileBlock — pure, and tested directly
    media-controller.ts what is playing on the device
  audio/holding-audio.ts  pre-rendered apology for a TTS outage
  copy/refusals.ts      refusal + closing copy, 11 languages
  tools/
    builtin.ts          the 8 session-only tools (no key, no network)
    external.ts         what every leaves-the-process tool shares, and why
    weather.ts news.ts wellbeing.ts music.ts calendar.ts emergency.ts
    registry.ts         entitlement gating + strict schema emission
    executor.ts         deadlines, fillers, pending tracking
    types.ts            tool contracts + the deadline tiers
scripts/
  device-client.ts         the other half of the demo: mic in, speaker out
  render-holding-audio.ts  build-time; needs a working Bulbul
  verify-*.ts              probe a live provider contract with a real key
```

**Why the composition/ split:** `start()` was 500 lines of sequential wiring.
Each module there takes `cfg` and a log and returns what it built, so the boot
sequence reads as a table of contents and each gate is reachable from a test
without opening a WebSocket server.

**Why `session.ts` is still ~1600 lines:** because the turn loop is one machine.
The pieces with a real seam came out — the deps type, message building, media
control. `#openAsr` did not: it touches fourteen pieces of `Session`'s private
state including five sibling methods, so extracting it buys an indirection tax
and no boundary. Size is not the metric; coupling is.

**Why raw WebSockets instead of Sarvam's SDK:** their docs state the JavaScript SDK
"silently drops" the `mode` parameter, so every connection runs as plain
`transcribe` regardless of what you ask for. `codemix` matters for a Hinglish
product, so we speak the protocol directly.
([ADR 0006](docs/adr/0006-asr-provider-under-free-switching.md))

---

## Known gaps in this code

**Open defects are tracked in [docs/07-defect-register.md](docs/07-defect-register.md)** —
eight found by audit, each with its cause and its fix. The section below is about what has
not been *built*; the register is about what is built and wrong.

- **Spoken copy for 9 of 11 languages is placeholder text.** Only `en-IN` and
  `hi-IN` are ready across refusals, fillers and tool fallbacks. The rest are
  flagged `needsNativeReview` and the server logs a warning at boot. They must be
  replaced by native speakers before any user hears them — see the header of
  `src/copy/refusals.ts`, which also explains the grammatical-gender problem
  (Hindi, Marathi, Gujarati and Punjabi inflect the verb for the *speaker's*
  gender, so the copy depends on which Bulbul voice is set).
- **Tool selection quality is unmeasured.** The wire format is now verified (see
  below) and the loop reaches a spoken answer, but nothing yet measures whether
  the model picks the *right* tool with eight of them offered, or how selection
  behaves when the conversation is in Malayalam and every tool description is in
  English. That needs live conversations, not a probe.
- **No device-side AEC yet — still use headphones.** The server-side echo guard is
  built and defends in depth (suppression window, confirm-on-transcript, and
  self-text correlation, since our own voice comes back as *our own words*). But
  it is the second layer, not the first. Acoustic echo cancellation belongs on the
  device where the playback signal is available sample-aligned, and that needs
  hardware. Until then the guard is catching leakage from a canceller that does
  not exist. ([ADR 0007](docs/adr/0007-audio-front-end.md))
  - Watch for `self-echo rejected — AEC is leaking` in the logs: a rising rate is
    the only visibility we have into cancellation quality.
  - `HALF_DUPLEX=true` mutes barge-in entirely — the emergency fallback if AEC
    proves intractable. It is a product downgrade, not a fix.
- **Long-term memory is in-process and not durable.** Facts and episodes are lost
  on restart; the server warns about this at boot. [ADR 0004](docs/adr/0004-vector-store.md)
  (Postgres + pgvector) is still *Proposed* — no vendor docs were ever researched
  for it — so the pipeline is built behind a `LongTermStore` interface instead.
  The distillation logic, which is where the product actually lives, is
  backend-independent and fully tested.
- **The embedder is a placeholder.** `HashingEmbedder` matches lexically and
  cannot bridge scripts: "They live in Bengaluru" scores zero against
  "वे बेंगलुरु में रहते हैं". Our facts are multilingual by construction, so this
  must be replaced before retrieval is trusted. There is a test asserting the
  limitation so it stays visible rather than becoming a silent quality bug.
- **The memory worker is single-replica.** Its idempotency ledger is in-process;
  two workers would duplicate facts. See Q6b in
  [docs/05-open-questions.md](docs/05-open-questions.md).
- **The degradation paths have never met a real failure.** Slice 8's logic is
  asserted against simulated ones — a store that throws, a stream that refuses
  writes, a socket that will not reopen. That proves the policy is coherent, not
  that the providers fail the way we assumed. Its exit criterion is injecting each
  failure into a live conversation, and that needs credentials.
- **Latency is unmeasured.** The budget in
  [docs/03-latency-budget.md](docs/03-latency-budget.md) is hypotheses with named
  consequences — a realistic estimate lands at ~945 ms against an 800 ms target,
  and only one latency figure exists in either provider's documentation.
