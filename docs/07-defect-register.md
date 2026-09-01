# 07 — Defect register

D1–D8 came from an audit on 2026-08-29, after the function-calling slice landed. D9 to D12
came later — from the external tools and the ASR standby — and all three were found by
**probing a live provider rather than by a test failing**, which is the pattern worth noticing
about them.

Each entry states the **symptom a user would experience**, the **mechanism that causes it**,
and **the fix**. D1–D8 are ordered by what to do first, which is not the same as by severity —
see §10.

Three of D1–D8 cannot be closed by writing code alone; they are gated on a measurement or on
hardware, and say so.

---

## D1 — One correction rewrites unrelated memories

**Severity:** data corruption · **Status:** latent · **Effort:** small

### Symptom

The user corrects one fact — "no, I live in Pune now" — and unrelated memories are silently
retired with it. The companion stops knowing their sister's name because they corrected their
address. Nothing surfaces: the facts are soft-deleted as `superseded`, which reads in the log
as normal housekeeping.

### Cause

[`worker.ts`](../src/memory/worker.ts) `#commitSession` computes the correction target **inside**
the per-fact loop, but the expression does not depend on the fact being processed:

```ts
for (const df of distilled.facts) {
  const explicit = events.find((e) => e.kind === "correction" && e.supersedes_fact_id);
  const target = (explicit?.supersedes_fact_id ? existing.find(…) : undefined)
    ?? matchExisting(df.supersedes_text, existing);
```

Every fact in the batch therefore resolves to the same `supersedes_fact_id`.
[`putFact`](../src/memory/in-memory-long-term-store.ts) then soft-deletes that target once per
fact and overwrites `superseded_by` each time, so the chain records only the last writer.

Reproduced with one correction plus two unrelated facts:

```
live facts after commit: 3
  "They live in Pune"             supersedes=<the Chennai fact>
  "Their sister is called Meera"  supersedes=<the Chennai fact>   ← wrong
  "They enjoy filter coffee"      supersedes=<the Chennai fact>   ← wrong
```

This is precisely the failure the supersede chain exists to make impossible. [ADR
0004](adr/0004-vector-store.md) and the `Fact` type both justify soft deletion on the grounds
that the log must stay explicable; a contaminated chain is less explicable than a hard delete,
because it asserts a causal link that never existed.

**Latent, not live.** Nothing emits a `correction` event yet — `remember_this` emits
`explicit_recall`, and `forget_this` calls `softDelete` directly. The first thing to emit a
correction trips this, and `correct_memory` is next on the tool list.

### Fix

A distilled fact that does not itself claim to replace something must never inherit the batch's
correction. Gate on the fact's own `supersedes_text`, and consume the explicit correction at
most once:

```ts
const explicit = events.find((e) => e.kind === "correction" && e.supersedes_fact_id);
let explicitUsed = false;

for (const df of distilled.facts) {
  // A fact that claims no replacement never supersedes anything, however the
  // rest of the batch is labelled.
  let target: Fact | undefined;
  if (df.supersedes_text) {
    if (!explicitUsed && explicit?.supersedes_fact_id) {
      target = existing.find((f) => f.id === explicit.supersedes_fact_id);
      if (target) explicitUsed = true;
    }
    target ??= matchExisting(df.supersedes_text, existing);
  }
```

**Trade-off to accept knowingly:** if the distiller produces the replacement fact *without*
setting `supersedes_text`, an explicit correction is now dropped rather than misapplied. That is
the right way round — a correction that fails to land leaves a stale fact the user can correct
again, while one that lands on the wrong fact destroys something they cannot recover.

**Also in this function:** `source_event_id: events[events.length - 1]!.event_id` attributes
every fact in a batch to the last event regardless of which turn produced it. The `Fact` type
documents provenance as the reason the field exists. Either carry per-fact provenance out of the
distiller, or attribute to the first event of the session rather than an arbitrary one.

### Test that closes it

One correction plus N unrelated distilled facts ⇒ exactly one fact with `supersedes` set, and
exactly one soft-deleted row. The existing memory suite only ever commits a single fact per
batch, which is why this survived.

---

## D2 — Audio from an interrupted reply still reaches the device

