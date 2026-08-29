# ADR 0007 — On-device AEC, server-side endpointing

**Status:** Accepted · **Date:** 2026-08-29

## Context

The companion runs on a dedicated device with an open speaker beside an open microphone.
No handset, no headphones, no carrier.

**Every barge-in mechanism documented by either provider assumes a telephony leg**, where
the carrier has already performed echo cancellation. Neither provider's documentation
addresses open-air audio at all. This is the largest gap between what the docs cover and
what we are building.

## The problem

Without echo cancellation, the microphone hears the speaker. The ASR then transcribes the
bot's own output, `vad.speech_start` fires, the orchestrator treats it as barge-in, flushes
playback — and the bot interrupts itself. In a loop.

Both providers give good barge-in triggers, and **neither helps here**:

- **Sarvam:** "drive barge-in off `vad.speech_start` or early partials, not
  `transcript.final`", with a `clearAudio` event stopping playback
  ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings))
- **Deepgram:** trigger on `StartOfTurn`, "more reliable than an external VAD because every
  `StartOfTurn` is guaranteed to contain a non-empty transcript"
  ([Flux state](https://developers.deepgram.com/docs/flux/state.md))

Both are correct advice. Both assume the signal reaching the ASR contains only the user.

## Decision

**Split the audio front-end by what each side can actually see.**

| Function | Where | Why |
|---|---|---|
| **AEC** | **Device** | Needs the playback signal as reference, sample-aligned. Only the device has both |
| **Wake word** | **Device** | Keeps sockets closed while idle — matters under Sarvam's concurrency limits |
| **Local VAD** | **Device** | Transmit gate only. Avoids streaming silence |
| **Endpointing / turn detection** | **Server** | Needs the ASR's own signal. Two endpointers would fight |
| **Barge-in decision** | **Server** | Needs turn state, which only the orchestrator holds |
| **Playback flush** | **Device**, on server command | Server decides, device executes — buffered audio lives on the device |

**The local VAD is a gate, not an endpointer.** This distinction is the one most likely to be
eroded during implementation. A device-side VAD that also decides turn boundaries will
disagree with the provider's, and the resulting turn state is unpredictable. It gates
transmission; the server decides when a turn ended.

## Options considered

### Device AEC + server endpointing — chosen

The only split where each decision is made where the necessary information exists.

### Server-side AEC — rejected

Would need the playback signal shipped back to the server, sample-aligned with capture,
across a variable-latency network. Alignment error destroys cancellation, and network jitter
guarantees alignment error. Also doubles upstream bandwidth.

### No AEC, half-duplex ("push to talk") — rejected

Mute the mic while speaking. Trivially removes the echo problem — and removes barge-in with
it. For a task agent that might be acceptable. For a companion, being unable to interrupt is
a personality defect: it makes the bot feel like it is delivering rather than conversing.

**Worth keeping as an emergency fallback** if AEC proves intractable on the chosen hardware.
It is a product downgrade, not a technical failure, and should be an explicit decision if it
happens.

### Device-side endpointing — rejected

Lower latency, since no network hop before the turn-end decision. Rejected because the
device cannot see the transcript. Deepgram's own argument applies: a transcript-backed turn
signal beats a raw-energy VAD, and only the server has the transcript.

## Consequences

**Hardware selection is now a gating decision.** AEC quality depends on microphone array,
speaker placement, and whether the platform provides a hardware or well-tested software
canceller. This ADR makes hardware choice an early decision, not a late one.

**AEC is on the critical path in both directions**, and is charged 30 ms in
[03](../03-latency-budget.md) with no basis beyond an estimate. A poor implementation costs
latency *and* correctness.

**The acceptance criterion is a repeated run, not a single one.** Echo leakage is
intermittent — it depends on volume, room acoustics and what is being said.
[Slice 2](../04-milestones.md#slice-2--speaker-and-microphone-in-the-same-room) requires
**ten consecutive turns with zero self-interruptions**. One clean conversation proves nothing.

**Barge-in sensitivity becomes a tunable with two failure modes.** Too sensitive: residual
echo self-interrupts. Too insensitive: real interruptions are missed and the bot talks over
the user. The safe default early is **less sensitive** — a bot that occasionally misses an
interruption is tolerable; one that interrupts itself is unusable. Tune toward sensitivity
only once AEC is measured.

**We inherit no provider defaults.** Sarvam publishes none for `threshold`,
`silence_duration_ms` or `min_speech_duration_ms`, exposing them in its own product only as
qualitative sliders ([Q6](../05-open-questions.md#q6-what-are-the-real-vad-and-endpointing-defaults)).
Deepgram publishes exact ranges and defaults for Flux — useful as a starting reference even
though it is not our default ASR: `eot_threshold` 0.5–1.0 (default 0.7),
`eager_eot_threshold` 0.3–0.9, `eot_timeout_ms` 500–60000 (default 5000)
([Flux config](https://developers.deepgram.com/docs/flux/configuration.md)).

**Audio format is fixed by the provider, not chosen.** `linear16`, **16 kHz**, mono upstream
— the Sarvam realtime socket accepts only 8000 or 16000 and closes with code `4000`
otherwise. 24 kHz downstream, the cap on Bulbul streaming. Frame size 80 ms, following
Deepgram's recommendation, since Sarvam publishes none.
