# 08 — Follow-ups

What was deliberately not done, and why. Separate from
[07-defect-register.md](07-defect-register.md): those are things that are
wrong, these are things that are absent. Nothing here is a surprise waiting to
be found — each entry was a decision, and the reason for it is the useful half.

Ordered by how much it would cost somebody to discover it the hard way.

---

## 1. Product decisions nobody has made

### Who sets up a reminder

Medication and the daily check-in are configured **by the person themselves,
out loud, through the model**. That is backwards for a feature whose entire
point is the family's peace of mind, and it is the largest open question in the
elder-care half.

The caregiver dashboard is where it belongs. `frontend/` is a wiring-proof
starter that shows connection status and makes no product decision. Until it
exists, a caregiver sets a reminder up on the device, out loud, standing next
to the person it is about — which at least means nobody is being watched
without knowing it.

### `EMERGENCY_CONTACTS` is doing three jobs

Medication, the daily check-in and vitals all escalate to the same list as
`raise_alarm`. Reusing it is the conservative reading — in elder care they are
almost always the same people — but the questions are not identical. "Who do I
call if they fall" is not "who wants to know they skipped a tablet", and a
deployment needing them apart needs a second list rather than a workaround.

The boot log says which list a capability is using. That is the whole of the
mitigation.

### A hardware SOS reaches the family but not the person

`elderguard-backend` emails the moment the button is pressed. The companion's
alert watcher skips SOS alerts on purpose: the emergency capability owns what
the device says about an alarm, in copy written for exactly that moment, and
two systems narrating one event to a frightened person is worse than one of
them staying quiet.

The gap is real and named in `ai/src/vitals/alert-watcher.ts`. Closing it means
routing that alert into the emergency capability's acknowledgement rather than
into the vitals ladder.

---

## 2. The seam between the two services

### `uid` is assumed to be the safety service's user id

The companion learns a `uid` from a device `hello` frame. The safety service
keys everything on its own `users.id`. Nothing guarantees they are the same
value; the seam simply assumes it, a mismatch is a 404, and the companion
degrades to "I cannot keep that reading".

The fix is for **pairing** to establish the mapping — which is the same piece
of work as the caregiver dashboard, since pairing is a thing a caregiver does.
Documented at `get_elder` in `elderguard-backend/app/api/deps.py`.

### There is no per-user timezone anywhere

`GET /companion/context/{uid}` can return one and the safety service has
nowhere to get it from, so every schedule falls back to `DEFAULT_TIMEZONE`. For
a single-household deployment that is correct. For anything wider it means a
reminder set for "eight o'clock" fires on the server's idea of eight.

A `timezone` column on `users` and one line in the context endpoint.

### The companion's HTTP client does not retry

`shared/providers/http.ts` retries idempotent GETs; `ElderguardClient` has its
own `#send` and does not, because it needs to read 404 and 409 as data before
anything decides whether to retry. In practice a failed alert poll is retried
thirty seconds later by the watcher, and `record` is a POST that must not
repeat — so the gap costs one turn's reading, once.

### A Redis blip turns telemetry ingest into a 500

`enforce_rate_limit` raises when Redis is unreachable, and the telemetry routes
call it before storing anything. Found while running the two services against
each other: the safety service returned "Internal server error" for a perfectly
good reading because a Redis container had gone away. A rate limiter that
cannot reach its store should fail open, or at least fail with a status the
caller can act on.

---

## 3. Infrastructure that is written and not wired

### `RedisMemWriteStream` implements the spec and nothing selects it

It satisfies `docs/02` §3 and `backend/server.ts` never chooses it, so the
`mem:writes` stream is in-process even with `REDIS_URL` set. Tested, documented
at both ends, and a one-line change — but a behaviour change, not a cleanup.

### MQTT has no authentication and no per-device ACLs

`mosquitto.conf` runs open. `MQTT_USERNAME`/`MQTT_PASSWORD` are read if set and
there is no ACL layer, so any client that can reach the broker can publish
telemetry or an SOS for any device id. The topic-to-device check in
`parse_message` rejects a payload that disagrees with its topic, which stops
confusion and not spoofing.

### The Postgres write-concurrency path is untested

The suite runs on in-memory SQLite, which serialises writes. Nothing exercises
two transactions racing for the same device row — `pair_device` uses
`with_for_update()` precisely because that race exists, and the lock is
therefore unverified.

### paho's Callback API v1 is deprecated

Every MQTT test emits the warning. Moving to v2 changes the `on_message`
signature and is mechanical; it is deferred because the consumer was rewritten
recently and two changes to the same file in one week is how a regression hides.

### `disconnect()` does not drain in-flight writes

`TelemetryMQTTConsumer.disconnect` stops the loop and drops `self._loop`.
Futures already in flight complete or not depending on timing. A bounded drain
would be a dozen lines; the failure it prevents is losing telemetry recorded in
the last moment before a shutdown, which is the least valuable telemetry there
is.

---

## 4. Things that will bite at scale, not at one device

### The caches are per process

`TtlCache` is in-memory, so two servers keep two copies and a restart
re-fetches. Correct for data this cheap and this public. A shared cache would
mean Redis on the read path for a weather lookup, which is a worse trade than
the duplicate request it saves.

### ioredis logs unhandled error events when Redis is down

Setting `REDIS_URL` with nothing listening produces repeated "Unhandled error
event" stacks. Pre-existing, and now with more clients attached than before:
sessions, schedules, escalations and memory each hold one. The clients all use
`lazyConnect` and recover on their own; the noise is the whole of the problem.

### The Redis contract suites are skipped unless `REDIS_URL` is set

Three suites — session store, schedules, escalations. They have now been run
against a real instance (all green), but CI does not, so they will drift
silently unless somebody runs them before trusting that path.

---

## 5. Copy and language

### Nine of eleven languages are placeholder text

Hindi and English are reviewed; the rest are machine-drafted and the server
warns at boot with the exact list. This covers every catalogue, including the
four new lines the vitals ladder speaks and the medication and check-in copy.
**It is not shippable to users until a native speaker reviews it**, and the
stop-the-music phrases are the loudest case, because a bad translation there
means the music does not stop.

### The copy tables are TypeScript, not JSON

A translator cannot open them. Extracting them would help, and the reason it
has not happened is that the tables carry the reasoning that makes them correct
— which languages inflect for the speaker's gender, why a stop phrase must not
be paraphrased, what was measured — and JSON cannot hold a comment. Doing it
properly means deciding where the reasoning goes first.

### `SYSTEM_PROMPT` is tuned to a model we no longer run

Every measurement in its comment is from `sarvam-105b`. On
`sarvam-105b-conversations` the preamble rate fell from ~78% to 22%, measured
twice. It matters less than it sounds — the silence it covers collapsed from
~12.8 s to ~1.05 s — but the prompt is tuned to the wrong model and re-tuning
it is open work.

---

## 6. Measurement

### Tool selection quality and end-to-end latency are unmeasured

The zero-configuration tool list has grown, and a configured deployment now
offers more still. This is the first thing to measure rather than a background
concern — see [03-latency-budget.md](03-latency-budget.md).

### Degradation is tested against simulated failures only

Every provider outage in the suite is a fake throwing on cue. No real outage
has been observed end to end.

### `LOG_LEVEL` does nothing

Documented in `.env.example` and marked NOT IMPLEMENTED. `log()` writes every
line it is given.