**Severity:** user-visible · **Status:** live · **Effort:** medium

### Symptom

The user interrupts. Playback stops — then a fragment of the abandoned sentence plays anyway, a
beat later. Worse, that fragment re-arms the echo guard, which then suppresses the user's actual
interruption for the length of the suppression window.

### Cause

Two halves.

**Nothing marks audio as belonging to an abandoned turn.**
[`session.ts`](../src/orchestrator/session.ts) forwards every frame unconditionally:

```ts
tts.on("audio", (buf) => {
  if (!this.#echo.isSpeaking) this.#echo.onPlaybackStart();
  this.#d.device.sendAudio(buf);
});
```

`#commitBargeIn` aborts the LLM, resets the chunker and sends `clear_audio`, but text already
handed to Bulbul keeps synthesising and arriving. The device clears its buffer and then receives
the tail.

**The guard re-arms on that tail.** `#commitBargeIn` calls `echo.onPlaybackEnd()`, so
`isSpeaking` is false, so the first stray frame calls `onPlaybackStart()` again — against an
empty `#spokenBuffer`, which also disables self-text correlation for those frames.

`SarvamTts.clearQueue()` was written for this and is called from nowhere.

### Fix

A monotonic turn epoch, compared on every frame:

```ts
#speakEpoch = 0;   // incremented by #respond and by #commitBargeIn

tts.on("audio", (buf) => {
  if (epochAtSubscribe !== this.#speakEpoch) return;   // abandoned turn
  …
});
```

The handler is registered once per socket, so the comparison has to be against a session field
rather than a captured local — capture the epoch when the turn starts speaking and store it
alongside, or tag frames through a small wrapper.

Also: call `tts.clearQueue()` in `#commitBargeIn`, so anything still queued for a dropped socket
is abandoned rather than replayed on reconnect.

**Accept:** Bulbul keeps synthesising the abandoned text and we discard the audio. There is no
documented cancel on the TTS socket, so the waste is unavoidable; only the playback is not.

### Test that closes it

Drive a barge-in, then emit a TTS `audio` event. Assert `device.sendAudio` was not called and
`echo.isSpeaking` is still false. **Currently unwritable** — see §9.

---

## D3 — Two fillers can still stack

**Severity:** cosmetic · **Status:** live · **Effort:** trivial · **Introduced by:** the
function-calling slice

### Symptom

On a rate-limited turn that then calls a slow tool, the user hears two fillers back to back:
"One moment." … "Let me check." It reads as a stutter rather than as patience.

### Cause

The per-round filler guard added for concurrent tool calls does not cover the LLM-retry filler.
[`#llmStream`](../src/orchestrator/session.ts)'s `onRetry` speaks directly:

```ts
this.#emitToTts(resolveFiller(this.#state.language, this.#fillerIndex++));
```

without setting `#roundSpoke` — and `#roundSpoke` is then **overwritten** from `roundText`
before tools run, so the retry filler is forgotten:

```ts
this.#roundSpoke = roundText.trim() !== "";
```

### Fix

Track "anything already spoken this turn" as a separate flag that the retry filler also sets,
and OR it in rather than assigning:

```ts
this.#roundSpoke = roundText.trim() !== "" || this.#spokeFillerThisTurn;
```

Reset `#spokeFillerThisTurn` at the top of `#respond`.

### Test that closes it

Session-level; **currently unwritable** — see §9.

---

## D4 — A language switch never reaches the ASR

**Severity:** narrow but wrong · **Status:** live · **Effort:** small

### Symptom

Only after an ASR failover. The user switches Hindi → English; Deepgram Flux stays pinned to
`hi` and transcription quality drops for the rest of the session. Those two languages are the
*only* ones the standby covers, so this is exactly the scenario it exists for.

### Cause

[`#setLanguage`](../src/orchestrator/session.ts) reconfigures TTS and nothing else:

```ts
this.#tts?.reconfigure({ languageCode: code });
```

`updateLanguage()` is implemented on **both** ASR clients and called from nowhere.
[`DeepgramAsr`](../src/providers/deepgram-asr.ts) is constructed with a fixed `languageHint`
taken from session state at failover time, and never revisited.

### Fix

