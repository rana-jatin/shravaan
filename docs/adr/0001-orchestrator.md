# ADR 0001 — Roll our own orchestrator

**Status:** Accepted · **Date:** 2026-08-29

## Context

The orchestrator owns turn state, streaming, barge-in, language routing, tool dispatch and
the Redis/memory pipeline. Choosing it is close to irreversible: every other component's
interface is shaped by it.

Four options were evaluated against three requirements — a Deepgram TTS path for non-Indic
languages, an explicit Sarvam-105B choice, and our own turn state so the three-layer context
model in [01](../01-architecture.md) can exist.

*Scope later narrowed to Indian languages only, which removed the first requirement.
The decision is unaffected: the other two independently rule out both bundled agent APIs.*

## Decision

**Build our own orchestrator.** A single WebSocket from device to server; direct WebSocket
connections out to Sarvam and Deepgram; turn state, barge-in and memory owned by us.

## Options considered

### Sarvam Voice Agents — rejected

Closed stack. The documentation is explicit: **"Voice Agents does *not* support bringing
your own models at any part of the stack (ASR, LLM, or TTS)"**, and the LLM is not even
selectable — "Workloads are routed automatically based on the kind of request, so you don't
pick a model per agent" ([models](https://docs.sarvam.ai/conversations/build/models)).

That forecloses all three requirements simultaneously. Not a judgement call — a documented
prohibition.

### Deepgram Voice Agent API — rejected

More open on two of three axes: BYO LLM via `agent.think.endpoint` (or managed OpenAI,
Anthropic, Google, Groq, Bedrock) and BYO TTS via `agent.speak.endpoint` (or managed
ElevenLabs, Cartesia, OpenAI, Polly). But **"only Deepgram is supported"** for STT
([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)).

Deepgram STT reaches Hindi but not the other 21 Indic languages Saaras covers, and Deepgram
has no Indic voice at all. Viable for a Hindi-and-English product; fatal for a multilingual
Indic one.

### Pipecat — rejected

Strong fit on paper. Sarvam publishes a first-party guide with `SarvamSTTService`,
`SarvamLLMService(model="sarvam-105b")` and `SarvamTTSService(model="bulbul:v3")`
([Pipecat guide](https://docs.sarvam.ai/api/integration/build-voice-agent-with-pipecat)), and
both providers are maintainer-supported
([supported services](https://docs.pipecat.ai/server/services/supported-services)).

Rejected for fit, not capability. Pipecat's pipeline abstraction owns turn state, and our
three-layer context model — JSON context, Redis, long-term memory with distinct lifetimes
and a `mem:writes` consumer — wants that ownership. Sarvam's telephony guides also target
Pipecat specifically, and telephony is out of scope. We would be adopting a framework for
integrations we can write directly, and fighting it on the part that matters.

**Reconsider if** the orchestrator becomes a maintenance burden. This is the strongest
fallback.

### LiveKit Agents — rejected as orchestrator

Both providers ship as plugins for Python and Node
([STT](https://docs.livekit.io/agents/integrations/stt/),
[TTS](https://docs.livekit.io/agents/integrations/tts/)). Same abstraction objection as
Pipecat, without Sarvam's first-party guide.

**Worth revisiting as pure transport.** If device-side WebRTC (jitter buffering, packet
loss, adaptive bitrate) proves harder than expected in
[slice 2](../04-milestones.md#slice-2--speaker-and-microphone-in-the-same-room), LiveKit as
a transport layer under our own orchestrator is a reasonable hybrid.

## Consequences

We now own everything the bundled APIs provide free:

- Turn state machine and barge-in — including the `clear_audio` flush
- Clause-boundary chunking under Sarvam's "<500 characters" streaming guidance
- **Sarvam TTS keepalive** — `ping` before the ~1 minute idle auto-close
- Reconnect and resume across long idle companion stretches
- Endpointing tuning with **no published defaults** from Sarvam
  ([Q6](../05-open-questions.md#q6-what-are-the-real-vad-and-endpointing-defaults))
- All degradation and failover logic

**We borrow their design without adopting their product.** Sarvam's documented barge-in
rule — trigger on `vad.speech_start` or early partials, never `transcript.final`, with a
`clearAudio` event stopping playback
([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) —
is directly usable and is what [01](../01-architecture.md) models. Their turn-taking
vocabulary ("Sound sensitivity", "Eagerness to respond", nudges, max session length) is a
useful checklist of what a production agent needs to expose.

**The real cost is not the happy path.** One turn through a WebSocket is a day's work. The
months are in interruption edge cases, reconnection, and the failure modes in
[slice 8](../04-milestones.md#slice-8--degradation). That is the bet: that owning turn state
and the memory pipeline is worth rebuilding barge-in.
