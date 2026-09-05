# CLAUDE.md

Orientation for anyone — human or agent — changing this repo.

`README.md` is the product tour. `docs/` is the spec and outranks both: where
this file and `docs/` disagree, `docs/` is right and this file is stale.

---

## What this is

A multilingual companion voice agent, plus the physical device and dashboard
around it. A person talks to a dedicated device (a Raspberry Pi, `pi/`); it
streams PCM to the `backend` server over a WebSocket; `backend` calls into the
`ai` package, which runs ASR → LLM → TTS and streams audio back. It speaks 11
Indian languages, remembers across days, and lets you switch language
mid-conversation. `frontend/` is a companion control dashboard, still a
wiring-proof starter.

It also reminds somebody about their tablets, asks how they are once a day,
keeps the readings they say out loud, and tells their family when nobody
answers. That half leans on `elderguard-backend/`, a Python service that
already ingests telemetry from a wearable band and checks it against anomaly
bands — the companion talks to it rather than keeping a second copy of anyone's
health record.

An npm workspaces monorepo: `shared`, `ai`, `backend`, `frontend` are npm
packages (`package.json` each); `pi/` and `elderguard-backend/` are separate
Python packages (their own `pyproject.toml`), not npm workspace members. See
**Repo layout** below.

TypeScript on Node ≥ 22.6, run directly with `--experimental-strip-types`.
**There is no build step in `shared`/`ai`/`backend`.** No bundler, no `dist/`,
no transpile. `tsc` is a checker, not a compiler (`noEmit`). `frontend/` is a
normal Vite app and does bundle for production — that constraint is about the
Node packages, not the browser one.

---

## Repo layout

```
shared/    config loading, cross-cutting types, the http fetch contract,
           retry-with-backoff (three packages reach it)
ai/        the turn-loop pipeline — orchestrator, ASR/LLM/TTS providers,
           tools, capabilities, memory, session store, the scheduler and the
           escalation ladder. Nearly every test lives here.
backend/   server.ts (protocol/socket lifecycle) + composition/ (the DI root)
frontend/  React + Vite + TS dashboard starter
pi/        Python — the real device: mic in/speaker out, onboard sensors
elderguard-backend/
           Python — telemetry from the band, the anomaly bands, alerts, and
           the identity the companion reads at the top of a session. NOT an
           npm workspace; its own pyproject and its own pytest suite.
```

`ai/` reaches `elderguard-backend` over HTTP and that service never calls back.
One direction, no inbound auth on a WebSocket server, and an unreachable
service degrades to "I cannot keep that reading" rather than half a state
machine. See `ai/src/providers/elderguard.ts` and that package's README.

`shared → ai → backend` is one-way: `ai` never imports from `backend`, and
`shared` never imports from either. Cross-package imports are bare specifiers
(`@sp-i/shared/config/env.ts`, `@sp-i/ai/orchestrator/session.ts`) resolved
through each package's `package.json#exports` — a wildcard mapping straight to
`.ts` sources, not a build. `frontend` and `pi` talk to `backend` only over
the device WebSocket protocol documented at the top of
`ai/scripts/device-client.ts`; neither imports Node-side code.

Almost everything that isn't `server.ts`/`composition/` lives in `ai/` —
including `store/` (session working memory), because `orchestrator/session.ts`
depends on it directly. That's not a compromise; it's what the import graph
actually looks like. `docs/01-architecture.md` predates the package split and
stays product-level, not file-level — this file is the only place the split
itself is documented, for now.

---

## Commands

```bash
npm run check      # format:check + lint + typecheck + test — what CI runs
npm test           # runs test --workspaces (ai + backend); no credentials, no network
npm run typecheck  # tsc --noEmit, per workspace package
npm run lint       # eslint (--fix to apply) — one root config, all Node packages
npm run format     # prettier (format:check to verify)
npm run dev        # the backend server, on :8080 (npm run dev -w backend)
npm run device     # the laptop device client: mic in, speaker out (npm run device -w ai, needs ffmpeg)
npm run frontend   # the dashboard dev server (npm run dev -w frontend)
```

Any script also runs directly against one package: `npm run <script> -w ai`,
`-w backend`, `-w shared`, `-w frontend`. `pi/` is not npm — see `pi/README.md`.

`npm run verify:*` scripts (now `-w ai`) talk to live providers and need real
keys. They are deliberately outside `check`.

**Run `npm run check` before every commit.** Not `npm test` alone: the lint and
format gates catch a different class of problem, and a commit that skips them
tends to be followed by a commit that fixes them.

---

## Architecture