Update the ASR only when it is actually pinned. On Sarvam the socket runs on `auto` and pinning
it would *disable* the free per-turn switching the product is built around — so this must not be
unconditional:

```ts
// Sarvam runs on `auto` and detects per turn; re-pinning it would turn free
// switching off. Only the standby needs telling.
if (this.#state.asr_provider === "deepgram") {
  this.#asr?.updateLanguage(code.split("-")[0]!);
}
```

### Test that closes it

Fake ASR client, force the failover path, switch language, assert `updateLanguage` was called
with `en` — and assert it was **not** called on the Sarvam path.

---

## D5 — No ASR keepalive · **measurement first**

**Severity:** unknown · **Status:** unverified · **Effort:** measure, then trivial

### Symptom (suspected)

A companion pause longer than the socket's idle timeout drops the STT connection. The session
recovers by reconnecting, but each reconnect counts against the budget in
[`asr-reopen.ts`](../src/domain/asr-reopen.ts), so ordinary silence erodes the allowance meant
for real failures.

### Cause

`SarvamAsr.ping()` is implemented and never scheduled. TTS has a 25 s keepalive because Sarvam
documents a ~60 s idle close on *that* socket. **Nothing establishes whether the STT socket
behaves the same way** — it is an assumption in both directions.

### Fix

Measure before coding. Open an STT socket, send no audio, log time-to-close. Then:

- **If it idle-closes:** add a keepalive interval mirroring the TTS one, well inside the
  observed timeout.
- **If it does not:** record that in [05-open-questions](05-open-questions.md) and delete
  `ping()`, rather than leaving an unused method that implies a need.

---

## D6 — The echo guard disarms while the speaker is still playing

**Severity:** user-visible on real hardware · **Status:** live · **Effort:** medium, hardware-gated

### Symptom

Self-interruption at the *end* of a reply. The agent finishes a sentence, the last of it is
still coming out of the speaker, and the mic hears it as a new user turn.

### Cause

`playback_drained` is derived from Bulbul's `done` event — which means **synthesis** finished,
not playback. At that moment the device still holds buffered PCM plus playback priming. The
guard disarms during the acoustic tail, which is the window most likely to leak.

This is structural: the server cannot know when the device stopped making noise, because only
the device knows.

### Fix

**Proper:** extend the device protocol with a `{ type: "playback_done" }` frame device → server,
and drive `playback_drained` from that instead. This mirrors the existing `clear_audio`
asymmetry — the server decides, the device reports what actually happened.

**Interim, computable today:** hold the guard armed for an estimated tail after `done`, derived
from bytes already sent:

```
tailMs ≈ bytesSent / (sampleRate * 2) * 1000 - elapsedSinceFirstFrame
```

Conservative and wrong in both directions, but strictly better than disarming at `done`.

Needs hardware to validate either way, and validation means measuring the self-echo rejection
rate ([ADR 0007](adr/0007-audio-front-end.md)), not eyeballing it.

---

## D7 — A second final transcript mid-reply is discarded · **measurement first**

**Severity:** unknown · **Status:** unverified · **Effort:** small once decided

### Symptom (suspected)

The user says two sentences. The second is dropped entirely — no reply, no acknowledgement, one
`turn skipped, lock held elsewhere` line in the log.

### Cause

Each `transcript.final` starts a turn, and the session lock is held across the whole of
`#respond`. A final arriving while a reply is being composed fails `acquireLock` and is
discarded:

```ts
if (!held) {
  this.#log("warn", "turn skipped, lock held elsewhere");
  return;
}
```

Whether this is reachable depends on something unverified: **does Saaras emit more than one
`transcript.final` per utterance?** If it segments long speech, this fires routinely. If one
final means one utterance, it is unreachable and the lock is doing its job.

### Fix

Measure first — speak a long multi-sentence utterance at a live socket and count finals.

- **If segmented:** buffer the skipped text rather than dropping it, and either append it to the
  in-flight turn or queue it as the next one. Dropping is the one option that is definitely
  wrong.
- **If not:** leave the lock alone and downgrade the log line, since it then only fires on a
  genuine race.

---

## D8 — Stale documentation

**Severity:** trivial · **Effort:** minutes

