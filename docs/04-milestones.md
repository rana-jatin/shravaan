# 04 — Milestones

Vertical slices. Each one is independently demoable — it produces something a person can
watch or listen to and judge. Each says what it deliberately does **not** do, because a
slice that quietly grows is a slice that stops being demoable.

The ordering principle: **push the unmeasured risks forward.** The two things most likely
to kill this design — echo cancellation and voice identity across languages — are answered
in slices 0 and 2, not discovered in slice 7.

---

## Slice 0 — Two listening tests (half a day, no product)

Not a product slice. It exists because two decisions gate the architecture and neither can
be settled by reading documentation.

**Deliverable:** a one-page findings note and a folder of audio samples.

| Test | Question | Why it gates |
|---|---|---|
| **Language token** | Does `saaras:v3-realtime` accept `auto`, `unknown`, or require an explicit `language_code`? Does per-turn switching work on the raw socket? | Three Sarvam pages disagree ([00 §7.4](00-provider-research.md#74-free-per-turn-language-switching-is-real--but-our-evidence-is-one-layer-above-our-api)). Decides whether free switching is buildable on our default provider |
| **Voice identity** | Does one Bulbul speaker sound like the same person across `hi-IN` → `en-IN` → `ta-IN`? Does one voice carry a Hinglish sentence without a seam? | Completely undocumented ([00 §7.3](00-provider-research.md#73-voice-identity-across-a-language-switch-is-undocumented)). Decides whether the companion can have one persona |

Test the Hinglish seam with real sentences, not clean ones — *"aapka appointment kal
evening 6 baje confirm ho gaya hai"* — the kind of thing the LLM will actually emit.

**Does not:** build anything, choose hardware, or write orchestrator code.

**Exit:** both questions answered in writing. If voice identity fails, stop and revisit
persona design before slice 1 — it changes the product, not the implementation.

---

## Slice 1 — Thinnest end-to-end Hindi exchange

One turn, spoken in, spoken out, in Hindi. Nothing else.

**Demo:** speak a Hindi sentence at a laptop. Hear a relevant Hindi reply.

**Scope:**
- Laptop mic → `linear16`, 16 kHz, mono → our WebSocket
- Sarvam `saaras:v3-realtime`, `language_code` fixed to `hi-IN`, VAD mode
- On `vad.speech_end`, send the final transcript to Sarvam-105B (no history, no profile)
- Stream the reply to `bulbul:v3` at 24 kHz, one default speaker
- Play out through laptop speakers

**Deliberately does not:** use Redis · persist anything between turns · support barge-in ·
run AEC · use a wake word · detect or switch language · touch Deepgram · handle any failure ·
run on target hardware · use headphones-free audio.

**Use headphones.** Without AEC, open-air playback will feed the ASR and the demo will fight
itself. That is slice 2's problem, and pretending otherwise here wastes a day.

**Exit:** one clean Hindi turn, end to end. Record the wall-clock mouth-to-ear time — the
first real datapoint against [03](03-latency-budget.md).

---

## Slice 2 — Speaker and microphone in the same room

The audio front-end. Highest technical risk in the project, taken second.

**Demo:** hold a multi-turn Hindi conversation on a device with an open speaker, no
headphones. Interrupt the bot mid-sentence; it stops immediately and listens.

**Scope splits by what needs hardware.** The server half is buildable and testable now;
the device half is not.

*Server side — built:*
- **Echo guard** (`src/domain/echo-guard.ts`): suppression window, confirm-on-transcript,
  and **self-text correlation** — echo transcribes as *our own words*, a signal no
  energy-based method has
- Barge-in per Sarvam's documented rule: trigger on `vad.speech_start` or early partials,
  **never** on `transcript.final`
- A `clear_audio` control message that flushes the device playback buffer
- Orchestrator turn state through `Speaking → Interrupted → UserSpeaking`
- Half-duplex emergency fallback behind a flag ([ADR 0007](adr/0007-audio-front-end.md))
- The self-interruption loop reproduced under test, including the ten-turn criterion

*Device side — pending hardware:*
- AEC with the playback bus as reference
- Local VAD as a transmit gate only — endpointing stays server-side
- Target hardware, or a representative stand-in

**Deliberately does not:** persist state · remember across sessions · switch language ·
call tools · handle provider failure · use a wake word.

**Exit:** ten consecutive turns on open-air audio with **zero self-interruptions**, *and*
a genuine interruption accepted on each of those ten. That pairing is the real criterion —
a guard that never self-interrupts because it has gone deaf is not a passing result. Echo
leakage is intermittent, so a single clean run proves nothing either way.

Both halves of that criterion are asserted in `test/echo-guard.test.ts` against simulated
leakage. **Simulation is not the exit** — it proves the logic, not the acoustics. The
criterion is met on hardware, in a room.

---

## Slice 3 — Working memory

The bot holds a conversation instead of a sequence of unrelated turns.

**Demo:** tell it your name in turn one; it uses it in turn six. Reference something from
three turns back; it follows.

**Scope:**
- `sess:{sid}:state` and `sess:{sid}:turns` per [02](02-data-contracts.md)
- 12-turn window in the prompt, pipelined single-read
- 30-minute idle TTL, refreshed on activity
- `sess:{sid}:lock` so barge-in cannot race a completing turn
- Session resume within the idle window

**Deliberately does not:** remember across sessions · warm any profile · write to
`mem:writes` · run the memory worker · call tools · switch language.

**Exit:** a ten-turn conversation with correct reference resolution, and a resume after a
five-minute pause that picks up the thread.

---

## Slice 4 — Continuity across days

The slice that makes it a companion rather than a chatbot. Under strong continuity this is
the product, not an enhancement.

**Demo:** have a conversation. Come back tomorrow. It greets you referencing something real
from yesterday, and picks up a thread you left open.

**Scope:**
- `mem:writes` stream, written fire-and-forget at turn completion
- Memory worker: distil facts, summarise episodes, supersede with soft deletes
- Semantic store and episode log per [ADR 0004](adr/0004-vector-store.md)
- `user:{uid}:profile` warmed at session open, 7-day TTL, invalidated on worker commit
- Correction handling — `kind: "correction"` supersedes rather than duplicates
- Consumer lag metric with an SLO

**Deliberately does not:** query long-term memory per turn · expose memory to the user ·
support deletion requests · switch language · call tools.

**Exit:** a session on day one, a session on day three that demonstrably uses day one, and a
correction on day three that supersedes rather than contradicts. Verify the supersede chain
in the store directly — not just in what the bot says.

---

## Slice 5 — Free language switching

Gated on slice 0. Build only what slice 0 proved possible.

**Demo:** start in Hindi, drop into Hinglish, switch to Tamil, switch back. The bot follows
on both input and output without a reconnect and without changing character.

**Scope:**
- Per-turn observed language on `sess:{sid}:state` and on each `Turn` record
- Mid-stream reconfiguration — Sarvam `config.update`; no socket churn
- TTS voice routing keyed on the voice matrix from [01 §3.8](01-architecture.md#38-tts-router)
- `preferred_language` as a sticky profile seed for the opening turn, not a lock
- Mixed-language turn window passed to the LLM as-is

**Deliberately does not:** support non-Indic languages — out of scope · handle the 12
unspeakable Indian languages, which is [slice 7](#slice-7--the-speakability-gate) · fail over
between ASR providers · call tools.

**Exit:** a conversation crossing three of the speakable languages with no reconnect, no
voice-identity break, and the `Turn` records showing per-turn language correctly. Include at
least one **Hinglish** stretch — code-mixing is the register the product actually lives in,
and it is what slice 0 tested the TTS against.

**If slice 0 showed the raw socket cannot auto-detect:** fall back to explicit switching on a
stated cue ("let's speak in Tamil") and record the limitation. Do not fake detection.

---

## Slice 6 — Tools and fillers

The bot acts on the world.

**Demo:** ask something requiring a backend call. The bot says "let me check", the call runs,
the answer is spoken. Then make the tool fail; the bot recovers gracefully in the right
language.

**Scope:**
- Tool contract per [02 §5](02-data-contracts.md#5-tool-call-contract)
- `sess:{sid}:pending` with deadlines
- Spoken filler above the 500 ms threshold, resolved per language via `spoken_fallback_key`
- `user:{uid}:ctx` invalidation on `context_mutated`
- Entitlement gating at offer time, not just execution
- JSON context fetched at session open

**Deliberately does not:** support parallel tool calls · retry automatically · handle
provider failover.

**Exit:** happy path, timeout path and not-entitled path all demoed. The failure paths matter
more than the success — check that `pending` is cleared in every case.

---

## Slice 7 — The speakability gate

The 12 Indian languages the stack can hear but cannot answer
([ADR 0005](adr/0005-tts-provider-split.md)).

**Demo:** speak Tamil — it works. Speak **Urdu** — Saaras transcribes it perfectly, and the
bot declines cleanly in a language it can speak rather than falling silent. Then switch into
Urdu at turn nine of a Hindi conversation and watch it stay coherent.

**Build specification: [06-speakability-gate.md](06-speakability-gate.md)** — matrix, three
gate positions, types, refusal-language ladder, code-mixing rules, test matrix, anti-patterns.

**Scope:**
- `languages.json` plus a pure verdict function over it
- **Gate 1** pre-connect on the seed language — refuses without opening a socket
- **Gate 2** on the first `transcript.final`, positioned **before the LLM dispatch**
- **Gate 3** on mid-session switches — declines the switch, **does not end the session**
- Refusal copy and pre-rendered audio in all 11 languages, native-speaker reviewed
- Code-mixing tolerance: never refuse on low confidence, require two consecutive turns at
  Gate 3, debounce voice switching
- Deepgram `flux-general-multi` wired as the **Hindi-only** ASR standby, consuming
  `word.confidence` to enable the low-confidence reprompt on that path
- Refusal-by-language telemetry — the evidence base for revisiting the Urdu decision

**Deliberately does not:** support any non-Indic language — out of scope · support the 12
excluded Indian languages — out of scope by decision ([ADR 0005](adr/0005-tts-provider-split.md)) ·
translate or substitute into a speakable language — rejected outright · use Deepgram TTS at
all, since Aura-2 has no Indic voice · attempt TTS failover.

**Exit:** the full test matrix in
[06 §8](06-speakability-gate.md#8-test-matrix) passes — 11 accepts, 12 refusals each spoken in
a language we *can* produce, zero LLM requests issued on a refused session, and a
mid-conversation switch into Urdu that declines once and continues in Hindi.

**The row that actually matters is the Hinglish one.** Every other case fails loudly in
testing. A gate that bounces code-mixed speech fails quietly in production, against the core
user.

**Why this is a whole slice.** The failure is silent by construction — the ASR succeeds, the
LLM succeeds, and only synthesis has nothing to say. Without an explicit gate the bug surfaces
in production as a bot that simply stops talking to Urdu speakers.

---

## Slice 8 — Degradation

Everything breaks on purpose.

**Demo:** kill each dependency in turn during a live conversation and watch the bot stay
coherent.

**Scope:**
- Redis down → continue on JSON context only, `degraded` flag set on resume
- Sarvam ASR timeout → fail over to Deepgram **on Hindi sessions only**; every other language
  degrades without a second ASR
- **Bulbul down → pre-rendered holding audio, then graceful close.** No TTS failover exists
  for any language
- LLM 429 → backoff with jitter, filler if it exceeds a turn budget
- TTS socket idle-closed → transparent reconnect before the next chunk
- Tool failure → spoken fallback, pending cleared
- `mem:writes` unavailable → the buffer-or-accept decision from
  [02 §6](02-data-contracts.md#6-invalidation-rules), resolved

**Deliberately does not:** add a third provider · attempt Indic TTS failover · guarantee
zero data loss during a Redis outage.

**Exit:** each failure injected during a live conversation, with the bot staying coherent
and the user never hearing a stack trace. **The Bulbul outage demo is the important one** —
it proves the accepted single point of failure degrades with dignity rather than silence.

---

## Sequencing rationale

**Slice 0 before anything.** Two undocumented behaviours gate the architecture. A day of
listening beats a month of building around a wrong assumption.

**AEC at slice 2, not slice 8.** It is the highest technical risk and it is entirely ours —
no provider helps. Discovering at slice 7 that open-air audio is unworkable would invalidate
everything built on top.

**Memory before language switching.** Continuity is the product; language switching is a
feature of it. If slice 4 fails, slice 5 does not matter.

**Deepgram late, and barely.** With scope fixed to Indian languages, Deepgram's entire role
is a **Hindi-only ASR standby** — its TTS has no Indic voice and goes unused. Nothing before
slice 7 depends on it, and the product ships without it if the schedule tightens.

**Degradation last but not optional.** It cannot be built before the paths exist. It is also
the slice most likely to be cut under pressure, so it is named as a slice with an exit
criterion rather than left as a task.

---

## Running the latency harness

The [03 §5](03-latency-budget.md#5-what-must-be-measured-before-this-is-a-budget) harness is
not a slice — it runs alongside, starting after slice 1 when there is a real path to measure.

| After | Measure |
|---|---|
| Slice 1 | Sarvam STT endpoint latency, LLM first token, Bulbul first audio cold and warm, end-to-end |
| Slice 2 | AEC added delay, device round trip on wifi and mobile data |
| Slice 3 | Redis read latency under a realistic window |
| Slice 5 | Whether code-mixed input endpoints differently from monolingual |

Update [03-latency-budget.md](03-latency-budget.md) with real numbers as they arrive.
Until then it remains hypotheses with named consequences.
