# SP-I — multilingual companion voice agent

A companion bot on a dedicated device. It speaks 11 Indian languages, remembers
across days, and lets you switch language mid-conversation.

```
device ──ws──▶ server ──▶ ASR → LLM → TTS ──▶ streamed back to the device
```

TypeScript, Node ≥ 22.6, run directly with `--experimental-strip-types`.
**No build step** — no bundler, no `dist/`, `tsc` only checks.

Design lives in [`docs/`](docs/) and is the spec; this code implements a slice
of it. Start with [docs/01-architecture.md](docs/01-architecture.md).

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
| `npm test` | 631 tests, 630 pass, 1 skipped. No credentials, no network. |
| `npm run typecheck` | `tsc --noEmit`, strict. |
| `npm run lint` | eslint, tuned for defects, not style. |
| `npm run format` | prettier (Markdown excluded, see `.prettierignore`). |

`npm run verify:*` scripts (tools, asr, care, alert) call live providers with
real keys and are deliberately outside `check`.

**Redis is optional.** Without `REDIS_URL`, working memory runs in-process —
fine for development, gone on restart. The Redis contract suite exists but has
never been run against a real instance:

```bash
docker run -d -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm test
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

```
src/
  server.ts        device-facing WebSocket server: protocol, boot, lifecycle
  composition/     the only place that picks concrete providers/tools
  domain/          pure logic, no I/O — gates, turn state, degradation, etc.
  providers/       raw WebSocket clients: Sarvam ASR/LLM/TTS, Deepgram
  memory/          mem:writes consumer, distiller, care-signal analyser
  orchestrator/    session.ts — the turn loop: gates, barge-in, tool rounds
  tools/           the model's function-calling surface, built-in + external
  copy/            refusal and closing copy, 11 languages
scripts/           device client, holding-audio render, live-provider probes
```

Every provider takes an injectable `HttpFetch`; `Session` takes ASR/LLM/TTS
factories as arguments. That's why the test suite needs no credentials and
never opens a real socket.

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

---

## Where the reasoning lives

| Document | What it settles |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | Start here. |
| [docs/02-data-contracts.md](docs/02-data-contracts.md) | Redis keys, `mem:writes`, the turn window. |
| [docs/03-latency-budget.md](docs/03-latency-budget.md) | What the providers publish, and what they don't. |
| [docs/06-speakability-gate.md](docs/06-speakability-gate.md) | Heard vs. speakable, and the three gates. |
| [docs/07-defect-register.md](docs/07-defect-register.md) | Known defects, with the mechanism for each. |
| [docs/adr/](docs/adr/) | Nine architecture decisions, including ones still Proposed. |

`CLAUDE.md` has the conventions and gotchas for anyone changing this code.