| Claim | Reality |
|---|---|
| README: "`assets/holding/` **is currently empty**" | Holds `en-IN` and `hi-IN` clips plus a manifest. The other nine fall down the refusal ladder to Hindi, which works — but the sentence is false |
| README status table: pre-rendered outage audio under "Not yet" | Partially done: 2 of 11 languages rendered |
| README: "252 tests" | 257 |

---

## 9. Why these clustered where they did — ✅ LANDED

Four of the eight (D2, D3, D6, D7) live in `Session`, and **`Session` had no tests at all**.
Nothing in the repo could construct one without opening live WebSockets to Sarvam, so the turn
loop, barge-in, the filler policy and the echo-guard lifecycle were all exercised only by hand.

Every other subsystem here is tested to a genuinely high standard — the domain modules are pure
and thoroughly covered, the store has a contract suite run against two implementations, the
copy tables are checked for completeness across all eleven languages. The defects were not
distributed evenly across the codebase. They were concentrated in the one file that could not be
tested.

**The highest-value fix in this document was not any of D1–D8.** It was a provider seam that
lets `Session` be constructed with fakes. That seam now exists:

```ts
export type SessionDeps = {
  …
  /** Defaults to the real clients. Tests pass fakes. */
  makeAsr?: AsrFactory | undefined;   // (cfg, AsrSpec) => AsrClient
  makeTts?: TtsFactory | undefined;   // (cfg, TtsOptions) => TtsClient
  makeLlm?: LlmFactory | undefined;   // (cfg) => LlmClient
  /** Clock and jitter for the LLM retry path. Real time by default. */
  clock?: { now?; sleep?; rand? } | undefined;
};
```

`AsrClient` was already an interface for exactly this reason — the failover work needed it.
`TtsClient` and `LlmClient` now exist alongside it in `src/providers/`, the three default
factories live in `src/providers/factories.ts` (the only module besides `server.ts` that names a
concrete provider class), and `test/session.test.ts` is the first test file that has ever
constructed a `Session` — 34 tests, no network, ~350 ms.

Three things worth knowing before you work on the defects below.

**The ASR factory takes a discriminated `AsrSpec`, not a bare options object.** The two clients
take genuinely different options, so the default factory narrows on `provider` without a cast —
and a fake is told which provider it is standing in for, which is precisely what D4 has to
assert on.

**The clock injection was not in the original sketch and is load-bearing.** `LLM_RETRY` uses
full jitter, so the first delay is uniform over [0, 250 ms), while the retry filler fires only
once `elapsedMs + delayMs` crosses `LLM_FILLER_AFTER_MS`. Against real jitter that is a coin
toss — D3's entire subject is not deterministically reachable without it. `withBackoff` already
accepted `now` / `sleep` / `rand`; `SessionDeps.clock` is only a way to reach them. The same
`rand` is threaded into `reopenDecision`, where the reopen delay is a real timer and its jitter
is the only thing deciding how long a failover test takes.

**D2, D3 and D4 now have characterisation tests that assert the WRONG behaviour on purpose.**
They are commented as such and each says what it should become. Fixing a defect means flipping
its assertion and deleting the note — not quietly editing the test to match new behaviour.

---

## 10. Order of work

| # | Defect | Why here |
|---|---|---|
| 1 | **D1** correction contamination | Data corruption, and it is small. Latent only until `correct_memory` ships, which is next on the tool list |
| 2 | **D3** stacked fillers | Trivial, and it was introduced by the last slice — fix it before it becomes ambient |
| ~~3~~ | ~~**§9** the test seam~~ | ✅ **Done.** Everything below it is now cheaper and safer: D2, D3 and D4 each have a failing-on-purpose test waiting to be flipped |
| 4 | **D2** post-barge-in audio | The most user-visible live defect. Touches the hot audio path, so do it with tests in place |
| 5 | **D4** ASR language pinning | Narrow, but wrong, and it undermines the standby's only reason to exist |
| 6 | **D8** stale docs | Minutes |
| 7 | **D5, D7** | Blocked on measurement against a live socket |
| 8 | **D6** playback tail | Blocked on hardware |

D5 and D7 are both single questions to a live socket and could be answered in an hour by
whoever next has a key in front of them. Answering them is cheap; guessing is what produced two
of the defects above.

