# 02 — Data contracts

Schemas and key shapes only. No implementation.

All identifiers: `sid` = session id (ULID), `uid` = user id (opaque, from our backend),
`tid` = turn id (monotonic within a session).

Times are RFC 3339 UTC. Durations are seconds unless the field name says `_ms`.

---

## 1. JSON context — read-only, from our backend

The authoritative record of who the user is and what they are entitled to. **The agent
never writes this.** A tool mutates it through the backend, and the cache is then
invalidated.

Fetched once at session open. Refreshed only when a tool reports a mutation.

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "JsonContext",
  "type": "object",
  "required": ["uid", "fetched_at", "identity", "entitlements"],
  "additionalProperties": false,
  "properties": {
    "uid":        { "type": "string" },
    "fetched_at": { "type": "string", "format": "date-time" },
    "etag":       { "type": "string",
                    "description": "Backend version. Cheap revalidation without a full refetch." },

    "identity": {
      "type": "object",
      "required": ["display_name"],
      "additionalProperties": false,
      "properties": {
        "display_name":       { "type": "string" },
        "preferred_name":     { "type": "string" },
        "pronouns":           { "type": "string",
                                "description": "As stated by the user. Absent means use they/them." },
        "locale_hint":        { "type": "string",
                                "description": "BCP-47. A hint for the opening turn only, never a lock." },
        "timezone":           { "type": "string", "description": "IANA tz" }
      }
    },

    "account": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "tier":         { "type": "string" },
        "status":       { "type": "string", "enum": ["active", "suspended", "trial", "closed"] },
        "created_at":   { "type": "string", "format": "date-time" }
      }
    },

    "entitlements": {
      "type": "array",
      "description": "Capability grants. Gates which tools may be offered at all.",
      "items": {
        "type": "object",
        "required": ["key", "granted"],
        "additionalProperties": false,
        "properties": {
          "key":        { "type": "string" },
          "granted":    { "type": "boolean" },
          "expires_at": { "type": ["string", "null"], "format": "date-time" }
        }
      }
    },

    "history": {
      "type": "array",
      "description": "Backend-owned record — orders, tickets, appointments. NOT conversational memory.",
      "items": {
        "type": "object",
        "required": ["kind", "id", "occurred_at"],
        "additionalProperties": true,
        "properties": {
          "kind":        { "type": "string" },
          "id":          { "type": "string" },
          "occurred_at": { "type": "string", "format": "date-time" },
          "summary":     { "type": "string" }
        }
      }
    }
  }
}
```

**Why `history` here and not in long-term memory.** This is what the backend knows happened.
Long-term memory is what the *conversation* established. They disagree sometimes, and when
they do the backend wins on fact and memory wins on what the user believes. Merging them
destroys that distinction.

---

## 2. Redis — working memory

All keys namespaced. TTLs are **idle windows**, refreshed on access — not call durations.
This is the correction from the original design, which assumed a session that ends when a
call ends ([01 §7](01-architecture.md#7-what-the-companion-shape-changes)).

### 2.1 Key map

| Key | Type | TTL | Refreshed on |
|---|---|---|---|
| `sess:{sid}:state` | Hash | **30 min idle** | Every turn |
| `sess:{sid}:turns` | List (capped 12) | **30 min idle** | Every turn |
| `sess:{sid}:pending` | Hash | **30 min idle** | Every tool dispatch |
| `sess:{sid}:lock` | String | **10 s** | Held during a turn |
| `user:{uid}:ctx` | JSON string | **15 min absolute** | Not refreshed — invalidated |
| `user:{uid}:profile` | JSON string | **7 days absolute** | Invalidated by the memory worker |
| `mem:writes` | Stream | maxlen ~100k | Trimmed by the consumer |
| `sched:id:{id}` | JSON string | **none** | Never expires — deleted explicitly |
| `sched:index:all` | Set of ids | **none** | The ticker reads this |
| `sched:index:user:{uid}` | Set of ids | **none** | One person's reminders |

**`sess:*` = 30 min idle.** A companion pauses. Someone walks away mid-sentence and comes
back. A call-length TTL would drop the thread exactly when continuity matters most. Thirty
minutes covers a realistic pause; beyond that, session resume rebuilds from the profile.

**`user:{uid}:ctx` = 15 min absolute, not idle.** Entitlements and account status must go
stale predictably. An idle TTL on authoritative data means a suspended account keeps its
capabilities as long as it stays chatty.

**`user:{uid}:profile` = 7 days absolute.** Under strong continuity this cannot be
session-scoped, or every session pays a cold long-term-memory read. It is a durable cache,
invalidated explicitly when the memory worker commits new facts.

**`sess:{sid}:lock`.** One turn at a time per session. Prevents a barge-in racing a
completing turn into a corrupted window.

**`sched:*` = no TTL, and it is the only exception in this table.** Everything above is
working memory and is *meant* to go stale. A schedule is a standing instruction from a
caregiver — "the blue tablet at eight" — and a key that quietly expired would turn a
missed dose into a silence nobody could attribute to anything. Schedules end when someone
deletes them. See [2.7](#27-sched--standing-reminders).

### 2.2 `sess:{sid}:state` — Hash

| Field | Type | Notes |
|---|---|---|
| `user_id` | string | |
| `language` | string | BCP-47. **Per-turn observed value, not a lock.** |
| `language_source` | string | `profile` \| `detected` \| `user_stated` |
| `language_confidence` | float | From `language_probability` where available |
| `turn_no` | int | Monotonic |
| `agent_speaking` | `0` \| `1` | Drives the barge-in edge |
| `last_tool` | string | Tool name or empty |
| `slots` | JSON string | Current slot values (§2.3) |
| `started_at` | RFC 3339 | |
| `last_activity_at` | RFC 3339 | Drives idle expiry |
| `asr_provider` | string | `sarvam` \| `deepgram` — recorded for failover accounting |
| `degraded` | JSON array | Active degradations, e.g. `["redis_partial","asr_failover"]` |

### 2.3 Slots

```ts
type SlotValue = {
  value: string | number | boolean | null;
  /** Provenance matters for the reprompt policy. */
  source: "user" | "context" | "inferred";
  /** Absent on the Sarvam path — no ASR confidence is exposed. See 05. */
  asr_confidence?: number;
  filled_at: string;   // RFC 3339
  confirmed: boolean;  // explicitly read back to the user
};

