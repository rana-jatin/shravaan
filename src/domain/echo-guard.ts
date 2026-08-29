/**
 * Echo guard — decides whether a speech trigger is a real interruption or our
 * own voice coming back through the microphone.
 *
 * WHY THIS EXISTS. On an open-air device the mic hears the speaker. Without a
 * defence, the ASR transcribes our own output, `vad.speech_start` fires, the
 * orchestrator treats it as barge-in, flushes playback — and the agent
 * interrupts itself. In a loop. Every barge-in mechanism documented by either
 * provider assumes a telephony leg where the carrier already cancelled echo.
 * See docs/adr/0007-audio-front-end.md
 *
 * THIS IS NOT AEC AND DOES NOT REPLACE IT. Acoustic echo cancellation belongs on
 * the device, where the playback signal is available sample-aligned as a
 * reference. This is the second layer: cheap, provider-agnostic, and it catches
 * what leaks through. Ship both.
 *
 * Three defences, weakest to strongest:
 *
 *   1. SUPPRESSION WINDOW — ignore triggers for a short period after playback
 *      starts, covering the acoustic path plus device buffering.
 *
 *   2. CONFIRM ON TRANSCRIPT — require a non-empty partial before accepting,
 *      never a bare VAD trigger. This is Deepgram's own stated reasoning for
 *      preferring StartOfTurn over an external VAD: a transcript-backed signal is
 *      more reliable than raw energy. Sarvam says the same thing from the other
 *      direction — drive barge-in off speech_start or early partials, never
 *      transcript.final.
 *
 *   3. SELF-TEXT CORRELATION — compare the incoming partial against what we are
 *      currently saying. Echo transcribes as OUR OWN WORDS, which is a signal no
 *      energy-based method has access to. This is the one that catches leakage
 *      the other two miss.
 */

export type EchoGuardOptions = {
  /** Ignore triggers for this long after playback starts. */
  suppressionWindowMs: number;
  /**
   * Require a non-empty partial transcript before accepting barge-in, rather
   * than acting on a bare VAD trigger.
   */
  requireTranscript: boolean;
  /**
   * Token-overlap ratio above which an incoming partial is treated as our own
   * speech echoing back. 0 disables correlation.
   */
  selfEchoThreshold: number;
  /**
   * Emergency fallback from ADR 0007: mute barge-in entirely while speaking.
   * Removes the echo problem and removes interruption with it — a product
   * downgrade, to be used only if AEC proves intractable on the chosen hardware.
   */
  halfDuplex: boolean;
};

export const DEFAULT_ECHO_GUARD: EchoGuardOptions = {
  // Deliberately conservative to start. A bot that occasionally misses an
  // interruption is tolerable; one that interrupts itself is unusable. Tune
  // toward sensitivity only once AEC is measured on real hardware.
  suppressionWindowMs: 400,
  requireTranscript: true,
  selfEchoThreshold: 0.6,
  halfDuplex: false,
};

export type BargeInDecision =
  | { accept: true; reason: "confirmed" }
  | { accept: false; reason: "not_speaking" | "half_duplex" | "suppression_window" | "awaiting_transcript" | "self_echo"; detail?: string };

/** Lowercase, strip punctuation, collapse whitespace. Script-agnostic. */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:—…"'`()[\]{}।॥]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fraction of the incoming tokens that appear in our own recent speech.
 * Asymmetric on purpose: we ask "is what I just heard contained in what I am
 * saying", not "are these the same sentence". A partial is a fragment.
 */
export function selfEchoRatio(incoming: string, spoken: string): number {
  const inTokens = normalizeForComparison(incoming).split(" ").filter(Boolean);
  if (inTokens.length === 0) return 0;

  const spokenTokens = new Set(normalizeForComparison(spoken).split(" ").filter(Boolean));
  if (spokenTokens.size === 0) return 0;

  let hits = 0;
  for (const t of inTokens) if (spokenTokens.has(t)) hits++;
  return hits / inTokens.length;
}