---

## D9 — Weather for the wrong continent, spoken with total confidence

**Severity:** confidently wrong answer · **Status:** **fixed 2026-08-30** · **Effort:** small

Found by running `get_weather` against the live API on the day it was written, not by audit.
Recorded because the failure shape is the one this product is least able to survive, and the
mechanism will recur for any tool that resolves a user's words to an external identifier.

### Symptom

The user asks for the weather in **Allahabad**. The companion answers fluently, with a
plausible temperature and a real forecast — for **Allāhābād, Razavi Khorasan, Iran**, about
3,000 km away.

Nothing marks it wrong. There is no error, no timeout, no fallback copy, and no hesitation in
the voice. A listener has no way to detect it, and the users most likely to trigger it are
exactly the ones this product is for: an elderly caller in Prayagraj who has said "Allahabad"
their whole life.

### Cause

Two independent gaps, either of which was enough on its own.

**Open-Meteo's index carries only the current name.** Allahabad was renamed Prayagraj in 2018.
The geocoder's global ranking for "Allahabad" is *ten Iranian villages deep with no Indian hit
at all* — verified against the live endpoint:

```
0 IR Allāhābād Razavi Khorasan   36.13848 58.64241   ← what the user got
1 IR Allāhābād Isfahan           32.67207 50.96500
…
9 IR Allāhābād Razavi Khorasan   35.10193 59.27375
```

So no amount of ranking or country biasing reaches Prayagraj. `countryCode=IN` returns a
*different* wrong answer — Allahabād, a village in Punjab.

**And `count=1` took the top hit blindly.** The original handler trusted the geocoder's first
result with no country preference and no confirmation to the user, which is what turned a
lookup miss into a spoken falsehood.

A third gap surfaced in the same run: a **six-digit PIN code does not geocode at all**.
Open-Meteo returns nothing for `211004`, so the tool answered `unknown_place` for an input any
Indian user might reasonably give.

### Fix

Three parts, all in [`builtin.ts`](../src/tools/builtin.ts):

1. **`PLACE_ALIASES`** — old name → current name, applied to the whole trimmed string before
   geocoding. Twenty renamed Indian cities. Whole-string match only, so "New Bombay" does not
   become "New Mumbai".
2. **`countryBias`** (`WEATHER_COUNTRY_BIAS=IN`) — a *preference*, not a filter: the biased
   query runs first, and an empty result falls through to an unbiased retry, so the companion
   still answers about London. Verified: `countryCode=IN` for London returns zero results.
3. **PIN code resolution** via India Post (`api.postalpincode.in`), which returns a district
   name that is then run through the alias table — because India Post *also* returns the
   pre-rename "Allahabad".

The result now carries **`asked_for`** whenever the resolved place differs from what the user
said, so the model can confirm the substitution out loud ("in Prayagraj — that's your 211004").
That is the only mechanism by which a listener can catch a wrong resolution, and it is the part
of this fix worth carrying to any future lookup tool.

Verified live after the fix:

| Asked | Resolved |
|---|---|
| `211004` | Prayagraj, Uttar Pradesh, India |
| `Allahabad` | Prayagraj, Uttar Pradesh, India |
| `Prayagraj` | Prayagraj, Uttar Pradesh, India |
| `London` | London, England, United Kingdom |

Ten regression tests in [`test/external-tools.test.ts`](../test/external-tools.test.ts).

### What generalises

**A lookup that cannot fail loudly will fail quietly.** Every other tool in this product either
succeeds or returns a domain outcome the model narrates. This one had a third state nobody
designed — *succeeded, wrong* — because an external identifier resolver always has one, and the
tool had no way to express doubt. `asked_for` is that expression.

The alias table is also a reminder that the naming this product must handle is the users' own,
not the gazetteer's. It will need extending, and the cost of a miss is not an error message.

---

## D10 — Seven ways the calendar spoke the wrong appointment

**Severity:** wrong answer, spoken as fact · **Status:** fixed 2026-08-31 · **Effort:** medium

### Symptom

All seven produced a *confident, fluent, wrong* answer rather than a crash or an error. From
the outside every one of them sounds exactly like the tool working.

