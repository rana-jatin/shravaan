# 00 — Provider research: Deepgram vs Sarvam

**Researched:** 2026-08-29. Every claim below was read from the live documentation in that
session. Model names, language coverage, latency and pricing all change — re-verify before
committing engineering effort.

**Product context:** a multilingual **companion bot on a dedicated device / embedded
client**, with strong memory continuity across days and weeks, and free language switching
on any turn. Not telephony. See [01-architecture.md](01-architecture.md).

**Language scope (decided and final):** **the 10 languages Bulbul v3 speaks, plus
`en-IN`** — Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi,
Odia, English. Hinglish and code-mixing within that set are in scope. Everything else,
including the 12 Indian languages Saaras can transcribe but Bulbul cannot speak, is **out of
scope and refused at session open**.

This makes Sarvam the only viable provider for the core path and reduces Deepgram to a
Hindi-only ASR standby — see [§7.1](#71-the-stack-hears-22-indian-languages-and-speaks-10)
and [ADR 0005](adr/0005-tts-provider-split.md).

**Reading rule:** every row carries its source. Where a cell says *not documented*, that
means the documentation was checked and is silent — it does not mean the feature is absent.
Nothing in this document is filled in from prior knowledge.

---

## 1. Speech-to-text

| Item | Deepgram | Sarvam |
|---|---|---|
| Current model names | `flux-general-en`, `flux-general-multi`, `nova-3`/`nova-3-general`, `nova-3-medical`, `nova-2` family (`-meeting`, `-phonecall`, `-finance`, `-conversationalai`, `-voicemail`, `-video`, `-medical`, `-drivethru`, `-automotive`, `-atc`); legacy `nova`, `enhanced`, `base`, `whisper-{tiny,base,small,medium,large}` ([models overview](https://developers.deepgram.com/docs/models-languages-overview)) | `saaras:v3` (default/recommended), `saaras:v4` (latest, adds Global English), `saaras:v3-realtime` (**the only model accepted on the streaming socket**), `saarika-v2.5` (legacy) ([models](https://docs.sarvam.ai/api/getting-started/models), [Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md), [realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Streaming protocol | WebSocket. Flux: `wss://api.deepgram.com/v2/listen?model=flux-general-en`. "80ms audio chunks strongly recommended" ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)) | WebSocket. `GET /speech-to-text-realtime/ws`. Client sends `audio_input`, `speech_start`, `speech_end`, `flush`, `config.update`, `end`, `ping`; server sends `session.begin`, `vad.speech_start`, `vad.speech_end`, `transcript.partial`, `transcript.final`, `config.updated`, `pong`, `session.end`, `error` ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Supported languages | Nova-3 Indic set: `hi`, `ta`, `te`, `kn`, `gu`, `mr`, `pa`, `as`, `bn`, `ne` ([models overview](https://developers.deepgram.com/docs/models-languages-overview)). **Flux Multilingual = 10 languages only**: English, Spanish, French, German, **Hindi**, Russian, Portuguese, Japanese, Italian, Dutch ([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)) | **23 languages — 22 Indic + English**: Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia, Assamese, Urdu, Nepali, Konkani, Kashmiri, Sindhi, Sanskrit, Santali, Manipuri, Bodo, Maithili, Dogri, English — BCP-47 codes (`hi-IN`, `ta-IN`, …) ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)) |
| Automatic language detection | **Not on streaming.** "Language Detection is not currently supported for streaming"; `detect_language` is batch-only, 35 languages, returns `detected_language` + `language_confidence` ([language detection](https://developers.deepgram.com/docs/language-detection.md)). On streaming the substitute is Flux Multilingual: "without hints, the model auto-detects the spoken language" ([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)) | **Yes, but the docs disagree on the token.** Saaras page: "when not specified or set to `unknown`, the model will automatically detect the input language and return a `language_probability` score" ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)). Realtime page: `language_code` accepts 24 values **including `auto`**, and partials/finals then carry a detected `language` field ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)). Streaming guide: `language_code` is **"Required"**, auto-detect only on the translate endpoint ([streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api)). See §7 and [05-open-questions.md](05-open-questions.md). |
| Code-mixed / Hinglish | **Genuine code-switched recognition.** `language=multi` on Nova-2/Nova-3, or `model=flux-general-multi` ([code-switching](https://developers.deepgram.com/docs/multilingual-code-switching.md)). Flux Multilingual "natively handles code-switching" for speakers who "switch between languages mid-conversation"; set hints for expected languages ([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)) | **A transcript formatting mode, not a recognition mode.** `mode=codemix` yields "code-mixed text with English words in English and Indic words in native script"; also `transcribe`, `translate`, `verbatim`, `translit`. Docs claim "code-mixed audio support" across all modes ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)). **The JavaScript SDK silently drops `mode`** — "any `mode` you pass is silently dropped and the connection always runs in the default `transcribe` mode" ([streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api)) |
| Time to first token / turn | **"~260ms end-of-turn detection"** — the only hard latency figure published by either provider ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)). `Update` events every ~0.25 s ([Flux state](https://developers.deepgram.com/docs/flux/state.md)) | **Not documented.** No latency figure appears on the model, streaming, or Voice Agents pages ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md), [realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Word-level timestamps | **Yes** — "Start and end times for each recognized word" ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)). Added to Flux 2026-06-30 ([changelog](https://developers.deepgram.com/changelog)) | **Utterance level only.** `return_timestamps` "adds `start_s`/`end_s` to `transcript.final`" ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Diarization | **Yes on streaming** — `diarize_model=v1` or `diarize_model=latest`; Nova-1/2/3, enhanced, base; Whisper unsupported. Streaming returns speaker **without** a confidence value; pre-recorded returns both ([diarization](https://developers.deepgram.com/docs/diarization.md)) | **Not documented for streaming.** Priced only as a batch add-on at ₹45/hr vs ₹30/hr base ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| 8 kHz telephony | Yes — `sample_rate=8000`, with `mulaw`, `alaw`, `amr-nb`, `amr-wb`, `g729` ([encoding](https://developers.deepgram.com/docs/encoding.md)). Flux accepts 8000/16000/24000/44100/48000 ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)) | Yes, and it is a design target — Saaras is "optimized for 8KHz telephony audio" ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)). **The realtime socket accepts only 8000 or 16000** — "any other value closes the connection (code `4000`)" ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Confidence scores exposed | **Yes** — `word.confidence` per word on Flux ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)); `language_confidence` on batch detection ([language detection](https://developers.deepgram.com/docs/language-detection.md)) | **No ASR confidence documented.** Only `language_probability` (0.0–1.0), which scores *language identification*, not transcription ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)). This is a real gap — see §7.6 |
| Audio encodings | `linear16`, `linear32`, `flac`, `alaw`, `mulaw`, `amr-nb`, `amr-wb`, `opus`, `ogg-opus`, `speex`, `g729`; Flux raw audio accepts `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, `ogg-opus` ([encoding](https://developers.deepgram.com/docs/encoding.md)) | `linear16`, `linear32`, `mulaw`, `alaw` — **mono only** ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Request/session limits | Not documented on the pages read | REST: 30 s of audio per request; Batch API: up to 2 hours ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)) |

---

## 2. Text-to-speech

| Item | Deepgram | Sarvam |
|---|---|---|
| Current model names | Flux TTS (`/v2/speak`), model format `flux-{voice}-{language}` e.g. `flux-haley-en`; Aura-2 (`/v1/speak`) e.g. `aura-2-thalia-en`; Aura-1 (`/v1/speak`) legacy ([TTS overview](https://developers.deepgram.com/docs/tts-models-languages-overview.md), [Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md)) | `bulbul:v3` (legacy `bulbul:v2`) ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)) |
| **Supported languages** | **Flux TTS: English only.** **Aura-2: `en`, `es`, `de`, `fr`, `nl`, `it`, `ja` — seven.** **Aura-1: English only.** **No Hindi. No Indic language of any kind.** ([TTS overview](https://developers.deepgram.com/docs/tts-models-languages-overview.md)) | **11 languages — 10 Indian + English**: `hi-IN`, `bn-IN`, `ta-IN`, `te-IN`, `gu-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `pa-IN`, `or-IN`, `en-IN` ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)) |
| Streaming vs batch | Both. Flux TTS is "streaming-first, voice-agent-first", turn-based: stream LLM tokens via `Speak`, signal completion with `Flush`; server emits `SpeechStarted`, audio frames, `SpeechMetadata` ([Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md)) | Three paths: REST (≤2500 chars), HTTP streaming (≤3500 chars), WebSocket (≤2500 chars/message, "<500 characters for optimal streaming performance"). WebSocket recommended for agents ([which API](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-api-to-use), [TTS WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket)) |
| Latency to first audio | **Not documented.** No time-to-first-byte figure on the Flux TTS or Aura pages ([Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md), [voices](https://developers.deepgram.com/docs/tts-models)) | **Not documented — qualitative only.** REST "After full synthesis"; HTTP stream "Low — first chunk streams early"; WebSocket "Lowest on a warm connection" ([which API](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-api-to-use)) |
| Voice list | Aura-2: 39 English (American, British, Australian, Irish, Filipino accents), 18 Spanish, 10 Italian, 9 Dutch, 7 German, 5 Japanese, 2 French. Aura-1: 12 legacy English ([voices](https://developers.deepgram.com/docs/tts-models)) | **30+ speakers**, default `Shubh`; named examples include Aditya, Ritu, Priya, Neha, Rahul, Pooja, Rohan, Simran, Kavya, Amit, Dev, Ishita, Shreya, Kabir, Tanya, Shruti, Suhani, Kavitha, Rehan, Soham, Rupali ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)) |
| **Code-mixed sentence, one voice, no seam** | **Partially, and not for our case.** Five Aura-2 *Spanish* voices "support codeswitching between Spanish and English" ([voices](https://developers.deepgram.com/docs/tts-models)). No equivalent claim exists for any other language pair, and there is no Hindi voice to make the question meaningful | **Not documented.** Neither the model page nor the voice page states whether one Bulbul voice renders a Hinglish sentence without a seam ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md), [speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)). **Also undocumented: whether a given speaker is the same perceived person across languages.** See §7.3 |
| Sample rates | Flux TTS: `linear16` at 8000/16000/24000/32000/44100/48000; `mulaw`/`alaw` at 8000 or 16000 ([Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md)) | 8000 / 16000 / 22050 / 24000 Hz; plus 32000 / 44100 / 48000 **REST only**. Default 24000 (v3), 22050 (v2). **Both HTTP and WebSocket streaming are capped at 24 kHz** ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)) |
| Output codecs | `linear16`, `mulaw`, `alaw` streaming; batch adds mp3, opus, flac, aac ([Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md)) | mp3, wav, aac, opus, flac, `linear16`, `mulaw`, `alaw` ([TTS WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket)) |
| Prosody control | Speed 0.85 / 0.9 / 0.95 / 1.0 / 1.05 / 1.1 / 1.15, changeable mid-stream with `Configure` ([Flux TTS](https://developers.deepgram.com/docs/flux-tts/quickstart.md)). Aura-2 gained speed controls 2026-04-30 ([changelog](https://developers.deepgram.com/changelog)) | `pace` 0.5–2.0. **v3 does not support pitch or loudness** ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)) — but the agent canvas exposes a pitch slider ([speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)). Contradiction, see §7.9 |
| Connection lifecycle | Not documented on the pages read | **`ping` required — the connection auto-closes after ~1 minute of inactivity.** `Flush` forces buffer processing regardless of `min_buffer_size`. Config fields: `speaker`, `language_code`, `pace`, `min_buffer_size`, `max_chunk_length`, `output_audio_codec`, `output_audio_bitrate` ([TTS WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket)) |
| Pronunciation control | Not documented on the pages read | Pronunciation dictionary per language, JSON, up to 5 MB. **Voice cloning is enterprise-only** ([speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)) |

---

## 3. Turn-taking

| Item | Deepgram | Sarvam |
|---|---|---|
| End-of-turn detection | **Native, model-based.** Flux state machine: `StartOfTurn` → `EagerEndOfTurn` → (`TurnResumed` \| `EndOfTurn`). Every `EndOfTurn` carries a `trigger` of `model`, `manual` (via `ForceEndTurn`) or `timeout` ([Flux state](https://developers.deepgram.com/docs/flux/state.md)) | **VAD-based.** Two modes: `vad` (server auto-detects) and `manual` (client sends `speech_start`/`speech_end`/`flush`). Server emits `vad.speech_start` / `vad.speech_end` ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)) |
| Tunable parameters | `eot_threshold` 0.5–1.0, default **0.7**; `eager_eot_threshold` 0.3–0.9, default unset (eager disabled); `eot_timeout_ms` 500–60000, default **5000** ([Flux config](https://developers.deepgram.com/docs/flux/configuration.md)) | `threshold`, `silence_duration_ms`, `min_speech_duration_ms` ([realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)). **No defaults or ranges published.** The managed agent exposes only qualitative sliders — "Sound sensitivity" (Low–High), "Eagerness to respond" (Patient–Eager) ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) |
| Barge-in | Trigger on `StartOfTurn` — "more reliable than an external VAD because every `StartOfTurn` is guaranteed to contain a non-empty transcript" ([Flux state](https://developers.deepgram.com/docs/flux/state.md)). Voice Agent API ships "built-in barge-in detection, turn-taking prediction" ([product page](https://deepgram.com/product/voice-agent-api)) | **Documented and directly usable.** "If the caller speaks while the agent is still playing audio, a `clearAudio` event stops playback and a new utterance begins." Tuning guidance: **"drive barge-in off `vad.speech_start` or early partials, not `transcript.final`"** ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) |
| Silence / idle handling | `eot_timeout_ms` forces an `EndOfTurn` after max silence ([Flux config](https://developers.deepgram.com/docs/flux/configuration.md)) | "Nudge quiet callers" — a message fired after N seconds, multiple nudges supported; "Hang up after unanswered nudges" ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) |
| Session length cap | Not documented on the pages read | **"Max call length" capped at 25 minutes** in the managed agent product ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)) |

---

## 4. Agent APIs — what is bundled, what is bring-your-own

This is the section where the two providers diverge most sharply, and it decided our
orchestrator ([ADR 0001](adr/0001-orchestrator.md)).

| Item | Deepgram Voice Agent API | Sarvam Voice Agents |
|---|---|---|
| What it bundles | STT + LLM orchestration + TTS "in real time" over a single WebSocket ([getting started](https://developers.deepgram.com/docs/voice-agent.md), [product page](https://deepgram.com/product/voice-agent-api)) | "a real-time ASR → LLM → TTS loop"; formerly **Samvaad**. Build/test canvas, versioning, deployment, outbound campaigns, call logs and analytics ([overview](https://docs.sarvam.ai/conversations/overview.md), [announcement](https://docs.sarvam.ai/conversations/newly-launched)) |
| **BYO STT** | **No — "only Deepgram is supported"** as the speech-to-text provider ([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)) | **No** ([models](https://docs.sarvam.ai/conversations/build/models)) |
| **BYO LLM** | **Yes.** Managed: OpenAI, Anthropic, Google, Groq, AWS Bedrock. Custom: `agent.think.endpoint` with a URL and custom headers ([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)) | **No.** And the model is not even selectable: "Workloads are routed automatically based on the kind of request, so you don't pick a model per agent" ([models](https://docs.sarvam.ai/conversations/build/models)) |
| **BYO TTS** | **Yes.** Managed: Deepgram (default), Eleven Labs, Cartesia, OpenAI, AWS Polly. Custom: `agent.speak.endpoint` ([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)) | **No** ([models](https://docs.sarvam.ai/conversations/build/models)) |
| Stated policy | — | **"Voice Agents does *not* support bringing your own models at any part of the stack (ASR, LLM, or TTS)."** Rationale: "The stack is built, evaluated, and tuned end to end around our own set of models. Swapping in an external model would put reliability, latency, and accuracy at risk." ([models](https://docs.sarvam.ai/conversations/build/models)) |
| Fixed stack | Listen = Deepgram Flux or Nova ([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)) | STT **Saaras v3** only; TTS **Bulbul v3** only; LLM "a mix of Sarvam models, open-source models, and our fine-tunes", auto-routed ([models](https://docs.sarvam.ai/conversations/build/models)) |
| Audio config | Input `linear16` default; `audio.input.sample_rate` default 16000; output encoding, sample rate, bitrate and container configurable ([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)) | **Not published** on the deploy page — no encodings, sample rates, endpoint URLs or event schema ([deploy with code](https://docs.sarvam.ai/conversations/deploy/deploy-with-code)) |
| Channels | Not enumerated on the pages read | Telephony (inbound + outbound campaigns), WhatsApp (enterprise, on request), Web voice/chat widget, API, **SDK ("agent as a service")**. GA on telephony, web, API and SDK ([overview](https://docs.sarvam.ai/conversations/overview)) |
| Non-browser clients | — | Supported: "connect over the Voice Agents WebSocket interface. Handle audio frames, turn events, and tool-call signals." Keys must stay server-side and the WebSocket be proxied through your backend ([deploy with code](https://docs.sarvam.ai/conversations/deploy/deploy-with-code)) |
| Agent-level config | — | Greeting with variable chips, system prompt, starting language, switch-language-during-call, languages allowed, speakers & voice, tools ([quickstart](https://docs.sarvam.ai/conversations/quickstart.md), [build overview](https://docs.sarvam.ai/conversations/build/overview)) |

---

## 5. Commercials

| Item | Deepgram | Sarvam |
|---|---|---|
| Currency | USD ([pricing](https://deepgram.com/pricing)) | **INR** ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| STT pricing unit | Per minute. Streaming: Flux English **$0.0065/min** (PAYG) / $0.0057 (Growth); Flux Multilingual **$0.0078** / $0.0068; Nova-3 mono $0.0048 / $0.0042; Nova-3 multilingual $0.0058 / $0.0050. Several marked promotional ([pricing](https://deepgram.com/pricing)) | **Per hour.** STT **₹30/hr**; STT + diarization ₹45/hr; STT + translation ₹30/hr; STT + translation + diarization ₹45/hr ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| TTS pricing unit | Per 1k characters. Aura-2 **$0.030/1k** / $0.027; Aura-1 $0.0150 / $0.0135; **Flux TTS free through 9/12/2026**, then $0.0450/1k / $0.0405 ([pricing](https://deepgram.com/pricing)) | Per 10k characters. Bulbul v3 **₹30 per 10k characters** ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| LLM pricing | Not applicable (BYO or bundled per-minute) | Per 1M tokens. **Sarvam-105B: ₹29.28 input, ₹10.98 cached input, ₹73.2 output**. Gemma-4 31B (beta) ₹36.6/₹13.73/₹91.5; GLM 5.2 (beta) ₹128.1/₹23.79/₹402.6 ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| Agent pricing | Per minute of WebSocket connection. Standard $0.056/min through 9/12 then **$0.075**; Custom BYO-LLM $0.050 → $0.065; Advanced $0.122 → $0.163. Marketed as "$4.50/hr with Deepgram's full stack" ([pricing](https://deepgram.com/pricing), [product page](https://deepgram.com/product/voice-agent-api)) | Not published as a separate agent rate on the pricing page ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| Add-ons | Streaming diarization +$0.0020/min; redaction +$0.0020/min; keyterm prompting +$0.0013/min; entity detection +$0.0017/min; smart formatting included ([pricing](https://deepgram.com/pricing)) | Translation / transliteration ₹20 per 10k chars; language identification ₹3.5 per 10k chars; document digitisation ₹0.5/page ([pricing](https://docs.sarvam.ai/api/getting-started/pricing)) |
| Free tier | **$200 free credit** on Pay-As-You-Go ([pricing](https://deepgram.com/pricing)) | **₹100 complimentary credits**, universal across APIs, no expiry ([rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)) |
| Concurrency limits | STT REST 50 (both plans); **STT WebSocket 150 (PAYG) / 225 (Growth)** ([pricing](https://deepgram.com/pricing)) | **STT WebSocket concurrent: 20 (Starter) / 100 (Pro) / 100 (Business)**. TTS WebSocket concurrent: 60 / 200 / 1000, but **Bulbul v3 specifically 30 / 200 / 1000** ([rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)) |
| Rate limits | Not published per-plan beyond concurrency ([pricing](https://deepgram.com/pricing)) | STT REST 60 / 100 / 4000 req/min; TTS REST 60 / 200 / 1000 (Bulbul v3: 30 / 200 / 1000); **Sarvam-105B 40 / 60 / 120 req/min**; batch 20 / 100 / 500. `429` on exceed; exponential backoff advised ([rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)) |
| Plan tiers | Pay-As-You-Go ($200 credit); Growth ($4K+/yr, up to 20% saving); Enterprise (custom) ([pricing](https://deepgram.com/pricing)) | Starter (PAYG); Pro ₹10,000 (+₹100 bonus credits); Business ₹50,000 (+₹7,500); Enterprise custom ([rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)) |
| Data residency | **EU: `api.eu.deepgram.com`; Australia: `api.au.deepgram.com`** (AWS ap-southeast-2, storage and inference in-country). Both cover STT, TTS, Voice Agent and Text Intelligence. **No India region.** ([EU endpoint](https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available), [AU endpoint](https://deepgram.com/learn/deepgram-australia-endpoint-now-generally-available)) | **"Data residency in India"**, with all models self-hosted rather than sub-contracted to third parties ([overview](https://docs.sarvam.ai/conversations/overview.md)) |

---

## 6. Recent changes worth knowing

From [Deepgram's changelog](https://developers.deepgram.com/changelog):

- **2026-08-26** — Flux TTS gains expressivity control; formatting improvements for currency, dates and Japanese punctuation.
- **2026-08-12** — Flux TTS reaches self-hosted via `/v2/speak` (Early Access). **Nova-3 adds Nepali and Punjabi.**
- **2026-07-28** — FIPS 140-3 images GA; expanded diarization metadata; `.dgv2` encrypted model format.
- **2026-06-30** — **Flux gains word-level timestamps**; streaming accuracy improvements.
- **2026-06-17** — **Australia endpoint** launches for STT, TTS, Voice Agent and Text Intelligence.
- **2026-05-28** — Profanity filtering extended to Nova-3 multilingual.
- **2026-04-30** — **Nova-3 adds Gujarati**; Aura-2 gains speed controls.
- **2026-04-16** — **Flux Multilingual released** for real-time code-switching.

Sarvam does not publish a comparable dated changelog on the pages read. The equivalent
signal is the Voice Agents GA announcement and the `sarvam-m` / `sarvam-30b` deprecations
([announcement](https://docs.sarvam.ai/conversations/newly-launched),
[models](https://docs.sarvam.ai/api/getting-started/models)).

**Implication for planning:** Deepgram's Indic *STT* coverage is expanding steadily
(Gujarati in April, Nepali and Punjabi in August). Its Indic *TTS* coverage has not moved
at all. Do not extrapolate the STT trend onto TTS.

---

## 7. Where the docs contradict our assumptions

Blunt, in priority order. Each item states what the architecture assumes, what the docs
actually say, and whether the assumption survives.

### 7.1 The stack hears 22 Indian languages and speaks 10

**The single most important finding for an Indic-scoped product**, and it is a gap *inside*
Sarvam, not between the two vendors.

**Assumed:** "Sarvam is the default path for everything" — implying Sarvam's Indic coverage
is uniform across the pipeline.

**Actual:** it is not. Saaras and Bulbul have different language sets, and nothing in the
documentation flags the mismatch.

| | Saaras STT | Bulbul v3 TTS |
|---|---|---|
| Indian languages | **22** | **10** |
| Plus | English | English (`en-IN`) |
| Source | [Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md) | [Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md) |

**Spoken by both — safe (10):** Hindi `hi-IN`, Bengali `bn-IN`, Tamil `ta-IN`,
Telugu `te-IN`, Gujarati `gu-IN`, Kannada `kn-IN`, Malayalam `ml-IN`, Marathi `mr-IN`,
Punjabi `pa-IN`, Odia `or-IN`, plus English `en-IN`.

**Heard but unspeakable — 12 Indian languages with no voice in the entire stack:**

| Language | Code | Language | Code |
|---|---|---|---|
| **Urdu** | `ur-IN` | Sindhi | `sd-IN` |
| **Assamese** | `as-IN` | Sanskrit | `sa-IN` |
| **Maithili** | `mai-IN` | Santali | `sat-IN` |
| Nepali | `ne-IN` | Manipuri | `mni-IN` |
| Konkani | `kok-IN` | Bodo | `brx-IN` |
| Kashmiri | `ks-IN` | Dogri | `doi-IN` |

**Verdict: the assumption fails, and it fails in the worst possible way.** These are not
languages the system rejects at the door — Saaras will transcribe them *accurately*, the LLM
will reason about them, and then there is nothing to speak with. A naive implementation gets
all the way to synthesis before discovering it has no voice.

**Resolved by scoping.** The product supports **Bulbul's 11 languages and no others**. The 12
in the right-hand list are out of scope and refused at session open
([ADR 0005](adr/0005-tts-provider-split.md)). Urdu is the notable loss — it has by far the
largest speaker population in that set.

**The gate still has to exist.** Scoping the languages out does not make the failure mode go
away, because Saaras will still happily transcribe them. The check must sit at **session
open** and key on the **TTS** matrix, never on "is this an Indian language". Being able to
hear a language is not permission to start a conversation in it.

**Deepgram cannot fill any of this gap.** Its TTS covers exactly seven languages —
`en`, `es`, `de`, `fr`, `nl`, `it`, `ja` — none of them Indic
([TTS overview](https://developers.deepgram.com/docs/tts-models-languages-overview.md)).
Bulbul is the only Indic voice available from either provider, so these 12 languages are
unreachable, not merely unredundant. See [ADR 0005](adr/0005-tts-provider-split.md).

### 7.1b "Fail over to the other provider" survives for exactly one language

**Assumed:** "provider timeout → fail over to the other ASR" as a general rule.

**Actual**, now that scope is Indic-only:

| Stage | Hindi | The other 9 speakable Indian languages |
|---|---|---|
| ASR | Sarvam ⇄ Deepgram `flux-general-multi` | **Sarvam only** |
| TTS | **Sarvam only** | **Sarvam only** |

Deepgram's `flux-general-multi` covers 10 languages of which **only Hindi is Indic**
([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)).
Nova-3 reaches more Indic languages for batch work, but the streaming code-switching model
does not.

**Verdict:** a Hindi session has one redundant stage out of two. **A Tamil, Bengali,
Marathi, Telugu, Gujarati, Kannada, Malayalam, Punjabi or Odia session has no redundancy at
any stage whatsoever.** That is a single-vendor availability profile and should be stated to
whoever owns the uptime target before it is discovered during an incident.

### 7.2 Barge-in on an open-air device is an echo problem the docs do not address

**Assumed:** "Queued audio is flushed on barge-in", as a pipeline concern.

**Actual:** Both providers give good, usable barge-in triggers — Sarvam's
**"drive barge-in off `vad.speech_start` or early partials, not `transcript.final`"** with
a `clearAudio` event ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)),
and Deepgram's `StartOfTurn` ([Flux state](https://developers.deepgram.com/docs/flux/state.md)).
**Neither helps if the ASR is confidently transcribing our own speaker output.** Every
barge-in mechanism in both docsets assumes a telephony leg, where the carrier has already
performed echo cancellation.

**Verdict: the assumption is incomplete.** On a device with a speaker beside the mic, AEC is
ours to build, and it sits upstream of everything the providers offer. This is the single
highest technical risk in the project. See [ADR 0007](adr/0007-audio-front-end.md).

### 7.3 Voice identity across a language switch is undocumented

**Assumed (implicitly):** one persona, one voice, language switching freely.

**Actual:** Bulbul has 30+ speakers across 11 languages. The voice-and-language page was
read directly and **does not state whether a chosen speaker remains the same perceived
person when the language changes mid-conversation**
([speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)).

**Verdict: unresolved and product-critical.** For a telephony agent this is cosmetic. For a
companion someone talks to daily for months, a voice that changes character mid-conversation
is the product breaking. The two mitigations in the docs are both partial: a per-language
pronunciation dictionary (JSON, ≤5 MB) fixes names, not timbre; and voice cloning is
enterprise-only. **Must be settled by listening, not by reading.**

### 7.4 Free per-turn language switching is real — but our evidence is one layer above our API

**Assumed:** language resolved once and locked. *(Superseded — the product now requires free
switching on any turn.)*

**Actual:** Sarvam's managed Voice Agents ships **"Switch language during call"**,
**"Auto-detected language switch"** and "Languages allowed" as first-class settings, and
markets exactly this case — "code-mixed speech, callers who interrupt, languages that switch
mid-sentence" ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings),
[announcement](https://docs.sarvam.ai/conversations/newly-launched)). The raw model
corroborates auto-detection ([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md)).

**But three pages use two different tokens and one flatly contradicts the others:**

| Page | Says |
|---|---|
| [Saaras model](https://docs.sarvam.ai/api/getting-started/models/saaras.md) | auto-detects when unset or set to **`unknown`** |
| [Realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming) | `language_code` accepts 24 values **including `auto`** |
| [Streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api) | `language_code` is **"Required"**; auto-detect only on the translate endpoint |

**Verdict: the capability is real; the exact parameter is unconfirmed on
`saaras:v3-realtime`.** This is a one-afternoon empirical test, not a design fork. Sarvam
remains the default provider. Note that the switching behaviour is demonstrated inside
*Sarvam's own orchestration layer*, which we are not using — see 7.5.

### 7.5 Sarvam Voice Agents cannot host this architecture — proven, not inferred

**Assumed:** a bundled agent API might carry some of the orchestration.

**Actual:** **"Voice Agents does *not* support bringing your own models at any part of the
stack (ASR, LLM, or TTS)"**, and the LLM is not selectable — "Workloads are routed
automatically based on the kind of request, so you don't pick a model per agent"
([models](https://docs.sarvam.ai/conversations/build/models)).

**Verdict:** this forecloses three requirements at once — the Deepgram non-Indic TTS path,
the explicit Sarvam-105B choice, and our own turn-state ownership. Deepgram's Voice Agent
API is more open (BYO LLM and BYO TTS via `agent.think.endpoint` / `agent.speak.endpoint`)
but accepts **only Deepgram STT** and has no Indic voice
([configure](https://developers.deepgram.com/docs/configure-voice-agent.md)). Both bundled
products are out. See [ADR 0001](adr/0001-orchestrator.md).

### 7.6 The low-confidence reprompt has no documented trigger on Sarvam

**Assumed:** "low ASR confidence → targeted reprompt naming the uncertain slot".

**Actual:** Deepgram Flux exposes `word.confidence` per word
([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)). Sarvam's
streaming docs expose `language_probability` — which scores *language identification*, not
transcription — and utterance-level `start_s`/`end_s`. **No ASR confidence field is
documented anywhere on the Sarvam path**
([Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md),
[realtime streaming](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)).

**Verdict: the rule as written is not implementable on the default provider.** It needs a
substitute trigger — LLM-side slot uncertainty, or a confirmation policy on high-stakes
slots. Recorded in [05-open-questions.md](05-open-questions.md).

### 7.7 The latency budget is very nearly unsourced

**Assumed:** ASR 150 / Redis 5 / LLM first token 250 / TTS first audio 250, under 800 ms
mouth-to-ear.

**Actual:** the **only** hard latency number published by either provider is Deepgram Flux's
**"~260ms end-of-turn detection"** ([Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.md))
— which **alone exceeds the entire 150 ms ASR allocation**. Sarvam publishes no latency
figure for STT, TTS or the LLM anywhere, including in the Voice Agents documentation; its
TTS comparison grades WebSocket only as "Lowest on a warm connection"
([which API](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-api-to-use)).

**Verdict: the budget is a hypothesis, not a budget.** And it omits a stage entirely — a
device on home wifi adds a network hop the allocation never accounted for. See
[03-latency-budget.md](03-latency-budget.md).

### 7.8 The LLM is the concurrency ceiling, not the ASR

**Assumed (implicitly):** ASR concurrency governs scale.

**Actual:** Sarvam-105B is limited to **40 req/min (Starter) / 60 (Pro) / 120 (Business)**,
against STT WebSocket concurrency of 20 / 100 / 100 and Bulbul v3 TTS concurrency of
30 / 200 / 1000 ([rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)).

**Verdict: capacity plans against the LLM.** At a plausible 3–5 LLM calls per active minute,
Starter supports roughly 8–13 concurrent conversations. For a companion that holds sockets
open through long idle stretches, **concurrent socket count may bind before request rate
does** — both limits need modelling, and they are not the same limit.

### 7.9 Smaller contradictions

- **Bulbul pitch.** The model page says v3 "does **not** support pitch/loudness"
  ([Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md)); the agent canvas
  exposes a pitch slider ([speakers & voice](https://docs.sarvam.ai/conversations/build/voice-language)).
  Either the control is inert on v3 or the model page is stale.
- **`codemix` is not a recognition mode.** It formats an already-recognised utterance, and
  **the JavaScript SDK silently drops the `mode` parameter entirely**
  ([streaming guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api)).
  A JS/TS orchestrator cannot reach `codemix` through the SDK.
- **Redis TTLs assume a call.** "TTL = expected call length + buffer" and
  "`user:{uid}:profile` TTL = session" do not survive strong cross-session continuity. See
  [02-data-contracts.md](02-data-contracts.md).
- **Session model mismatch.** Sarvam's managed agent caps "Max call length" at **25 minutes**
  ([conversation settings](https://docs.sarvam.ai/conversations/build/conversation-settings)),
  and its TTS socket auto-closes after **~1 minute idle**
  ([TTS WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket)).
  Both are tuned for calls, not for a companion available across an evening.

---

## 8. Pages that could not be fetched

Recorded rather than filled in from memory, per the research rules.

| URL | Result |
|---|---|
| `https://www.sarvam.ai/models` | **HTTP 403 Forbidden** |
| `https://www.sarvam.ai/speech-to-text` | **HTTP 403 Forbidden** |
| `https://www.sarvam.ai/text-to-speech` | **HTTP 403 Forbidden** |
| `https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/which-tts-api` | 404 — correct path is `which-api-to-use` |
| `https://docs.sarvam.ai/api-reference-docs/speech-to-text-streaming/transcribe/ws` | 404 |
| `https://developers.deepgram.com/docs/data-residency.md` | 404 — residency facts sourced from Deepgram's own blog posts instead |
| `https://developers.deepgram.com/docs/regions.md` | 404 — same |
| `https://docs.livekit.io/agents/models/tts/plugins/sarvam.md` | 404 |

The three `www.sarvam.ai` pages were named explicitly in the research brief. All three
refuse automated fetches. Everything attributed to Sarvam in this document therefore comes
from `docs.sarvam.ai`, which serves normally. **No claim here is sourced from the blocked
marketing pages.**

Two consequences: any product claim that exists *only* on Sarvam's marketing site is absent
from this comparison, and the Sarvam latency picture may be less empty than it appears — if
figures are published, they may live on those pages. This should be checked manually in a
browser before the latency budget is finalised.

---

## 9. Orchestration frameworks (surveyed, not adopted)

Read only far enough to judge the build-vs-adopt decision. We chose to roll our own — see
[ADR 0001](adr/0001-orchestrator.md).

| Framework | Sarvam | Deepgram |
|---|---|---|
| Pipecat | STT **and** TTS, maintainer-supported (`pipecat-ai[sarvam]`) ([supported services](https://docs.pipecat.ai/server/services/supported-services)). Sarvam publishes a first-party guide using `SarvamSTTService`, `SarvamLLMService(model="sarvam-105b")`, `SarvamTTSService(model="bulbul:v3")` ([Pipecat guide](https://docs.sarvam.ai/api/integration/build-voice-agent-with-pipecat)) | STT and TTS, maintainer-supported (`pipecat-ai[deepgram]`) ([supported services](https://docs.pipecat.ai/server/services/supported-services)) |
| LiveKit Agents | STT and TTS plugins, Python and Node ([STT](https://docs.livekit.io/agents/integrations/stt/), [TTS](https://docs.livekit.io/agents/integrations/tts/)) | STT and TTS plugins, Python and Node (same) |

Both frameworks cover both providers, so neither constrains the provider choice. The
decision turned on control over turn state and the memory pipeline, not on integration
availability.
