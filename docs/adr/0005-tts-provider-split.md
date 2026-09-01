# ADR 0005 — Bulbul is the only voice: an 11-language ceiling and no failover

**Status:** Accepted · **Date:** 2026-08-29
**Supersedes the earlier framing of this decision** as a Sarvam-Indic / Deepgram-non-Indic
split. With scope fixed to Hindi, Hinglish and Indian languages, there is no split left.

## Context

The originally proposed architecture said "Sarvam is the default path for everything;
Deepgram is the exception for confirmed non-Indic locales", with a general rule of "provider
timeout → fail over to the other".

Both halves of that collapse once the language scope is Indic-only.

## The two findings that forced this decision

### 1. Deepgram has no Indic voice at all

| Model | Languages |
|---|---|
| Flux TTS (`/v2/speak`) | English only |
| Aura-2 (`/v1/speak`) | `en`, `es`, `de`, `fr`, `nl`, `it`, `ja` |
| Aura-1 (`/v1/speak`) | English only |

Source: [TTS models & languages](https://developers.deepgram.com/docs/tts-models-languages-overview.md).

With non-Indic out of scope, **Deepgram TTS is now entirely unused.** Aura-2's six non-English
languages have no user. There is no split to make.

### 2. Sarvam hears twice as many Indian languages as it speaks

This is the finding that actually matters, and it sits *inside* the vendor.

| | Saaras STT | Bulbul v3 TTS |
|---|---|---|
| Indian languages | **22** | **10** |
| Source | [Saaras](https://docs.sarvam.ai/api/getting-started/models/saaras.md) | [Bulbul](https://docs.sarvam.ai/api/getting-started/models/bulbul.md) |

**Speakable (the product's real language list):** `hi-IN`, `bn-IN`, `ta-IN`, `te-IN`,
`gu-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `pa-IN`, `or-IN`, `en-IN`.

**Heard but unspeakable — 12 Indian languages:** Urdu `ur-IN`, Assamese `as-IN`,
Nepali `ne-IN`, Konkani `kok-IN`, Kashmiri `ks-IN`, Sindhi `sd-IN`, Sanskrit `sa-IN`,
Santali `sat-IN`, Manipuri `mni-IN`, Bodo `brx-IN`, Maithili `mai-IN`, Dogri `doi-IN`.

Nothing in Sarvam's documentation flags this asymmetry. It has to be derived by comparing two
model pages.

## Decision

**Bulbul v3 is the only text-to-speech in the system, and its 11 languages are the product's
complete language set.**

`hi-IN`, `bn-IN`, `ta-IN`, `te-IN`, `gu-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `pa-IN`, `or-IN`,
`en-IN`. Hinglish and code-mixing within that set are in scope.

**The other 12 Indian languages are out of scope and refused at session open**, in a language
we can actually speak. No second TTS vendor, no translation substitution.

**No TTS failover exists, for any language.** Accepted, not engineered around.

## Options considered

### Ship Bulbul's 11 and refuse the rest — chosen

Honest and simple. The product's language list is exactly what it can speak, with no
asymmetry between what it hears and what it answers. The 11 cover the large majority of the
addressable population.

The cost is real and should be named: **Urdu is the notable loss**, with by far the largest
speaker population among the excluded 12. This is a deliberate scope decision, not an
oversight.

### Add a second TTS provider for the gap — rejected

The only route to Urdu, Assamese or Maithili. Rejected on three grounds: a second vendor
integration for a minority of the user base; the fallback would sound like a **different
person**, which for a companion is worse than a clean limitation; and voice identity is
already the open risk in
[Q2](../05-open-questions.md#q2-is-a-bulbul-speaker-the-same-perceived-person-across-languages).

**Revisit only if Urdu becomes a hard product requirement.**

### Translate unspeakable languages into a speakable one — rejected

Sarvam ships `mayura` and `sarvam-translate`
([models](https://docs.sarvam.ai/api/getting-started/models)), so a Maithili speaker could be
answered in Hindi. Rejected outright, including as a consented option: answering someone in a
language they did not choose is a poor companion experience, and for Urdu speakers
specifically, replying in Hindi carries a meaning we should not assign on their behalf. A
clean "I can't speak that" is more respectful than a substitution.

### Route the gap to English — rejected

Same objection, plus it assumes English fluency in exactly the population least likely to
have it.

## Consequences

### Scoping the 12 out does not remove the need for a gate

**This is the highest-value line in the ADR.** The out-of-scope languages do not fail loudly.
Saaras transcribes them *accurately*, the LLM reasons over them, and only at synthesis does
the absence appear. Declaring them out of scope changes the product definition; it does not
change what the ASR will do when someone speaks Urdu into the microphone.

The gate belongs in the **ASR router**, keyed on Bulbul's 11-language matrix, and it fires at
three points — pre-connect, on the first detected language, and on any mid-session switch.
Full build specification: **[06-speakability-gate.md](../06-speakability-gate.md)**.

Its refusal telemetry is also how this ADR gets revisited: **refusals by language code** is the
direct evidence for whether losing Urdu cost more than expected.

### Degradation for a TTS outage

There is no second voice, so:

1. **Pre-rendered** holding phrases in the session language, synthesised ahead of time and
   stored as audio
2. Speak one, then close gracefully
3. Mark the session so the next open can acknowledge the gap

Pre-rendering is the load-bearing word: during a TTS outage there is by definition no way to
synthesise an apology.

### The TTS latency stage has no escape hatch

If Bulbul misses its time-to-first-audio budget, no provider switch recovers it
([03 §4.2](../03-latency-budget.md#42-tts-first-audio-runs-long-stage-7)). The response has to
be a product change — a shorter acknowledgement token, or an accepted slower cadence.

### Availability is single-vendor

Combined with [ADR 0006](0006-asr-provider-under-free-switching.md): a Hindi session has one
redundant stage (ASR). **Every other session has none.** State this to whoever owns the uptime
target.

### Watch items

- **Bulbul language additions.** Any new Bulbul language directly raises the product ceiling.
  The gap list above is the roadmap ask, with **Urdu first** on speaker population.
- **Deepgram Indic TTS.** Its Indic *STT* is expanding — Gujarati April 2026, Nepali and
  Punjabi August 2026 ([changelog](https://developers.deepgram.com/changelog)) — while Indic
  *TTS* has not moved. Do not extrapolate. But Aura-2 shipping Hindi would convert an accepted
  risk into a solved problem ([Q13](../05-open-questions.md#q13-will-deepgram-add-indic-tts)).