| # | What the user hears | Trigger |
|---|---|---|
| 1 | Tomorrow's event announced as today's | Any all-day event, i.e. **every entry in the shipped holidays feed** |
| 2 | A fortnightly physio slot announced weekly | `FREQ=WEEKLY;INTERVAL=2;BYDAY=…` |
| 3 | A monthly check-up drifts to the 3rd, and stays there | `FREQ=MONTHLY` anchored on the 29th–31st |
| 4 | A leap-year birthday announced every 1 March | `FREQ=YEARLY` on 29 February |
| 5 | "You have Reminder at half past ten" | Any event carrying a `VALARM` |
| 6 | A cancelled session still read out | `EXDATE` |
| 7 | A rescheduled appointment read out twice — old slot and new | `RECURRENCE-ID` |

### Cause

Each is a separate mechanism, but they share a shape: **the parser had no way to be unsure**,
so every gap resolved to a plausible date rather than to no date.

1. **Inclusive window end.** `parseCalendar` tested `start <= to` while `windowFor` returns `to`
   as midnight of the *next* day. An all-day event starts at midnight, so the boundary landed
   exactly on it.
2. **`BYDAY` dropped `INTERVAL`.** The weekly branch stepped one day at a time when `BYDAY` was
   present — which is what makes "Tuesday and Thursday" yield both — and nothing in that path
   consulted `INTERVAL`. This is the only defect here that *invents* extra appointments.
3. **`setMonth` overflow, then persistence.** `cursor.setMonth(+1)` on 31 January gives 3 March,
   and the cursor keeps the 3rd from then on. One short month corrupts every later occurrence.
4. **`setFullYear` overflow**, identically, on 29 February.
5. **Flat property parsing.** RFC 5545 requires an email `VALARM` to carry its own `SUMMARY`;
   `props.set` is last-wins, so the alarm's name replaced the appointment's.
6. **`EXDATE` unparsed** — and it cannot live in the `props` map at all, since it may both
   repeat across lines and carry comma-separated values.
7. **`RECURRENCE-ID` unparsed.** Google publishes a moved occurrence as a second `VEVENT`
   sharing the `UID`; the parent keeps its `RRULE` untouched, so both slots expand.

### Fix

All in [`ical.ts`](../src/domain/ical.ts).

- The window is now **half-open `[from, to)`** throughout, and `windowFor` says so.
- `MONTHLY`/`YEARLY` occurrences are **constructed from the original day-of-month** at each
  step rather than by mutating a cursor. A date that does not exist that period is skipped, per
  RFC 5545 — and skipped rather than nudged onto a neighbouring day the user has nothing on.
- The weekly `BYDAY` walk carries a **week index** relative to `DTSTART`'s week, so `INTERVAL`
  applies. `WKST` is honoured for the week boundary.
- `parseEvents` **tracks nesting depth** and ignores properties inside a sub-component.
- `EXDATE` and `RECURRENCE-ID` build a per-event **exclusion set**, applied to the parent only
  — an override whose time was *not* changed has a `DTSTART` equal to its own `RECURRENCE-ID`
  and would otherwise erase the very appointment it exists to describe.

The three fast-forward branches each carry forward **how many occurrences they jumped over**,
so `COUNT` survives the jump; #2's fix made that arithmetic harder, because a `BYDAY` week
contributes several occurrences and the first week contributes only a partial set.

Fifteen regression tests in [`test/calendar.test.ts`](../test/calendar.test.ts). Re-verified
against the live 524-event Google feed.

### What generalises

**Date arithmetic by mutation is a silent-corruption machine.** `setMonth` and `setFullYear`
overflow instead of failing, and the overflow *persists in the cursor* — so one impossible date
poisons everything after it. Recomputing each occurrence from the original anchor makes the
impossible case representable (`null`) and therefore refusable.

