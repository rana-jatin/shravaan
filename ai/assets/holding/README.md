# Pre-rendered holding audio

**This directory is empty on purpose, and that is a gap, not a design choice.**

Bulbul is the only voice in this system and there is no Indic TTS failover anywhere in either
provider ([ADR 0005](../../docs/adr/0005-tts-provider-split.md)). When it goes, the one
message worth saying is the one message that cannot be synthesised — so it has to be rendered
ahead of time.

```bash
npm run render:holding
```

That needs a live `SARVAM_API_KEY` and a **working** Bulbul. You cannot generate these files
during the outage they exist for, which is the entire point and also the easiest thing in this
repo to put off until it is too late.

## What lands here

```
manifest.json                              sample rate, encoding, speaker, timestamp
degraded.voice_unavailable.hi-IN.pcm       headerless linear16, mono, at TTS_SAMPLE_RATE
degraded.voice_unavailable.en-IN.pcm
…                                          one per speakable language with reviewed copy
```

Raw PCM rather than WAV, byte-identical to what Bulbul streams, so the device playback path
needs no special case.

## Rules

- **Commit the output.** It is a release artefact, not a build product — the build that would
  regenerate it is exactly the one that cannot run during an incident.
- **Regenerate whenever `TTS_SPEAKER` or the copy in `src/copy/refusals.ts` changes.** A stale
  clip means the outage apology arrives in a different voice from the rest of the
  conversation, which is its own small horror.
- **Regenerate if `TTS_SAMPLE_RATE` changes.** The loader refuses a mismatch rather than
  playing it, because wrong-rate PCM is a chipmunk apology and that is worse than silence.
- **Only reviewed copy is rendered.** The script skips anything still flagged
  `needsNativeReview`, so today it will produce `en-IN` and `hi-IN` and report the other nine
  as skipped. Those languages fall down the refusal ladder to Hindi during an outage.

## Until this is populated

A Bulbul outage closes the session **in silence**. The server logs
`no pre-rendered audio — closing in silence` at error level, because that line is the only
trace the user's experience will leave.