```
pi/ ──ws──▶ backend/server.ts ──▶ ai/orchestrator Session (the turn loop)
                 │                     │
                 │                     ├─▶ ai/providers  Sarvam ASR/LLM/TTS, Deepgram
                 │                     ├─▶ ai/tools      function calling
                 │                     ├─▶ ai/store      working memory (Redis or in-proc)
                 │                     └─▶ mem:writes ──▶ ai/memory/worker.ts ──▶ long-term
                 │
                 ├─▶ ai/scheduler   ticker: a schedule came due
                 ├─▶ ai/escalation  sweep: nobody answered, climb the ladder
                 ├─▶ ai/vitals      watcher: an alert was raised over there
                 │                            │
                 │                            ▼
                 │                   elderguard-backend (HTTP, one direction)
                 │
                 └─▶ backend/composition/  builds all of the above at boot,
                                            from ai/ + shared/config

The three loops reach a live conversation through `SessionRegistry`, which
hands back one verb: say this prepared sentence. A capability holding it cannot
run a turn, reach the model, or read a transcript.
```

**The layering, and it points one way.**

| Layer | Package | Rule |
|---|---|---|
| `domain/` | `shared/` (cross-cutting) or `ai/` (turn-loop-specific) | Pure. No I/O, no clients, no config reads. Fully unit-tested. |
| `providers/`, `store/` | `ai/` | Everything that leaves the process, behind an interface. |
| `tools/` | `ai/` | The model's function-calling surface. |
| `orchestrator/` | `ai/` | The turn loop. Depends on interfaces, never on concrete providers. |
| `composition/` | `backend/` | The only place that picks implementations. |
| `server.ts` | `backend/` | Protocol, boot order, socket lifecycle. |

`domain/` importing from `providers/` is a smell. `domain/radio-catalogue.ts`
was the one instance — it did network I/O from inside `domain/` — and now lives
at `ai/src/providers/radio-catalogue.ts`. This paragraph claimed that move for a
while before it happened, which is its own lesson: a rule the docs assert and
the tree does not follow is worse than a rule nobody wrote down. If you find
another, move it the same way.

**No import cycles.** There were three (type-only, in `tools/`) and they are
gone. Keep it that way; a cycle usually means a type is defined next to one of
its producers instead of next to its consumer. The package boundaries add a
second way to get this wrong: `ai/` reaching into `backend/` (even by mistake,
via a relative path escaping the package) would create a cycle with
`backend → ai`. There is no lint rule enforcing this yet — it's a discipline,
not a guarantee.

---

## The conventions that are load-bearing

**Every I/O boundary is injectable, and this is why the test suite needs no
credentials.** Providers take an `HttpFetch`; `Session` takes `makeAsr` /
`makeTts` / `makeLlm` factories. A test hands in a fake and never opens a
socket. If you add something that talks to the network, it takes its client as a
dependency — otherwise you have made a piece of the system untestable, and
`docs/07-defect-register.md` §9 records what that cost last time.

**A domain outcome is data; only infrastructure throws.** A tool returning
`{repeated: false, reason: "nothing_said_yet"}` succeeds. `ok: false` costs a
`spoken_fallback_key`, and every key costs eleven translations — so modelling
"there is nothing to repeat" as an error would let the translation backlog, not
the engineering, decide how many tools this product can carry. Read the header
of `ai/src/tools/builtin.ts` before adding a tool.

**Unconfigured means unregistered means never described to the user.** An agent
that offers the weather and then cannot fetch it is worse than one that never
mentioned it. External tools are factories, registered only where a deployment
configured them. See `ai/src/tools/external.ts`.

**Config is nested by concern** — `cfg.weather.apiBase`, `cfg.mail.smtp.host`.
Validate at boot and fail there, not on the first session. `.env.example` (at
repo root, covering every package) is kept in sync with `shared/src/config/env.ts`
by hand; if you add a variable, document it there.

**Residency is a decision, not a default.** Every hop is Sarvam, in India, on
purpose. Anything that relocates a user's voice or words out of the country —
the Deepgram ASR standby, care signals, Open-Meteo — is opt-in and says so at
boot. Do not flip one of those defaults without reading
`docs/05-open-questions.md` Q14.

**Comments explain why, not what.** This codebase's comments carry measurements,
rejected alternatives and the reasoning behind a constant. When you move code,
move its comment with it. When a comment says something was measured, do not
paraphrase the numbers away.

---

## Things that will surprise you

- **`mem:writes` has a Redis implementation that is not wired.**
  `RedisMemWriteStream` implements the `docs/02` §3 spec and `backend/server.ts`
  never selects it, so the stream is in-process even with `REDIS_URL` set.
  Tested, and documented at both ends. Wiring it is a one-line change and a
  behaviour change.
- **`ai/src/orchestrator/session.ts` is ~1600 lines on purpose.** The turn loop,
  barge-in, tool rounds and the degradation ladder are one machine. Pieces with
  a real seam were extracted; `#openAsr` touches fourteen pieces of private
  state and was deliberately left alone.
- **Never cast to `Config`; use `testConfig()`.** Two fixtures once built one
  with `as unknown as Config`, and the nested-config migration typechecked clean
  while thirteen tests failed for exactly that reason. Both now go through
  `testConfig()` (`ai/test/helpers.ts`), and eslint rejects the cast — so a
  config rename fails the build at the fixture instead of at runtime.
