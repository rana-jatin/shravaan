# ADR 0006 — Sarvam as default ASR, Deepgram Flux as fallback

**Status:** Accepted, with one empirical dependency · **Date:** 2026-08-29

## Context

The product requires **free language switching on any turn**. That needs streaming
auto-detection, and streaming auto-detection is where the two providers differ most.

This ADR nearly went the other way. It is recorded in full because the reasoning is
non-obvious and the conclusion is conditional.

## The complication

**Deepgram cannot auto-detect language on a streaming connection.** The documentation is
explicit: "Language Detection is not currently supported for streaming". `detect_language`
is batch-only ([language detection](https://developers.deepgram.com/docs/language-detection.md)).
Worse, setting an explicit `language` actively suppresses everything else — "speech in other,
non-specified languages will not be transcribed"
([language](https://developers.deepgram.com/docs/language)).

Deepgram's answer is a different model: `flux-general-multi`, where "without hints, the model
auto-detects the spoken language" and code-switching is handled natively
([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)). Real,
documented, and it exposes `word.confidence` and word-level timestamps that Sarvam does not.

**But `flux-general-multi` covers 10 languages, and only Hindi is Indic** — English, Spanish,
French, German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch. Saaras covers 22 Indic
languages ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)).

So for a Hindi-and-English product, Deepgram Flux is the better-documented ASR. For anything
reaching Tamil, Bengali, Marathi or Malayalam, Sarvam is the only option.

## Sarvam's evidence is strong but sits one layer above our API

Sarvam's managed Voice Agents ships mid-conversation switching as a first-class feature —
"Switch language during call", "Auto-detected language switch", "Languages allowed",
`AGENT_LANGUAGE = "unknown"`
([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) —
and markets exactly our case: "code-mixed speech, callers who interrupt, languages that
switch mid-sentence" ([announcement](https://docs.sarvam.ai/conversations/newly-launched)).

**But three pages disagree about the raw socket:**

| Page | Claim |
|---|---|
| [Saaras model](https://docs.sarvam.ai/api/getting-started/models/saaras.md) | Auto-detects when unset or set to **`unknown`** |
| [Realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming) | `language_code` accepts 24 values **including `auto`** |
| [Streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api) | `language_code` **"Required"**; auto-detect only on the translate endpoint |

And Sarvam's demonstrated switching runs inside **their** orchestration layer, which we
rejected ([ADR 0001](0001-orchestrator.md)). The capability plainly exists in the model. What
is unconfirmed is what `saaras:v3-realtime` exposes to a direct client.

## Decision

**Sarvam `saaras:v3-realtime` is the ASR. Deepgram `flux-general-multi` is a Hindi-only
standby** for a Sarvam ASR outage on Hindi sessions, and nothing else.

**The language scope decision settles this definitively.** With Hindi, Hinglish *and Indian
languages* in scope, Deepgram is not a viable default under any reading — `flux-general-multi`
reaches exactly one Indic language. There is no version of this product where Deepgram carries
the ASR path.

**One empirical dependency remains** on the *mechanism*, not the provider:
[slice 0](../04-milestones.md#slice-0--two-listening-tests-half-a-day-no-product) must confirm
the raw socket auto-detects. **If it fails**, the fallback is explicit switching on a stated
cue ("let's speak in Tamil") rather than detection — degraded but honest. Moving to Deepgram is
not an available response, because it would trade 22 Indian languages for one.

## Options considered

### Sarvam default, Deepgram fallback — chosen

22 Indic languages against 1. Language coverage is the product; documentation quality is not.

### Deepgram Flux default, Sarvam for TTS only — rejected, and now foreclosed

Was the strongest alternative while scope was undecided: better-documented detection, native
code-switched recognition, `word.confidence` enabling the low-confidence reprompt, and the only
published latency figure in either docset.

**The language scope decision forecloses it.** `flux-general-multi` covers English, Spanish,
French, German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch — **one Indic
language**. A product spanning Indian languages cannot run its ASR on it. Revisit only if scope
ever narrows back to Hindi and English alone.

### Both in parallel, reconcile — rejected

Running both ASRs simultaneously and choosing the better transcript would sidestep the
detection question entirely. Rejected on cost — double ASR spend on every turn — and on
latency, since the slower provider gates the turn.

## Consequences

**We lose `word.confidence` on the default path.** Sarvam documents `language_probability`
(a language-identification score) but no transcription confidence
([Q4](../05-open-questions.md#q4-does-sarvam-streaming-expose-any-asr-confidence)). The
low-confidence reprompt rule needs a substitute trigger on the Sarvam path. It works on the
Deepgram path, which is one more reason to keep that path alive rather than vestigial.

**We lose word-level timestamps.** Sarvam gives utterance-level `start_s`/`end_s` via
`return_timestamps`. Acceptable — nothing in the current design needs word-level timing.

**`codemix` mode is unreachable from a JavaScript client.** "Any `mode` you pass is silently
dropped and the connection always runs in the default `transcribe` mode"
([streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api)).
If the orchestrator is written in TypeScript, either call the WebSocket directly rather than
through the SDK, or accept `transcribe` output. **Decide this before slice 1**, since it
constrains the client library choice.

**Failover exists for exactly one language.** ASR can fail over for **Hindi**. It cannot for
the other **21 Indian languages** Saaras supports alone. Combined with
[ADR 0005](0005-tts-provider-split.md), which establishes that no TTS failover exists for any
language:

| Session language | ASR redundancy | TTS redundancy |
|---|---|---|
| Hindi | Yes (Deepgram) | **None** |
| The 9 other speakable Indian languages | **None** | **None** |

**A Tamil session has no redundancy at any stage.** State this plainly to whoever owns the
availability target — it is a single-vendor profile, not a two-provider one.

**The ASR router owns the speakability gate.** Because Saaras hears 12 Indian languages Bulbul
cannot speak ([ADR 0005](0005-tts-provider-split.md)), the check against Bulbul's 11-language
matrix belongs here — at session open and again on any mid-session switch — not at the TTS
boundary where it would fire too late.

**Both providers support mid-stream reconfiguration**, so language switching never requires a
reconnect: Sarvam takes `config.update`, Deepgram Flux takes a mid-stream `Configure` for
`language_hint`.
