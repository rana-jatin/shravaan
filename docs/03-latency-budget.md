# 03 — Latency budget

**Target:** under 800 ms mouth-to-ear — from the user finishing speaking to the first
audio leaving the device speaker.

**Read this first.** Across both providers' entire documentation, **exactly one hard
latency number is published**. Everything else in the original allocation is a guess. This
document says which is which, and refuses to launder estimates as budget.

---

## 1. What the documentation actually gives us

| Number | Value | Source |
|---|---|---|
| Deepgram Flux end-of-turn detection | **~260 ms** | [Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md) |
| Deepgram Flux transcript update cadence | ~0.25 s | [Flux state](https://developers.deepgram.com/docs/flux/state.md) |
| Deepgram recommended audio chunk size | 80 ms | [Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md) |
| Deepgram `eot_timeout_ms` default | 5000 ms (max silence before forced turn end) | [Flux config](https://developers.deepgram.com/docs/flux/configuration.md) |
| Sarvam STT time-to-first-token | **not published** | [realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming) |
| Sarvam TTS time-to-first-audio | **not published** — "Lowest on a warm connection" | [which API](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-api-to-use) |
| Sarvam-105B time-to-first-token | **not published** | [pricing](https://docs.sarvam.ai/api/getting-started/pricing) |
| Sarvam VAD / endpointing defaults | **not published** — exposed only as "Sound sensitivity" (Low–High) and "Eagerness to respond" (Patient–Eager) | [conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings) |

One number. On the provider we are not defaulting to.

Two caveats on that scarcity. Sarvam's three marketing pages
(`www.sarvam.ai/speech-to-text`, `/text-to-speech`, `/models`) **refuse automated fetches
with HTTP 403** — if Sarvam publishes latency figures anywhere, that is the likely place,
and someone should open them in a browser before this budget is finalised. And the ~260 ms
figure is Deepgram's own claim under unstated conditions, not an independent measurement.

---

## 2. The proposed allocation, and what is wrong with it

The original straw-man: **ASR 150 / Redis 5 / LLM first token 250 / TTS first audio 250**
= 655 ms, leaving ~145 ms of headroom against the 800 ms target.

Two structural problems before any measurement:

**The ASR slot is already blown by the one number we have.** End-of-turn *detection* alone
is ~260 ms on Deepgram Flux — 110 ms over the entire 150 ms ASR allocation, before
transcription, before network. Endpointing latency is not optional; it is the delay between
the user stopping and the system knowing they stopped. Sarvam's VAD-based endpointing has
no published figure, but there is no reason to assume it is dramatically faster.

**A stage is missing entirely.** The allocation has no line for the device-to-server network
hop. A telephony agent inherits the carrier's path; a device on domestic wifi does not. That
round trip is real, variable, and outside our control.

---

## 3. Revised budget

Two columns: what we are aiming for, and how confident we are that it is achievable.

| # | Stage | Budget | Confidence | Basis |
|---|---|---|---|---|
| 1 | Device capture + AEC + encode | **30 ms** | Low | No provider input. Depends entirely on our own front-end and the chosen hardware |
| 2 | Device → server network | **40 ms** | **None** | Domestic wifi, variable. Unbudgeted in the original plan. Assume worse on mobile data |
| 3 | Server → ASR + endpoint detection | **280 ms** | Medium (Deepgram) / **None** (Sarvam) | Deepgram publishes ~260 ms EOT. Sarvam publishes nothing |
| 4 | Redis read (pipelined) | **5 ms** | High | Single round trip, co-located. The one line in the original plan that is safe |
| 5 | LLM first token | **250 ms** | **None** | Sarvam-105B publishes no figure |
| 6 | First clause assembled | **40 ms** | Medium | Our own chunker. Tunable against clause length |
| 7 | TTS first audio | **250 ms** | **None** | Sarvam publishes no figure; "lowest on a warm connection" only |
| 8 | Server → device + playback start | **50 ms** | **None** | Return network hop plus buffer priming |
| | **Total** | **945 ms** | | **145 ms over target** |

**The honest headline: with realistic stage estimates the design does not currently meet
800 ms.** The original 655 ms figure was reachable only by omitting both network hops and
under-allocating endpointing by more than half.

This is not necessarily fatal. Three of the eight stages have no published basis at all —
they could come in well under. But the plan should not be built on the assumption that they
will.

---

## 4. Where the plan breaks

What actually happens when each stage misses, in rough order of how likely the miss is.

### 4.1 Endpointing runs long (stage 3)

**Symptom:** the pause before the bot responds feels heavy. Users start repeating
themselves, which triggers a second turn, which compounds.

**If Sarvam's VAD is slower than Deepgram's ~260 ms**, the whole budget shifts. Mitigations,
cheapest first: tune `silence_duration_ms` and `min_speech_duration_ms` downward and accept
more false turn-ends; use partial transcripts to start the LLM speculatively before
`vad.speech_end`; or move ASR to Deepgram Flux where the number is at least known — which
costs Indic coverage beyond Hindi ([ADR 0006](adr/0006-asr-provider-under-free-switching.md)).

**Breaks the design if:** endpointing exceeds ~400 ms and cannot be tuned down. At that
point conversational feel is gone regardless of what the rest of the pipeline does.

### 4.2 TTS first audio runs long (stage 7)

**Symptom:** dead air after the user stops. The worst-feeling failure of the eight, because
the silence lands exactly where the user is waiting.

**Mitigations:** hold the TTS socket warm — Sarvam explicitly notes time-to-first-audio is
"lowest on a warm connection", and the socket auto-closes after ~1 minute idle, so a
keepalive `ping` is both a correctness and a latency measure. Shrink the first chunk to a
few words. Tune `min_buffer_size` down.

**Breaks the design if:** first audio exceeds ~400 ms warm. There is **no failover** — Bulbul
is the only Indic voice ([ADR 0005](adr/0005-tts-provider-split.md)) — so this cannot be
engineered around by switching providers. It would force a product change: a shorter
acknowledgement token, or accepting a slower cadence.

### 4.3 LLM first token runs long (stage 5)

**Symptom:** delay proportional to prompt size, growing as the profile grows.

**Mitigations:** cap the prompt hard — the profile caps in
[02-data-contracts.md](02-data-contracts.md) exist for this reason as much as for cost.
Trim the turn window from 12 toward 8. Use Sarvam's cached-input pricing tier (₹10.98 vs
₹29.28 per 1M) as a signal that prompt caching exists and is worth structuring for: keep
the stable prefix — system prompt, profile — genuinely stable.

**Breaks the design if:** first token exceeds ~450 ms. Then the filler policy has to expand
from tool calls to ordinary turns, which changes the personality of the product.

### 4.4 Network hops run long (stages 2 and 8)

**Symptom:** everything feels fine on the office LAN and bad in a home.

**This is the stage we control least and measured least.** Mitigations are architectural:
keep the server in-region (Sarvam is India-resident, which helps here and is a genuine
argument for it over Deepgram's EU/AU-only endpoints); size the device jitter buffer as
small as playback stability allows; consider edge termination if the user base spreads.

**Breaks the design if:** the round trip exceeds ~150 ms combined. Then no amount of
provider tuning recovers 800 ms, and the target itself needs revisiting.

### 4.5 AEC adds delay (stage 1)

**Symptom:** small steady tax on every turn, plus barge-in that feels sluggish.

AEC is on the critical path in both directions and is entirely ours
([ADR 0007](adr/0007-audio-front-end.md)). A poor implementation costs latency *and*
correctness — leaked echo makes the bot interrupt itself
([00 §7.2](00-provider-research.md#72-barge-in-on-an-open-air-device-is-an-echo-problem-the-docs-do-not-address)).

---

## 5. What must be measured before this is a budget

Nothing above stages 3, 5 and 7 is trustworthy until measured on real hardware, on a real
network, with real Hindi and Hinglish audio. The harness is small and should exist before
slice 2.

| Measurement | Method | Blocks |
|---|---|---|
| Sarvam STT endpoint latency | Timestamp last audio frame sent → `vad.speech_end` received. 100 utterances, varied trailing silence | Stage 3 |
| Sarvam STT partial cadence | Inter-arrival times of `transcript.partial` | Speculative-start viability |
| Sarvam-105B first token | Request sent → first streamed token, at realistic prompt sizes (2k / 4k / 8k tokens) | Stage 5, prompt caps |
| Bulbul first audio, cold | Connect → first `AudioOutput` | Warm-socket policy |
| Bulbul first audio, warm | Same on a socket held open with `ping` | Stage 7 |
| Device round trip | Frame timestamp echo, over wifi and mobile data | Stages 2 and 8 |
| AEC added delay | Loopback with a known impulse | Stage 1 |
| **End-to-end mouth-to-ear** | Audible marker in, audible marker out, single clock | The only number that actually matters |

Run these against both `hi-IN` and a Hinglish set — code-mixed input may endpoint
differently from monolingual, and that difference is precisely our case.

---

## 6. Policies that buy latency back

Available regardless of what the measurements say.

**Stream at clause boundaries.** Already in the design. The single largest structural win —
first audio depends on the first clause, not the full completion.

**Hold sockets warm.** Both providers benefit; Sarvam says so explicitly. The ~1 minute idle
close makes the keepalive mandatory anyway.

**Speculative LLM start.** Begin generating on a high-confidence partial before
`vad.speech_end`, and discard on `TurnResumed`. Buys most of the endpointing window back.
Costs wasted LLM calls — which count against a 40 req/min ceiling, so this trades latency
for concurrency and cannot be enabled blindly.

**Spoken fillers above 500 ms.** Already specified for tools. If stage 5 or 7 misses badly,
this expands to ordinary turns — a product change, not a tuning change, and it should be a
deliberate decision rather than a silent fallback.

**Cache the stable prompt prefix.** Sarvam prices cached input at roughly a third of fresh
input, which implies caching exists. Structure the prompt so the system block and profile
are byte-stable across turns.

---

## 7. Summary

- **One** latency figure exists in either provider's docs: Deepgram Flux's ~260 ms
  end-of-turn detection. It belongs to the provider we are not defaulting to.
- **Sarvam publishes no latency numbers at all** — not for STT, TTS, or the LLM. Three of
  our eight stages therefore have no documented basis whatsoever.
- The original 655 ms allocation omitted both network hops and under-budgeted endpointing
  by more than 100 ms. **A realistic estimate lands around 945 ms — over target.**
- The TTS stage has **no failover**, so a miss there is a product problem, not an
  engineering one.
- Everything here is provisional until the §5 harness runs. Treat this document as a set of
  hypotheses with named consequences, not as a budget that has been agreed.
