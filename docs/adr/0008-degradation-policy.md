# ADR 0008 — Degradation policy: what we say, what we swallow, what we lose

**Status:** Accepted · **Date:** 2026-08-29
**Resolves** [Q7](../05-open-questions.md#q7-does-memwrites-get-buffered-during-a-redis-outage-or-is-the-gap-accepted),
which [02 §6](../02-data-contracts.md#6-invalidation-rules) deliberately left open as
"buffer or accept the loss explicitly" without saying which.

## Context

Every dependency in this system has a documented failure response
([01 §6](../01-architecture.md#6-degradation)). What the design did not have was a policy
governing them collectively — which failures the user is told about, which ones we absorb in
silence, and how we decide the difference. Without that, each failure path gets its own ad-hoc
answer, and the sum of nine locally-sensible answers is a bot that either narrates its own
health to a user who never asked, or goes quiet with no explanation at all.

Both of those are real failure modes, and they pull in opposite directions.

## Decision

### 1. Severity has two levels, and only one of them is audible

| Severity | Meaning | User hears |
|---|---|---|
| `shallow` | The companion loses depth. The conversation continues | **Nothing** |
| `mute` | We can no longer hold a conversation | One short line, then the session closes |

`shallow`: store unavailable, JSON context unavailable, long-term memory unavailable,
`mem:writes` dropped, ASR failover active, LLM rate-limited, tools unavailable.

`mute`: ASR unavailable, **TTS unavailable**, LLM unavailable after repeated turns.

**Why shallow degradations are silent.** A companion that says "my long-term memory is
currently unavailable" is worse than one that is simply a little thinner for an evening.
Users did not ask for an operations report; announcing infrastructure to them transfers our
problem onto them, and they can do nothing with it. It goes in the logs, where someone can.

**Why mute degradations must be spoken.** The inverse failure is worse. Going quiet with no
explanation is the exact bug the speakability gate exists to prevent
([06](../06-speakability-gate.md)) — a TTS outage is the same silent failure arriving from a
different direction. If we cannot continue, we say so and close, in a language the user
speaks.

**One exception, and it is a real distinction, not a loophole.** A single failed *turn*
(`degraded.turn_failed`) is spoken while the session continues. That is not announcing a
degraded state; it is answering the turn. The user asked something and is owed a reply either
way — the same rule as a failed tool call, and silence after a "one moment" filler is the
worst of both.

Enforced by tests: every `mute` entry must carry a `message_key`, and no `shallow` entry may.

### 2. `mem:writes` during an outage — buffer, bounded, and count every drop

The question 02 §6 left open. Three candidates:

| Option | Verdict |
|---|---|
| Drop silently | **Rejected.** Forbidden by the contract, and rightly — under strong continuity a dropped write is a thing the companion will never learn, not a lost log line |
| Buffer without limit | **Rejected.** Turns a dependency outage into an OOM. A memory outage that takes the conversation down has inverted the point of the queue |
| Block the turn until it lands | **Rejected.** Inverts the asymmetry the seam exists to create: a failure here degrades tomorrow's conversation, never today's turn |
| **Bounded in-process buffer, drop-oldest-low-priority, counted** | **Chosen** |

Capacity defaults to 500 events (`MEM_WRITE_BUFFER`), well under a megabyte. On overflow the
buffer evicts the **oldest event of the lowest priority present**, not simply the oldest:

```
correction  >  session_closed  >  explicit_recall  >  turn_completed
```

Losing a `turn_completed` costs a detail. Losing a `correction` leaves a superseded fact
standing as current, and **a companion confidently repeating something you corrected is worse
than one that merely forgot.** Order is otherwise preserved on drain, because a correction
arriving before the fact it corrects reads to the distiller as a contradiction.

`droppedCount` is a product metric, not a debug counter. It belongs on a dashboard beside
consumer lag: it is literally the number of things the companion will never learn.

**Stated plainly, because it is the cost of choosing bounded over durable:** the buffer is
in-process. A crash during an outage loses the backlog. Making it durable means a local
write-ahead file, which is a second storage system with its own failure modes, added to
survive an outage of the first. Revisit if `droppedCount` is ever non-trivial in production.

### 3. A dependency outage must not become a latency outage

Redis, unreachable, does not fail in the ~5 ms
[03](../03-latency-budget.md) allocates — `ioredis` fails after a connect timeout, on every
call, on every turn. The stateless degraded path was already built and correct; it simply
never arrived on time.

So the store sits behind a **circuit breaker** (three consecutive failures, 10 s open, one
probe on half-open). After it opens, every call returns the empty answer immediately. The
companion becomes shallow *and fast*, rather than shallow *and broken*.

The lock is granted during an outage rather than denied. Denying it would silently stop the
user being answered at all, trading a rare cross-replica consistency risk for a guaranteed
one.

### 4. Retries are jittered, and bounded by the user's patience rather than the provider's

Sarvam-105B's limit is **per account** ([ADR 0003](0003-llm.md)) — 40 req/min on Starter. When
it trips it trips for every live conversation at once, so un-jittered backoff marches all of
them into the same retry instant and trips it again. Full jitter is not decoration here; it is
the only thing that drains the queue.

The loop stops when the **next delay would cross the budget** (2.5 s for the LLM), not when
attempts run out. There is a person waiting in real time: three well-spaced retries that
succeed after nine seconds are a worse outcome than giving up at two and saying something.

Retries stop at the **first streamed chunk**. Once a clause has been synthesised the user has
heard the start of a sentence; replaying the request produces a different completion and the
bot talks over its own opening. A 429 before first token is retryable; a failure after it
becomes a truncated reply, recorded as what the user actually heard.

### 5. TTS reconnects transparently, but never speaks stale text

Bulbul's socket closes after ~1 min idle
([WS docs](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket))
and a companion pauses far longer than that, so an idle close is routine and a reconnect is
not an incident.

The non-obvious half: **queued speech expires.** The naive implementation buffers what could
not be sent and replays it on reconnect, producing a bot that is silent for eight seconds and
then answers a question the user has already moved past. Text older than 3 s is dropped and
the drop is emitted as an event, so the orchestrator knows the reply it composed was never
heard.

### 6. ASR failover is off by default — for a residency reason, not a coverage one

The coverage limit is already known and is severe: `flux-general-multi` intersected with our
eleven speakable languages is **`hi-IN` and `en-IN`**
([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)). Nine
languages have no second ASR at any stage
([00 §7.1b](../00-provider-research.md#71b-fail-over-to-the-other-provider-survives-for-exactly-one-language)).

But that is not why it ships disabled. Sarvam is India-resident by design
([overview](https://docs.sarvam.ai/conversations/overview.md)); Deepgram publishes EU and AU
endpoints and **no India region**
([EU](https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available)). An automatic
failover therefore relocates a user's voice out of the country, mid-conversation, as a side
effect of incident response. **That is a data-protection decision, and a network blip should
not be the one making it.** `ASR_FAILOVER_ENABLED=false` is the default; enabling it is a
deliberate act by someone who owns that posture ([Q14](../05-open-questions.md#q14-does-deepgram-have-an-india-region-on-any-roadmap)).

Even when enabled, we reconnect to Sarvam first and only fail over from the second consecutive
failure, for the same reason.

### 7. The Bulbul apology is rendered ahead of time

No Indic TTS failover exists anywhere in the stack ([ADR 0005](0005-tts-provider-split.md)).
When Bulbul goes, the one message worth saying is the one message that cannot be synthesised.
It is rendered by `npm run render:holding`, committed as headerless linear16 PCM at
`TTS_SAMPLE_RATE`, and resolved through the same refusal ladder as the text copy — a missing
Odia clip becomes a Hindi apology, never silence.

Two failure modes of the mitigation itself are handled rather than assumed away: a sample-rate
mismatch is **refused rather than played** (wrong-rate PCM is a chipmunk apology, which is
worse than silence), and a missing clip logs an explicit "closing in silence" error, because
that line is the only trace the user's experience will leave.

## Options considered and rejected

**A single `degraded: boolean`.** What the code had. Cannot express "shallow but fine" versus
"we have to stop", so every call site invents its own threshold.

**Announce every degradation.** Honest, and terrible. The companion becomes a status page.

**Announce nothing; just close.** The failure this whole codebase is organised against.

**Retry until it works.** No budget means no bound on silence, and the user leaves before the
retry succeeds.

**A durable write-ahead log for `mem:writes`.** The correct answer if drops turn out to be
common. Rejected for now as a second storage system introduced to survive an outage of the
first, with its own outage modes — and `droppedCount` will tell us whether it is needed.

## Consequences

- `SessionState.degraded` has exactly one writer (the ledger), so a dependency that flaps
  twenty times appears once. It is read by humans during incidents.
- A resumed session **inherits** the degradations that were live when it paused. Starting
  clean would hide an outage that has been running for an hour.
- Three closing messages and one turn-failure message now need native-speaker review in nine
  languages, on top of the refusal and filler copy. They are the last thing some users ever
  hear, and they are currently `needsNativeReview: true` outside `en-IN` and `hi-IN`.
- `npm run render:holding` becomes a release step. If the voice or the copy changes and the
  clips are not regenerated, the outage apology arrives in a different voice from the rest of
  the conversation.
- The Deepgram standby is **hearing-only**. We can keep listening in Hindi through a Sarvam
  ASR outage; we cannot say a single word through a Sarvam TTS outage. That asymmetry is
  permanent given the vendor landscape.

## Watch items

- **`droppedCount` in production.** Non-trivial values move the durable-WAL decision from
  rejected to required.
- **Nova-3 as the standby instead of Flux.** Nova-3 reaches hi, ta, te, kn, gu, mr, pa, bn —
  **eight** of our eleven, against Flux's two
  ([models overview](https://developers.deepgram.com/docs/models-languages-overview)). It is
  not the Flux turn-taking model, so adopting it means running a second endpointing strategy
  that has never been tuned, and it does not resolve the residency question above. But if ASR
  redundancy ever becomes a hard requirement, this is the lever — and it is a much bigger one
  than the current design admits.
