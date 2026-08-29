# SP-I — multilingual companion voice agent

A companion bot on a dedicated device. Speaks 11 Indian languages, remembers across
days, and lets you switch language mid-conversation.

Design lives in [`docs/`](docs/) and is the spec; this code implements a slice of it.
Start with [docs/01-architecture.md](docs/01-architecture.md).

---

## Status

**Slice 1** (end-to-end exchange) · **Slice 2, server half** (echo guard) ·
**Slice 3** (working memory) · **Slice 4** (continuity across days) ·
**Slice 7** (speakability gate).
See [docs/04-milestones.md](docs/04-milestones.md) for the full slice plan.

| Built | Not yet |
|---|---|
| Device WebSocket transport | Tools and spoken fillers |
| Sarvam ASR / LLM / TTS clients | **AEC (device side — needs hardware)** |
| Turn state machine + barge-in | Wake word |
| **Speakability gate — all three gates** | Deepgram Hindi ASR standby |
| **Echo guard — the self-interruption defence** | **Durable memory backend ([ADR 0004](docs/adr/0004-vector-store.md) still Proposed)** |
| **Working memory: 12-turn window, idle TTLs, turn lock, resume** | **A real multilingual embedder** |
| **Long-term memory: `mem:writes`, distiller, supersede/soft-delete, profile** | |
| Clause chunker (streams TTS at clause boundaries) | |
| Refusal copy in 11 languages | |

---

## ⚠ Before you run this against a live key

**The provider endpoint paths, auth header name and message field names in
`src/providers/*` are UNVERIFIED.** They were reconstructed from Sarvam's guide
pages; the API-reference pages that would confirm them returned 404 during
research ([docs/05-open-questions.md](docs/05-open-questions.md) Q12).

Two more unresolved items are wired as configurable rather than assumed:

- **The auto-detect token.** Sarvam's docs give three different answers —
  `auto`, `unknown`, or "explicit language required". `ASR_AUTODETECT_TOKEN`
  defaults to `unknown`. ([Q1](docs/05-open-questions.md))
- **Whether one Bulbul speaker sounds like the same person across languages.**
  Undocumented, and the free-switching persona depends on it. ([Q2](docs/05-open-questions.md))

Both are answered by [Slice 0](docs/04-milestones.md#slice-0--two-listening-tests-half-a-day-no-product)
— half a day with an API key, before anything else is built on top.

---

## Language set

**11 languages. This is the whole product.**

Hindi `hi-IN` · Bengali `bn-IN` · Tamil `ta-IN` · Telugu `te-IN` · Gujarati `gu-IN` ·
Kannada `kn-IN` · Malayalam `ml-IN` · Marathi `mr-IN` · Punjabi `pa-IN` ·
Odia `od-IN` · English `en-IN`

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
npm run typecheck
npm test                  # 116 tests, no credentials needed
npm run dev               # device WebSocket server on :8080
```

Requires Node ≥ 22.6 (uses native TypeScript type stripping — no build step).

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
  config/
    languages.json      the matrix — SINGLE source of truth, do not duplicate
    env.ts              boot-time validation of the non-negotiable audio rates
  domain/               pure, no I/O, fully unit-tested
    languages.ts        speakability verdict
    gate.ts             gates 1, 2, 3
    turn-state.ts       provider-agnostic turn state machine
    clause-chunker.ts   streams TTS at clause boundaries
    redis-keys.ts       key formats + TTLs (idle windows, not call lengths)
    types.ts            mirrors docs/02-data-contracts.md
  providers/            Sarvam ASR / LLM / TTS — raw WebSocket, not the SDK
  orchestrator/
    session.ts          turn loop, gates, barge-in
  copy/refusals.ts      refusal copy, 11 languages
  server.ts             device-facing WebSocket server
```

**Why raw WebSockets instead of Sarvam's SDK:** their docs state the JavaScript SDK
"silently drops" the `mode` parameter, so every connection runs as plain
`transcribe` regardless of what you ask for. `codemix` matters for a Hinglish
product, so we speak the protocol directly.
([ADR 0006](docs/adr/0006-asr-provider-under-free-switching.md))

---

## Known gaps in this code

- **Refusal copy for 9 of 11 languages is placeholder text.** Only `en-IN` and
  `hi-IN` are ready. The rest are flagged `needsNativeReview` and the server logs a
  warning at boot. They must be replaced by native speakers before any user hears
  them — see the header of `src/copy/refusals.ts`, which also explains the
  grammatical-gender problem (Hindi, Marathi, Gujarati and Punjabi inflect the verb
  for the *speaker's* gender, so the copy depends on which Bulbul voice is set).
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
- **Latency is unmeasured.** The budget in
  [docs/03-latency-budget.md](docs/03-latency-budget.md) is hypotheses with named
  consequences — a realistic estimate lands at ~945 ms against an 800 ms target,
  and only one latency figure exists in either provider's documentation.
