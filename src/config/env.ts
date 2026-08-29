/**
 * Environment configuration, validated once at boot.
 *
 * Audio rates are NOT free choices. Sarvam's realtime STT socket accepts only
 * 8000 or 16000 and closes with code 4000 otherwise; Bulbul streaming is capped
 * at 24 kHz. Those constraints are enforced here rather than discovered at
 * runtime as a dropped connection.
 */

const ASR_ALLOWED_RATES = [8000, 16000] as const;
const TTS_MAX_STREAMING_RATE = 24000;

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env.`);
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const asrSampleRate = num("ASR_SAMPLE_RATE", 16000);
  const ttsSampleRate = num("TTS_SAMPLE_RATE", 24000);

  if (!ASR_ALLOWED_RATES.includes(asrSampleRate as 8000 | 16000)) {
    throw new Error(
      `ASR_SAMPLE_RATE must be 8000 or 16000 (Sarvam closes the socket with code 4000 ` +
        `otherwise). Got ${asrSampleRate}.`,
    );
  }
  if (ttsSampleRate > TTS_MAX_STREAMING_RATE) {
    throw new Error(
      `TTS_SAMPLE_RATE must be <= ${TTS_MAX_STREAMING_RATE} — Bulbul streaming is capped ` +
        `at 24 kHz. Got ${ttsSampleRate}.`,
    );
  }

  return {
    sarvamApiKey: req("SARVAM_API_KEY"),

    // NOTE: these bases come from Sarvam's guide pages. The API-reference pages
    // that would confirm exact hostnames returned 404 during research
    // (docs/05-open-questions.md Q12). Verify before first run.
    apiBase: opt("SARVAM_API_BASE", "https://api.sarvam.ai"),
    wsBase: opt("SARVAM_WS_BASE", "wss://api.sarvam.ai"),

    asrModel: opt("SARVAM_ASR_MODEL", "saaras:v3-realtime"),
    ttsModel: opt("SARVAM_TTS_MODEL", "bulbul:v3"),
    llmModel: opt("SARVAM_LLM_MODEL", "sarvam-105b"),

    asrSampleRate,
    ttsSampleRate,
    deviceFrameMs: num("DEVICE_FRAME_MS", 80),

    ttsSpeaker: opt("TTS_SPEAKER", "Shubh"),
    ttsPace: num("TTS_PACE", 1.0),

    defaultSeedLanguage: opt("DEFAULT_SEED_LANGUAGE", "hi-IN"),
    /**
     * Sarvam's docs disagree on this token: "auto" (realtime page) vs "unknown"
     * (Saaras page and the agent product) vs explicit-required (streaming
     * guide). Slice 0 must establish which the socket actually accepts.
     * docs/05-open-questions.md Q1
     */
    asrAutodetectToken: opt("ASR_AUTODETECT_TOKEN", "unknown"),

    /**
     * Echo guard. NOT a substitute for device-side AEC — the second layer that
     * catches what leaks through. See docs/adr/0007-audio-front-end.md
     *
     * Defaults are deliberately conservative: a bot that occasionally misses an
     * interruption is tolerable, one that interrupts itself is unusable. Tune
     * toward sensitivity only once AEC is measured on real hardware.
     */
    echoGuard: {
      suppressionWindowMs: num("ECHO_SUPPRESSION_MS", 400),
      requireTranscript: opt("ECHO_REQUIRE_TRANSCRIPT", "true") !== "false",
      selfEchoThreshold: num("ECHO_SELF_THRESHOLD", 0.6),
      /** Emergency fallback from ADR 0007: mutes barge-in entirely. */
      halfDuplex: opt("HALF_DUPLEX", "false") === "true",
    },

    /**
     * Working memory. Unset means an in-process store — fine for a single
     * instance and for development, useless across restarts or replicas.
     * A store outage is survivable by design: the session continues stateless
     * and marks itself degraded.
     */
    redisUrl: process.env["REDIS_URL"]?.trim() || null,

    // --- Degradation (slice 8) ------------------------------------------------

    /**
     * ASR failover to Deepgram Flux. Covers `hi-IN` and `en-IN` ONLY; nine of our
     * eleven languages have no second ASR at all.
     *
     * OFF BY DEFAULT, AND NOT BECAUSE OF THE COVERAGE GAP.
     *
     * Sarvam's pitch includes "Data residency in India"
     * (https://docs.sarvam.ai/conversations/overview.md). Deepgram publishes EU
     * and AU endpoints and **no India region**
     * (https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available).
     * So an automatic failover quietly relocates a user's voice out of the
     * country, mid-conversation, as an incident-response side effect. That is a
     * decision for whoever owns the data-protection posture, not a default.
     * See docs/05-open-questions.md Q14.
     */
    asrFailoverEnabled: opt("ASR_FAILOVER_ENABLED", "false") === "true",
    deepgramApiKey: process.env["DEEPGRAM_API_KEY"]?.trim() || null,
    deepgramWsBase: opt("DEEPGRAM_WS_BASE", "wss://api.deepgram.com"),
    /** Flux Multilingual: the only Deepgram streaming model that reaches Hindi. */
    deepgramModel: opt("DEEPGRAM_ASR_MODEL", "flux-general-multi"),

    /**
     * Pre-rendered apology audio for a Bulbul outage. Generated ahead of time by
     * `npm run render:holding` — you cannot render it during the outage it exists
     * for. See src/audio/holding-audio.ts
     */
    holdingAudioDir: opt("HOLDING_AUDIO_DIR", "assets/holding"),

    /**
     * Bounded in-process buffer for `mem:writes` when the stream is unreachable.
     * Overflow drops the oldest low-priority event and counts it — the decision
     * docs/02-data-contracts.md section 6 left open, resolved in ADR 0008.
     */
    memWriteBufferCapacity: num("MEM_WRITE_BUFFER", 500),

    port: num("PORT", 8080),
    logLevel: opt("LOG_LEVEL", "info"),
  };
}