And the same lesson as [D9](#d9--weather-for-the-wrong-continent-spoken-with-total-confidence):
these were all found by **probing the parser against inputs a real calendar contains**, not by
a test failing. The existing suite was green throughout. A test written from the same mental
model as the code will agree with the code.

---

## D11 — The ASR standby has never heard a word

**Severity:** whole feature silently absent · **Status:** fixed 2026-09-01 · **Effort:** small

### Symptom

Sarvam ASR goes down. The failover ladder does exactly what it was built to do: it opens a
Deepgram Flux socket, logs `asr_failover_active`, and hands it the user's audio.

The user then talks to something that cannot hear them. Not an error, not a refusal — the
socket is open, the audio is flowing, Deepgram is billing, and no transcript is ever emitted,
so no turn ever starts. From inside the process everything is healthy. From the chair it is a
companion that has gone silent on the one day it was supposed to cover for.

Every downstream consumer inherits the silence: barge-in never fires because `speech_start`
never fires, and the low-ASR-confidence reprompt of [Q4](05-open-questions.md) has no input at
all — on the only path that was ever going to supply one.

### Cause

**The discriminant is nested, and the client read the outer one.**

Flux sends the turn lifecycle wrapped in an envelope. Captured verbatim from a live socket:

```json
{"type":"TurnInfo","event":"Update","transcript":"I'm losing my voice",
 "words":[{"word":"I'm","confidence":0.9995,…}],"languages":["en"]}
```

Only the connection-level frames — `Connected`, `Error` — put their name in `type`. Every
transcript-bearing frame is `type: "TurnInfo"`, with the name the client actually wants in
`event`. [`deepgram-asr.ts`](../src/providers/deepgram-asr.ts) switched on `msg["type"]` with
arms for `StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed` and `EndOfTurn` — the five
values of `event`. So all five arms were unreachable and every frame fell to:

```ts
default:
  // Connected / Metadata / anything added later. Ignoring unknown frames
  // beats crashing a session that is already running degraded.
  return;
```

That `default` arm is a good rule that ate the entire feature. Tolerating unknown frames and
dropping every known one are indistinguishable from inside the switch.

A second, smaller misreading rode along: `toTranscript` read `msg["language"]`, a singular
string. The endpoint sends `languages`, an array. That read resolved to `undefined` on every
frame, so the standby would never have reported a language even once the dispatch was fixed.

### Fix

Resolve the discriminant before switching, in [`deepgram-asr.ts`](../src/providers/deepgram-asr.ts):

```ts
const kind = String((msg["type"] === "TurnInfo" ? msg["event"] : msg["type"]) ?? "");
```

and read `languages[0]` rather than `language`. Thirteen regression tests in
[`test/deepgram-asr.test.ts`](../test/deepgram-asr.test.ts) replay frames **copied off a live
socket**, driven through a local WebSocket so the auth header and the binary/JSON split travel
the production path.

Verified end to end with the new `npm run verify:asr`, which streams the pre-rendered holding
clip through the shipped client and asserts words come back:

```
-- 2  does real speech come back as words? (en-IN, 4.3s at 24000 Hz)
   ✔ 16 partial(s), 1 final(s)
   final: I'm losing my voice. Something's wrong on my end. Let's pick this up again shortly
-- 3  is word.confidence present? (the field Sarvam does not have)
   ✔ present · confidence 0.9999 · language en
```

Hindi passes identically. `word.confidence` is real and populated, so Q4 is implementable
after all — which it demonstrably was not for as long as this defect stood.

### What generalises

**566 tests, and not one of them had ever handed this client a frame.** The suite was green
across the entire life of the defect, because coverage of the *failover decision*
([`asr-failover.ts`](../src/domain/asr-failover.ts), well tested) was mistaken for coverage of
the *failover working*. The ladder was verified; the rung it steps onto was not.

This is the third consecutive defect — after [D9](#d9--weather-for-the-wrong-continent-spoken-with-total-confidence)
and [D10](#d10--seven-ways-the-calendar-spoke-the-wrong-appointment) — found by probing a live
provider rather than by a test failing, and the sharpest case of the pattern: a test written
from the docs would have invented `{"type":"Update"}` frames, agreed with the code, and passed.
**The only fixture that can catch a misread wire format is one captured off the wire.** Hence
the rule the new test file states in its header: the frames are verbatim, and nobody may tidy
them into what they expect them to say.

It also puts a number on the standby's real status. The README's table of five wrong Sarvam
guesses, two of them silent, now has a Deepgram row — and the lesson holds a second time:
**every provider integration in this repo that has not been dialled against a live key should
be assumed broken until a `verify:*` script says otherwise.** `verify:asr` closes that gap for
Flux; `verify:care` already did for `/v1/read`.

---

## D12 — The care watch-list flags a hospital visit nobody mentioned

**Severity:** confident wrong answer, shown to a caregiver · **Status:** feature off by default ·
**Effort:** small to contain, unbounded to fix properly

Found by running `npm run verify:care` against a live Deepgram key on 2026-09-01 — the run
[ADR 0009](adr/0009-audio-intelligence.md) said must happen "before trusting any of it".

### Symptom

A caregiver reads the week's `flagged_intents` and sees **"mentions a doctor or hospital
visit"**. The person mentioned no doctor and no hospital. Meanwhile the four things they *did*
say — not sleeping, knee pain, an empty house, wanting to ring their sister, all of them
verbatim watch-list items — are not flagged at all.

### Cause

Not a field-name error. The client and the shapes in
[`deepgram-read.ts`](../src/providers/deepgram-read.ts) are **correct**; probes 1 and 2 pass,
and `custom_intent_mode=strict` really does return only submitted labels, exactly as the ADR
claims. The classifier itself is the problem.

The `verify:care` transcript, run five times with an identical request:

```
run 1   mentions a doctor or hospital visit (0.54)   -> FLAGGED
run 2   mentions a doctor or hospital visit (0.65)   -> FLAGGED
run 3   mentions a doctor or hospital visit (0.80)   -> FLAGGED
run 4   mentions a doctor or hospital visit (0.03)   -> not flagged
run 5   mentions a doctor or hospital visit (0.02)   -> not flagged
```

Three findings, and the third is the one that matters:

1. **The only label ever returned is one that is not in the text.** Across five runs, "reports
   not sleeping", "reports pain", "expresses loneliness" and "asks to contact a family member"
   never appeared once, though the transcript states all four in plain words.
2. **Confidence swings 0.02 to 0.80 on identical input.** These are model calls, not lookups.
3. **`CARE_SIGNALS_INTENT_CONFIDENCE=0.5` therefore decides nothing.** The same session is
   flagged or clean depending on which side of the floor a nondeterministic score lands — so a
   trend line built from it is sampling noise, and "no flags this week" carries no information.

`custom_intent_mode=extended` is worse, not a workaround: it returns invented labels —
`"reports pains in knee pains."`, `"mentions money troubleshooting"`, `"expresses hopelessness
and desire to avoid unnecessary interruptions"`. Strict remains the right choice, and this is
the evidence for the ADR's reasoning rather than against it.

**Sentiment is unaffected and is fine.** `results.sentiments.average` maps correctly and is
near-deterministic across calls: `-0.31851118` and `-0.31851104` for the same input. The
numeric trend the ADR wanted is real. Only the watch-list half is broken.

### Fix

Contain now, decide later.

- **Do not ship `flagged_intents` to a human.** A hallucinated hospital visit in a care summary
  is worse than an empty summary, because it will be believed and possibly acted on.
- If it stays wired at all, the floor belongs near **0.9**, and even then run 3 (0.80) shows a
  fabricated label can approach it. A floor cannot separate signal from noise when the noise
  and the signal are the same label.
- **Prefer the distiller.** `LlmDistiller` already reads the transcript in all eleven languages
  and could be asked for watch-list hits in the same call it already makes — no second
  provider, no English-only gap, no extra residency question, and a model that has the whole
  conversation rather than a segment.

`ADR 0009 §3` justified keeping intents because "strict is the point: it returns only what we
submitted, so nothing unreviewed can reach a caregiver". That is true and beside the point:
what reaches the caregiver is a **reviewed label attached to something never said**.

### What generalises

The third time in this repo. [D9](#d9--weather-for-the-wrong-continent-spoken-with-total-confidence)
was weather for the wrong continent; [D10](#d10--seven-ways-the-calendar-spoke-the-wrong-appointment)
was appointments on the wrong day; this is a symptom nobody reported. Every one is an external
service answering **confidently and wrongly**, and every one was found by probing a live
provider rather than by a test failing. A hermetic test suite cannot catch this class at all —
it can only check that we handle the shape we were given.