type Slots = Record<string, SlotValue>;
```

`asr_confidence` is optional **because it is unavailable on our default provider**. Sarvam's
streaming API documents `language_probability` — a language-identification score — but no
transcription confidence. Any policy that branches on this field must tolerate its absence.

### 2.4 `sess:{sid}:turns` — capped List

Last 12 turns, `LPUSH` + `LTRIM 0 11`. This is the LLM window.

```ts
type Turn = {
  tid: number;
  role: "user" | "agent";
  text: string;
  language: string;          // BCP-47, as observed on this turn
  at: string;                // RFC 3339
  /** Set on agent turns that invoked tools. */
  tool_calls?: { name: string; ok: boolean }[];
  /** Set when the turn was cut short by the user. */
  interrupted?: boolean;
};
```

`language` is **per turn**, not per session. A companion that code-switches produces a
window with mixed languages in it, and the LLM should see that rather than a flattened
single value.

### 2.5 `sess:{sid}:pending` — Hash

In-flight tool calls, keyed by `call_id`.

```ts
type PendingCall = {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  dispatched_at: string;     // RFC 3339
  deadline_ms: number;
  filler_spoken: boolean;    // did we already say "one moment"?
};
```

Cleared on completion, timeout or session teardown. A stale entry here is what makes an
agent claim it is still working on something it abandoned.

### 2.6 `user:{uid}:profile` — distilled long-term profile

The only long-term memory on the turn path. Warmed at session open, small enough to sit in
every prompt.

```ts
type Profile = {
  uid: string;
  distilled_at: string;          // RFC 3339
  /** Sticky preference. Seeds the opening turn; does not lock the session. */
  preferred_language: string;    // BCP-47
  /** Highest-salience facts only. Hard cap — this goes in every prompt. */
  facts: { id: string; text: string; salience: number }[];  // max 30
  /** One line per recent episode, newest first. */
  recent_episodes: { id: string; summary: string; at: string }[];  // max 10
  /** Threads the user left open. The heart of feeling remembered. */
  open_threads: { id: string; text: string; last_touched: string }[];  // max 5
};
```

**Caps are deliberate.** This payload is in the prompt on every turn, so it is charged
against both the latency budget and the token bill on each. Growth here is silent and
compounding; the caps make it a design decision instead.

### 2.7 `sched:*` — standing reminders

Medication, check-ins, hydration. One shape, because they are one machine wearing three
sets of copy.

```ts
type Schedule = {
  id: string;
  uid: string;
  /** Which capability owns the payload and is handed the occurrence. */
  capability: string;
  /** Opaque to the scheduler: which medication, which question, which prompt. */
  payload: Record<string, unknown>;
  /** IANA zone. The USER'S, not the server's. */
  timezone: string;
  recurrence:
    | { kind: "once"; at: string }                                    // RFC 3339
    | { kind: "daily"; times: string[]; days?: number[] }             // "08:00", 0 = Sunday
    | { kind: "interval"; everyMinutes: number;
        window?: { from: string; to: string } };                      // defaults 08:00-22:00
  /** Paused without being forgotten. A holiday is not a deletion. */
  enabled: boolean;
  createdAt: string;
};
```

**The timezone is stored per schedule, not taken from the server.** A local 08:00 treated
as UTC fires at 02:30 in Kolkata. Waking someone in the night is not a rounding error —
it is what teaches them to unplug the device, and an unplugged device cannot raise an
alarm either.

**`capability` is a name, not a reference.** A schedule outlives the process that created
it. A build that no longer runs that capability has no handler for it, and the ticker says
so once rather than dispatching into nothing.

**Two indexes rather than a `SCAN`.** The ticker reads every schedule on every tick, and a
scan over a database shared with every session key would walk far more than it reads.
Nothing spans the value and the two sets transactionally, so both reads tolerate an index
entry with no schedule behind it and repair it in passing.

**No adherence record lives here.** Whether a dose was actually taken belongs to the
escalation state machine, and it is deliberately a separate contract. A schedule says what
should be said and when; it is not a record of what a person did.

---

## 3. `mem:writes` — Redis Stream

Written by the orchestrator at turn completion, fire-and-forget. Read by the memory worker.
**Never on the turn's critical path.**

```ts
type MemWriteEvent = {
  /** Stream entry id is assigned by Redis; this is our idempotency key. */
  event_id: string;          // ULID
  sid: string;
  uid: string;
  tid: number;
  at: string;                // RFC 3339
  kind: "turn_completed" | "session_closed" | "explicit_recall" | "correction";

  /** Present on turn_completed. */
  user_text?: string;
  agent_text?: string;
  language?: string;         // BCP-47

  /** Present on session_closed — lets the worker summarise without replaying. */
  turn_count?: number;
  duration_s?: number;

  /** Present on correction: the user contradicted a stored fact. */
  supersedes_fact_id?: string;

  /** Signals for distillation priority, not conclusions. */
  hints?: {
    named_entities?: string[];
    stated_preference?: boolean;
    emotional_salience?: "low" | "medium" | "high";
  };
};
```

**`event_id` is an idempotency key**, not decoration. Streams give at-least-once delivery;
a worker restart mid-batch would otherwise duplicate facts, and duplicated facts in a
companion read as the bot repeating itself.

**`kind: "correction"` is first-class.** When a user says "no, I told you I moved", that is
not a normal turn. It carries the supersede edge, and treating it as an ordinary
`turn_completed` is how a companion accumulates contradictions.

---

## 4. Long-term memory

Two stores, deliberately different shapes. Semantic answers *"what do I know about them"*;
longitudinal answers *"what happened, in order"*. One store cannot do both well.

### 4.1 Fact — semantic store (vector)

```ts
type Fact = {
  id: string;                // ULID
  uid: string;
  text: string;              // canonical, first person about the user
  embedding: number[];       // dimensionality per ADR 0004
  /** Coarse type. Drives retrieval weighting and redaction policy. */
  kind: "preference" | "biographical" | "relationship" | "commitment" | "aversion";
  salience: number;          // 0..1, decays without reinforcement
  confidence: number;        // 0..1, from the distiller
  first_seen: string;        // RFC 3339
  last_reinforced: string;   // RFC 3339

  /** Supersede chain — new facts do not delete old ones. */
  supersedes: string | null;
  superseded_by: string | null;
  /** Soft delete. Never hard-delete: the log must stay explicable. */
  deleted_at: string | null;
  deleted_reason: "superseded" | "user_requested" | "low_confidence" | null;

  /** Provenance, so any fact can be traced to the turn that produced it. */
  source_event_id: string;
  source_sid: string;
};
```

**Supersede rather than overwrite.** If a user says they live in Pune, then later in
Bengaluru, the old fact stays with `superseded_by` set. The agent must never assert the
stale one, but the history is why it can say "you mentioned you'd moved". Overwriting
destroys that.

**Soft delete always.** `user_requested` deletions must stop being retrieved immediately
but remain auditable — a companion that holds personal data needs a defensible deletion
story more than it needs reclaimed rows.

### 4.2 Episode — longitudinal store (append-only)

```ts
type Episode = {
  id: string;                // ULID
  uid: string;
  sid: string;
  started_at: string;        // RFC 3339
  ended_at: string;          // RFC 3339
  turn_count: number;
  languages: string[];       // BCP-47, every language observed in the session
  summary: string;           // 2–4 sentences, written by the worker
  topics: string[];
  /** Threads left open at the end — seeds the next session's greeting. */
  open_threads: { id: string; text: string }[];
  /** Facts this episode produced. Join key back to the semantic store. */
  fact_ids: string[];
  mood?: "positive" | "neutral" | "negative" | "mixed";
  /** Third-party analysis of this session, when one ran. See 4.3. */
  signals?: CareSignals;
};
```

**Append-only, never edited.** An episode is what happened. Facts derived from it may be
superseded; the episode itself is not revised. This is what makes "three weeks ago you
said…" answerable at all.

### 4.3 CareSignals — retrospective wellbeing read ([ADR 0009](adr/0009-audio-intelligence.md))

```ts
type CareSignals = {
  provider: "deepgram";
  analysed_at: string;        // RFC 3339
  /** Whole-transcript average. score is -1..1; label uses Deepgram's ±0.333 banding. */
  sentiment?: { label: "positive" | "neutral" | "negative"; score: number };
  /** Per-segment scores in spoken order — a shift within one session. */
  sentiment_segments?: number[];
  /** Reviewed watch-list intents that fired, strongest first. `text` is the matched span. */
  flagged_intents?: { intent: string; confidence: number; text: string }[];
};
```

Written by the **memory worker** at session close, from the user's turns only, via Deepgram's
`POST /v1/read`. Never written or read on the turn path — `recall_mood` reads episodes already
in the store.

**Optional at every level, and that is the contract.** The whole object is absent when the
session was not analysed — not English, under 50 words, feature off, or the provider was
unreachable. Each field is absent when the provider did not return it.

| Reader must not | Because |
|---|---|
| Treat a missing `sentiment` as neutral | "We did not look" and "they were fine" are different weeks |
| Treat `flagged_intents` as an alert | It is retrospective, English-only and hours late. Alarms are [`emergency-intent.ts`](../src/copy/emergency-intent.ts) |
| Read it as a measurement of the person | It scores the words in a transcript, not prosody and not health |
| Assume `sessions` covers the week | Only English sessions are analysed; a bilingual user's week is partly invisible |

---

## 5. Tool-call contract

```ts
type ToolCall = {
  call_id: string;           // ULID
  name: string;
  args: Record<string, unknown>;
  /** Hard deadline. Exceeded → error result, spoken fallback, pending cleared. */
  deadline_ms: number;
  /** Above this, speak a filler while waiting. Default 500. */
  filler_threshold_ms: number;
  /** Does a success mutate JSON context? If so, invalidate user:{uid}:ctx. */
  mutates_context: boolean;
  /** Entitlement required to offer this tool at all. */
  requires_entitlement?: string;
};

