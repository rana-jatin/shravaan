# SP-I — multilingual companion voice agent

A companion bot on a dedicated device. It speaks 11 Indian languages, remembers
across days, and lets you switch language mid-conversation. It also reminds
somebody about their tablets, asks how they are once a day, keeps the readings
they recite out loud, and tells their family when nobody answers.

```
device ──ws──▶ server ──▶ ASR → LLM → TTS ──▶ streamed back to the device
                  │
                  └──▶ elderguard-backend (Python): telemetry, alerts, identity
```

TypeScript, Node ≥ 22.6, run directly with `--experimental-strip-types`.
**No build step** — no bundler, no `dist/`, `tsc` only checks. `elderguard-backend/`
and `pi/` are Python and have their own toolchains.

Design lives in [`docs/`](docs/) and is the spec; this code implements a slice
of it. Start with [docs/01-architecture.md](docs/01-architecture.md).
Adding a capability is [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Run

```bash
npm install
cp .env.example .env   # add SARVAM_API_KEY
npm run check          # format + lint + typecheck + test
npm run dev            # server on :8080
npm run device         # mic in, speaker out (needs ffmpeg)
```

| Command | What it does |
|---|---|
| `npm run check` | Everything CI runs — run this before every commit. |
| `npm test` | 1038 tests, 3 skipped (Redis). No credentials, no network. |
| `npm run typecheck` | `tsc --noEmit`, strict. |
| `npm run lint` | eslint, tuned for defects, not style. |
| `npm run format` | prettier (Markdown excluded, see `.prettierignore`). |

Any script also runs against one package: `npm run <script> -w ai`, `-w backend`,
`-w shared`, `-w frontend`.

`npm run verify:*` scripts (tools, asr, care, alert) call live providers with
real keys and are deliberately outside `check`.

**Redis is optional.** Without `REDIS_URL`, working memory runs in-process —
fine for development, gone on restart. Reminders and unanswered escalations are
in-process too, which for those means a restart forgets a dose nobody has
confirmed; the server says so at boot, at ERROR rather than WARN.

```bash
docker run -d -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm test
```

The safety service is a separate Python process, and nothing in the Node side
requires it — leave `VITALS_API_BASE` unset and the vitals tools are simply not
registered.

```bash
cd elderguard-backend
pip install -r requirements-dev.txt
pytest                 # 142 tests, in-memory SQLite and a fake Redis
uvicorn app.main:app   # needs Postgres and Redis; see its README
```

---

## Status

**Built:** Slices 1–4, 6, 7, and 8 (see [docs/04-milestones.md](docs/04-milestones.md)
for the full plan) — device transport, Sarvam ASR/LLM/TTS, barge-in, the
three-gate speakability check, the echo guard, working + long-term memory,
function calling with 8 built-in tools, degradation handling, and opt-in
Deepgram ASR standby and care-signal analysis.

**Not yet:** device-side echo cancellation (needs hardware), a wake word, a
durable memory backend, a real multilingual embedder, and native review of
9 of 11 languages' spoken copy.

**The elder-care half.** Five capabilities, each off until a deployment
configures it, and all four of them that act between turns run on the same two
loops — one scheduler, one escalation sweep:

| Capability | What it does | Turned on by |
|---|---|---|
| Medication | Reminds, nudges, and tells the family when a dose goes unconfirmed. | `MEDICATION_ENABLED` |
| Daily check-in | Asks once a day. Any reply at all settles it. | `CHECKIN_ENABLED` |
| Vitals | Keeps readings the person recites; picks up alerts the safety service raised from the band. | `VITALS_API_BASE` + `VITALS_API_KEY` |
| Emergency | `raise_alarm`, plus a local phrase matcher that runs before the model. | `EMERGENCY_CONTACTS` |
| Calendar, weather, news, music | Read-only helpers. | their own feeds and keys |

**Everything that reacts to a person's health does the same three things, in
this order: ask them, wait, then tell somebody.** Nothing in this product tells
an elderly person that a reading looked wrong — the numbers go to the family,
who can act on them, and the person is asked how they are in copy a human
reviewed. That line is the reason for most of the design in
`ai/src/capabilities/`, and [CONTRIBUTING.md](CONTRIBUTING.md) states it as a
rule rather than leaving it to be re-derived.

---

## Language set

**11 languages. This is the whole product.**

Hindi `hi-IN` · Bengali `bn-IN` · Tamil `ta-IN` · Telugu `te-IN` · Gujarati `gu-IN` ·
Kannada `kn-IN` · Malayalam `ml-IN` · Marathi `mr-IN` · Punjabi `pa-IN` ·
Odia `or-IN` · English `en-IN` — Hinglish and code-mixing included.

The ceiling is the TTS voice's, not the ASR's: Sarvam transcribes 22 Indian
languages but speaks only 10. Twelve heard-but-unspeakable languages (Urdu,
Assamese, Nepali, and others) are refused at session open rather than
answered in the wrong voice. See
[the speakability gate](docs/06-speakability-gate.md) and
[ADR 0005](docs/adr/0005-tts-provider-split.md).

---

## Layout

An npm workspaces monorepo. `shared → ai → backend` points one way and never
back; `frontend`, `pi` and `elderguard-backend` talk to `backend` over a
protocol, never by importing it.

```
shared/     config loading, cross-cutting types, the http contract, backoff
ai/         the turn loop and everything it reaches
  capabilities/  one file per feature — the list is catalogue.ts
  orchestrator/  session.ts, the turn loop; the session registry
  domain/        pure logic: gates, turn state, scheduling, vitals, the cache
  providers/     Sarvam ASR/LLM/TTS, Deepgram, mail, the safety service client
  scheduler/     schedule store + the ticker that fires a due reminder
  escalation/    the ladder, and the sweep that climbs it
  tools/         the model's function-calling surface
  copy/          spoken copy, 11 languages
  memory/        mem:writes consumer, distiller, care-signal analyser
backend/    server.ts (protocol, boot, lifecycle) + composition/ (the DI root)
frontend/   React + Vite dashboard starter
pi/         Python — the device: mic, speaker, sensors
elderguard-backend/  Python — telemetry, anomaly bands, alerts, identity
```

Every provider takes an injectable `HttpFetch`; `Session` takes ASR/LLM/TTS
factories as arguments; a capability is handed its stores and its clock. That's
why the test suite needs no credentials and never opens a real socket.

**Three loops, and only three.** The ticker fires a schedule that came due; the
sweep walks an unanswered reminder up its ladder; the vitals watcher polls the
safety service for alerts raised somewhere this process cannot see. All three
are inert until a capability gives them work, so a default build starts none of
them.

---

## Known gaps

Open defects are tracked in [docs/07-defect-register.md](docs/07-defect-register.md).
The list below is what hasn't been *built* yet:

- **9 of 11 languages have placeholder spoken copy.** Only `en-IN`/`hi-IN` are
  reviewed. The server warns at boot; see `src/copy/refusals.ts`.
- **No device-side echo cancellation.** The server-side echo guard is a second
  line of defence, not a replacement — see [ADR 0007](docs/adr/0007-audio-front-end.md).
  `HALF_DUPLEX=true` mutes barge-in entirely as a last resort.
- **Long-term memory isn't durable.** In-process only; lost on restart.
  [ADR 0004](docs/adr/0004-vector-store.md) (Postgres + pgvector) is still
  *Proposed*.
- **The embedder is a placeholder.** `HashingEmbedder` matches lexically and
  can't bridge scripts — a real multilingual embedder is needed before
  cross-language recall is trustworthy.
- **Tool selection quality and end-to-end latency are unmeasured** — see
  [docs/03-latency-budget.md](docs/03-latency-budget.md).
- **Degradation logic is only tested against simulated failures**, not a real
  outage.
- **Nobody can set up a reminder except the person themselves.** Medication and
  the daily check-in are configured out loud, through the model, which is
  backwards for a feature whose point is the family's peace of mind. The
  caregiver dashboard is where it belongs and does not exist.
- **The companion's `uid` is assumed to be the safety service's user id.** It
  arrives on a device `hello` frame and nothing guarantees it names a row over
  there; an unknown one degrades to "I cannot keep that". Pairing should
  establish the mapping.
- **A hardware SOS reaches the family but not the person.** The safety service
  emails immediately; the device standing next to them says nothing, because
  that alert belongs in the emergency capability's reviewed acknowledgement
  rather than in the vitals ladder.

The full list, with the reasoning for each, is in
[docs/08-follow-ups.md](docs/08-follow-ups.md).

---

## Where the reasoning lives

| Document | What it settles |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | Start here. |
| [docs/02-data-contracts.md](docs/02-data-contracts.md) | Redis keys, `mem:writes`, the turn window. |
| [docs/03-latency-budget.md](docs/03-latency-budget.md) | What the providers publish, and what they don't. |
| [docs/06-speakability-gate.md](docs/06-speakability-gate.md) | Heard vs. speakable, and the three gates. |
| [docs/07-defect-register.md](docs/07-defect-register.md) | Known defects, with the mechanism for each. |
| [docs/08-follow-ups.md](docs/08-follow-ups.md) | What was deliberately not done, and why. |
| [docs/adr/](docs/adr/) | Ten architecture decisions, including ones still Proposed. |

[CONTRIBUTING.md](CONTRIBUTING.md) is how to add a capability without editing
anybody else's code. `CLAUDE.md` has the conventions and gotchas for anyone
changing this repo.
