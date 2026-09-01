# CLAUDE.md

Orientation for anyone — human or agent — changing this repo.

`README.md` is the product tour. `docs/` is the spec and outranks both: where
this file and `docs/` disagree, `docs/` is right and this file is stale.

---

## What this is

A multilingual companion voice agent. A person talks to a dedicated device; the
device streams PCM to this server over a WebSocket; the server runs
ASR → LLM → TTS and streams audio back. It speaks 11 Indian languages, remembers
across days, and lets you switch language mid-conversation.

TypeScript on Node ≥ 22.6, run directly with `--experimental-strip-types`.
**There is no build step.** No bundler, no `dist/`, no transpile. `tsc` is a
checker, not a compiler (`noEmit`).

---

## Commands

```bash
npm run check      # format:check + lint + typecheck + test — what CI runs
npm test           # 616 tests, no credentials, no network
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (--fix to apply)
npm run format     # prettier (format:check to verify)
npm run dev        # the server, on :8080
npm run device     # the device client: mic in, speaker out (needs ffmpeg)
```

`npm run verify:*` scripts talk to live providers and need real keys. They are
deliberately outside `check`.

**Run `npm run check` before every commit.** Not `npm test` alone: the lint and
format gates catch a different class of problem, and a commit that skips them
tends to be followed by a commit that fixes them.

---

## Architecture

```
device ──ws──▶ server.ts ──▶ Session (the turn loop)
                 │              │
                 │              ├─▶ providers/  Sarvam ASR/LLM/TTS, Deepgram
                 │              ├─▶ tools/      function calling
                 │              ├─▶ store/      working memory (Redis or in-proc)
                 │              └─▶ mem:writes ──▶ memory/worker.ts ──▶ long-term
                 └─▶ composition/  builds all of the above at boot
```

**The layering, and it points one way.**

| Layer | Rule |
|---|---|
| `domain/` | Pure. No I/O, no clients, no config reads. Fully unit-tested. |
| `providers/`, `store/` | Everything that leaves the process, behind an interface. |
| `tools/` | The model's function-calling surface. |
| `orchestrator/` | The turn loop. Depends on interfaces, never on concrete providers. |
| `composition/` | The only place that picks implementations. |
| `server.ts` | Protocol, boot order, socket lifecycle. |

`domain/` importing from `providers/` is a smell. There is currently one
instance — `domain/radio-catalogue.ts` does network I/O and should move to
`providers/`.

**No import cycles.** There were three (type-only, in `tools/`) and they are
gone. Keep it that way; a cycle usually means a type is defined next to one of
its producers instead of next to its consumer.

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
of `src/tools/builtin.ts` before adding a tool.

**Unconfigured means unregistered means never described to the user.** An agent
that offers the weather and then cannot fetch it is worse than one that never
mentioned it. External tools are factories, registered only where a deployment
configured them. See `src/tools/external.ts`.

**Config is nested by concern** — `cfg.weather.apiBase`, `cfg.mail.smtp.host`.
Validate at boot and fail there, not on the first session. `.env.example` is
kept in sync with `env.ts` by hand; if you add a variable, document it there.

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
  `RedisMemWriteStream` implements the `docs/02` §3 spec and `server.ts` never
  selects it, so the stream is in-process even with `REDIS_URL` set. Tested, and
  documented at both ends. Wiring it is a one-line change and a behaviour change.
- **`session.ts` is ~1600 lines on purpose.** The turn loop, barge-in, tool
  rounds and the degradation ladder are one machine. Pieces with a real seam
  were extracted; `#openAsr` touches fourteen pieces of private state and was
  deliberately left alone.
- **Never cast to `Config`; use `testConfig()`.** Two fixtures once built one
  with `as unknown as Config`, and the nested-config migration typechecked clean
  while thirteen tests failed for exactly that reason. Both now go through
  `testConfig()`, and eslint rejects the cast — so a config rename fails the
  build at the fixture instead of at runtime.
- **`LOG_LEVEL` does nothing.** It is documented in `.env.example` and marked
  NOT IMPLEMENTED. `log()` writes every line it is given.
- **`DEVICE_FRAME_MS` and `MUSIC_DUCK_VOLUME` are read by the device client**,
  not the server.
- **The Redis store contract suite has never been executed.** It is written and
  skipped unless `REDIS_URL` is set. Run it before trusting that path.
- **Nine of eleven languages have placeholder spoken copy.** The server warns at
  boot. It is not shippable to users until a native speaker reviews it.
- **`SYSTEM_PROMPT`'s tuning was measured on a model we no longer run.** The
  numbers in its comment are for `sarvam-105b`; we run
  `sarvam-105b-conversations`. Re-tuning is open work.

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
| `docs/adr/` | Nine decisions, including the ones still Proposed. |