export class EchoGuard {
  readonly #opts: EchoGuardOptions;
  #playbackStartedAt: number | null = null;
  /** Text handed to TTS for the current utterance — the correlation reference. */
  #spokenBuffer = "";
  #candidateAt: number | null = null;

  /** Counters for the slice-2 acceptance criterion and for tuning. */
  #stats = { accepted: 0, suppressed: 0, selfEcho: 0 };

  constructor(opts: Partial<EchoGuardOptions> = {}) {
    this.#opts = { ...DEFAULT_ECHO_GUARD, ...opts };
  }

  get stats(): Readonly<{ accepted: number; suppressed: number; selfEcho: number }> {
    return this.#stats;
  }

  get isSpeaking(): boolean {
    return this.#playbackStartedAt !== null;
  }

  /** Call when the first audio of a reply is dispatched to the device. */
  onPlaybackStart(now = Date.now()): void {
    this.#playbackStartedAt = now;
    this.#candidateAt = null;
  }

  /** Call for every chunk handed to TTS — builds the correlation reference. */
  onSpeakText(text: string): void {
    this.#spokenBuffer = `${this.#spokenBuffer} ${text}`.slice(-2000);
  }

  /** Call when playback drains or the turn is abandoned. */
  onPlaybackEnd(): void {
    this.#playbackStartedAt = null;
    this.#spokenBuffer = "";
    this.#candidateAt = null;
  }

  /**
   * A bare VAD trigger. Never sufficient on its own when `requireTranscript` is
   * set — it only opens a candidacy that a partial must confirm.
   */
  onSpeechStart(now = Date.now()): BargeInDecision {
    if (!this.isSpeaking) return { accept: true, reason: "confirmed" };

    if (this.#opts.halfDuplex) {
      this.#stats.suppressed++;
      return { accept: false, reason: "half_duplex" };
    }

    const elapsed = now - this.#playbackStartedAt!;
    if (elapsed < this.#opts.suppressionWindowMs) {
      this.#stats.suppressed++;
      return {
        accept: false,
        reason: "suppression_window",
        detail: `${elapsed}ms into playback, window is ${this.#opts.suppressionWindowMs}ms`,
      };
    }

    if (this.#opts.requireTranscript) {
      this.#candidateAt = now;
      return { accept: false, reason: "awaiting_transcript" };
    }

    this.#stats.accepted++;
    return { accept: true, reason: "confirmed" };
  }

  /**
   * A partial transcript. This is where barge-in is actually confirmed — and
   * where echo is caught, because our own voice comes back as our own words.
   */
  onPartial(text: string, now = Date.now()): BargeInDecision {
    if (!this.isSpeaking) return { accept: true, reason: "confirmed" };
    if (this.#opts.halfDuplex) {
      this.#stats.suppressed++;
      return { accept: false, reason: "half_duplex" };
    }
    if (text.trim() === "") return { accept: false, reason: "awaiting_transcript" };

    const elapsed = now - this.#playbackStartedAt!;
    if (elapsed < this.#opts.suppressionWindowMs) {
      this.#stats.suppressed++;
      return { accept: false, reason: "suppression_window" };
    }

    if (this.#opts.selfEchoThreshold > 0 && this.#spokenBuffer.trim() !== "") {
      const ratio = selfEchoRatio(text, this.#spokenBuffer);
      if (ratio >= this.#opts.selfEchoThreshold) {
        this.#stats.selfEcho++;
        return {
          accept: false,
          reason: "self_echo",
          detail: `${Math.round(ratio * 100)}% of tokens match our own speech`,
        };
      }
    }

    this.#candidateAt = null;
    this.#stats.accepted++;
    return { accept: true, reason: "confirmed" };
  }

  reset(): void {
    this.onPlaybackEnd();
    this.#stats = { accepted: 0, suppressed: 0, selfEcho: 0 };
  }
}