- **`LOG_LEVEL` does nothing.** It is documented in `.env.example` and marked
  NOT IMPLEMENTED. `log()` writes every line it is given.
- **`DEVICE_FRAME_MS` and `MUSIC_DUCK_VOLUME` are read by the device clients**
  (`ai/scripts/device-client.ts` and `pi/pi_client/main.py`), not the server.
- **`HOLDING_AUDIO_DIR` defaults to `../ai/assets/holding`**, relative to
  `backend/`'s cwd — where `npm run dev` launches the server from. Overriding
  it for some other launch method means recomputing that relative path from
  wherever the process actually starts.
- **The three Redis contract suites are skipped unless `REDIS_URL` is set.**
  Session store, schedules and escalations. They HAVE now been run against a
  real instance and were green, so the line that used to sit here — that they
  had never been executed — is no longer true. CI still does not run them, so
  they will drift silently unless somebody runs them before trusting the path.
- **Three loops, and only three.** The ticker fires a due schedule
  (`ai/src/scheduler/`), the sweep walks an unanswered reminder up its ladder
  (`ai/src/escalation/`), and the vitals watcher polls the safety service for
  alerts raised where this process cannot see them (`ai/src/vitals/`). All
  three are inert until a capability hands them work, so a default build starts
  none of them. A fourth loop should be a conversation, not a commit.
- **`onOccurrence` never speaks.** The sweep owns every utterance the device
  makes without being asked, so exactly one code path says a reminder out loud
  and exactly one decides whether it landed. A capability that spoke at
  schedule time would make the first attempt follow different rules from the
  retry.
- **Nothing tells anybody their reading looked wrong.** Vitals results carry a
  number, a unit and a time, and there is a test asserting they carry nothing
  else — a tool result is handed to a language model and spoken aloud in the
  same turn, so a field named `severity` is medical advice with extra steps.
  The numbers go to the family, who can act on them; the person is asked how
  they are, in reviewed copy. See `ai/src/capabilities/vitals.ts`.
- **The anomaly bands live in the Python service and nowhere else.** One place
  judges a vital sign. `ai/src/domain/vitals.ts` mirrors that service's INGEST
  limits so a value that would bounce off the API is refused locally with a
  reason the device can say — those are "no person has this" bounds, not
  thresholds, and confusing the two would put a second opinion in the companion.
- **`shared/src/providers/http.ts` retries GETs and never anything else.** The
  method is the gate rather than the caller's diligence: retrying the POST that
  stores somebody's blood pressure is a second row in their health record.
  `retry: true` on a POST is ignored, and there is a test on that.
- **Nine of eleven languages have placeholder spoken copy.** The server warns at
  boot. It is not shippable to users until a native speaker reviews it.
- **`SYSTEM_PROMPT`'s tuning was measured on a model we no longer run.** The
  numbers in its comment are for `sarvam-105b`; we run
  `sarvam-105b-conversations`. Re-tuning is open work.
- **A game round lives on the session object and nowhere else.** `start_game`
  is the first tool that spans turns, and its state is deliberately not in
  Redis: the round holds an answer key that must not leave the process and a
  score that is explicitly not a record of the person. So "what did I score
  yesterday" has no answer, by design. See `docs/adr/0010-games-and-activities.md`.
- **Game results must never reach care signals.** A digit span looks enough
  like a cognitive screening item that the line has to be written down. Nobody
  consented to a test; it is a pastime.
- **`frontend/` and `pi/` are wiring-proof starters, not products.** The
  frontend shows connection status against the device protocol; `pi_client`
  does the mic/speaker/sensor plumbing with mock fallbacks off-device. Neither
  makes a product decision (what the dashboard shows, which sensors ship) —
  those are still open.

---

## Working on this repo

- Small, verifiable steps. Run `npm run check` after each one.
- Prefer moves over delete-and-recreate so history survives.
- Don't change external behaviour as a side effect of a refactor. If a change
  alters what a user hears or an operator sees, say so explicitly.
- For anything touching boot wiring, the strongest available check is to boot
  the server against a synthetic `.env` before and after and diff the log. It
  catches what the test suite does not.
- New provider or tool? Give it an injectable client, register it only where
  configured, and add its variables to `.env.example`.

---

## Where the reasoning lives

| Document | What it settles |
|---|---|
| `docs/01-architecture.md` | Start here. |
| `docs/02-data-contracts.md` | Redis keys, `mem:writes`, the turn window. |
| `docs/03-latency-budget.md` | What the providers publish, and what they don't. |
| `docs/06-speakability-gate.md` | Heard vs speakable, and the three gates. |
| `docs/07-defect-register.md` | Known defects, with the mechanism for each. |
| `docs/08-follow-ups.md` | What was deliberately not done, and why. |
| `CONTRIBUTING.md` | Adding a capability, and the rules that go with it. |
| `docs/adr/` | Ten decisions, including the ones still Proposed. |