type ToolResult =
  | {
      call_id: string;
      ok: true;
      data: Record<string, unknown>;
      elapsed_ms: number;
      /** True → orchestrator invalidates user:{uid}:ctx before the next turn. */
      context_mutated: boolean;
    }
  | {
      call_id: string;
      ok: false;
      error: {
        code: "timeout" | "upstream_error" | "not_entitled" | "invalid_args" | "unavailable";
        message: string;           // for logs, never spoken verbatim
        /** What the agent should say instead. Written by us, per language. */
        spoken_fallback_key: string;
      };
      elapsed_ms: number;
    };
```

**`spoken_fallback_key`, not `spoken_fallback`.** The message must be resolvable in whatever
language the turn is in. An English error string reaching TTS would be spoken by a Hindi
voice — the exact seam risk flagged in
[00 §7.3](00-provider-research.md#73-voice-identity-across-a-language-switch-is-undocumented).

**`requires_entitlement` gates offering, not just execution.** A tool the user is not
entitled to should never be described to them. Checking only at execution produces an agent
that offers things and then withdraws them.

**Deadlines are per call, not global.** A slow tool must not consume the whole turn budget.
On breach: return the error result, speak the fallback, clear `sess:{sid}:pending`.

**A tool may span turns, and its state is not in Redis.** `start_game` / `answer_game` /
`end_game` ([ADR 0010](adr/0010-games-and-activities.md)) share a round that outlives the call
that created it. It lives on the session object, not under `sess:{sid}:*`, and so does not
survive a restart or a resume — deliberately: the round holds an answer key that must not be
readable outside the process, a score that is explicitly not a record of the person, and
nothing a later session is entitled to see. What survives is what the distiller writes about
the session as a whole, like any other conversation.

**A domain outcome is data, not an error.** `{repeated: false, reason: "nothing_said_yet"}` and
`{judged: false, reason: "no_game_running"}` are successes. `ok: false` costs a
`spoken_fallback_key`, and every key costs eleven translations — so modelling ordinary
conversational outcomes as errors would let the translation backlog decide how many tools this
product can carry.

---

## 6. Invalidation rules

Stated explicitly because implicit invalidation is where cache-backed agents go wrong.

| Trigger | Action |
|---|---|
| Tool returns `context_mutated: true` | `DEL user:{uid}:ctx`; refetch before next tool that reads it |
| Memory worker commits new facts | `DEL user:{uid}:profile`; rewarm at next session open |
| User requests deletion | Soft-delete facts; `DEL user:{uid}:profile`; do not touch episodes |
| Session ends or expires | `XADD mem:writes` with `kind: "session_closed"`; let `sess:*` expire naturally |
| Redis unavailable | Continue on JSON context only; set `degraded` on resume; **do not** silently drop `mem:writes` — buffer or accept the loss explicitly |

That last row is a real decision, not a note. If `mem:writes` is dropped during an outage,
the companion loses that stretch of conversation permanently. Whether to buffer locally or
accept the gap is unresolved — see [05-open-questions.md](05-open-questions.md).
