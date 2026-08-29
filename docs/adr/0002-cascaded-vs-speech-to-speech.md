# ADR 0002 — Cascaded ASR → LLM → TTS, not speech-to-speech

**Status:** Accepted · **Date:** 2026-08-29

## Context

Speech-to-speech models take audio in and emit audio out, skipping the text round trip.
They typically win on latency and preserve prosody and emotional tone — both of which
matter more for a companion than for a task agent.

The question is whether one is available for our languages.

## Decision

**Cascaded pipeline: ASR → LLM → TTS**, as three separately addressable stages.

## Options considered

### Speech-to-speech — rejected, unavailable

Neither provider offers a speech-to-speech model for any Indic language.

**Sarvam** publishes Saaras (STT), Bulbul (TTS), Mayura and Sarvam-Translate (translation),
Sarvam-105B (LLM) and Sarvam Vision. Its own Voice Agents product is described as
"a real-time ASR → LLM → TTS loop" — cascaded by construction
([models](https://docs.sarvam.ai/api/getting-started/models),
[overview](https://docs.sarvam.ai/conversations/overview.md)).

**Deepgram** likewise separates listen, think and speak in its Voice Agent API, with distinct
providers configurable per stage
([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)). Flux TTS is
"streaming-first, voice-agent-first" but is still a TTS model taking text
([Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md)).

There is nothing to choose. This ADR records *why* the obvious alternative is absent, so the
question is not reopened without new information.

### Third-party speech-to-speech — rejected

Models from other vendors exist, but adopting one would mean abandoning both providers'
Indic coverage — 22 Indic languages on Saaras, 11 on Bulbul, against no Indic support we
could verify in this research. No third-party speech-to-speech documentation was fetched in
this session, so this rejection rests on the Indic coverage argument alone, not on a
comparison.

## Consequences

**Accepted costs:**

- **Three network round trips per turn** instead of one. The dominant reason
  [03](../03-latency-budget.md) is tight.
- **Prosody and emotion are lost at the ASR boundary.** The LLM sees text. Whether the user
  sounded upset, hesitant or amused does not survive transcription — a real loss for a
  companion, where tone often *is* the content.
- **Three failure surfaces** instead of one, and three sets of rate limits.

**Benefits we are buying:**

- **Provider independence per stage.** This is what makes the split in
  [ADR 0005](0005-tts-provider-split.md) and the ASR failover in
  [ADR 0006](0006-asr-provider-under-free-switching.md) possible at all.
- **Inspectable turns.** Text at every boundary means the memory pipeline in
  [02](../02-data-contracts.md) has something to distil. A speech-to-speech model would
  require a parallel transcription path just to feed long-term memory — which reintroduces
  the ASR stage we were trying to remove.
- **The LLM is swappable.** Given Sarvam-105B's rate limits
  ([ADR 0003](0003-llm.md)), that matters.

**Partial mitigation for the prosody loss:** paralinguistic signal can be recovered
separately from the audio stream and attached as metadata to the turn — energy, speech rate,
pause structure — without the LLM needing the audio itself. Not planned for any current
slice, but the cascaded design does not preclude it, and the `MemWriteEvent.hints` field in
[02](../02-data-contracts.md) already has a place to put it.

**Revisit if** either provider ships an Indic speech-to-speech model. Given Sarvam's
India-first positioning and self-hosted stack, they are the likely source. Worth a
periodic check alongside [Q13](../05-open-questions.md#q13-will-deepgram-add-indic-tts).
