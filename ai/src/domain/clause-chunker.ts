/**
 * Splits streamed LLM tokens into clause-sized chunks for the TTS socket.
 *
 * This is the single largest structural latency win in the design: first audio
 * depends on the first clause, not on the full completion.
 *
 * Sarvam recommends under 500 characters per WebSocket message, with a hard cap
 * of 2500. We aim far lower — a first chunk of a few words is what makes the
 * latency budget conceivable at all.
 *
 * Spec: docs/03-latency-budget.md section 6
 */

/** Devanagari danda and double danda, plus Latin sentence enders. */
const STRONG_BOUNDARY = /[।॥.!?]/;
const WEAK_BOUNDARY = /[,;:—]/;

export type ChunkerOptions = {
  /** Emit the first chunk as early as this many characters. Latency-critical. */
  firstChunkMinChars: number;
  /** Steady-state target. */
  minChars: number;
  /** Hard flush even without a boundary, to bound worst-case latency. */
  maxChars: number;
  /**
   * Floor for a STRONG boundary (sentence end / danda).
   *
   * A completed sentence is released as soon as it exists, regardless of the
   * min-chars targets: "Namaste!" is a whole utterance at 8 characters and
   * holding it back to reach an arbitrary length is pure added latency on the
   * one chunk where latency matters most. The targets below exist to stop us
   * emitting ragged fragments at weak boundaries, not to delay finished
   * sentences. Only guards against emitting stray punctuation alone.
   */
  strongBoundaryMinChars: number;
};

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  firstChunkMinChars: 12,
  minChars: 60,
  maxChars: 240,
  strongBoundaryMinChars: 3,
};

export class ClauseChunker {
  #buffer = "";
  #emittedFirst = false;
  readonly #opts: ChunkerOptions;

  constructor(opts: Partial<ChunkerOptions> = {}) {
    this.#opts = { ...DEFAULT_CHUNKER_OPTIONS, ...opts };
  }

  /** Feed streamed text. Returns zero or more chunks ready to synthesise. */
  push(text: string): string[] {
    this.#buffer += text;
    const out: string[] = [];

    for (;;) {
      const chunk = this.#tryTake();
      if (chunk === null) break;
      out.push(chunk);
    }
    return out;
  }

  /** Flush whatever remains at end of turn. */
  flush(): string | null {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    this.#emittedFirst = rest.length > 0 || this.#emittedFirst;
    return rest.length > 0 ? rest : null;
  }

  reset(): void {
    this.#buffer = "";
    this.#emittedFirst = false;
  }

  #minChars(): number {
    return this.#emittedFirst ? this.#opts.minChars : this.#opts.firstChunkMinChars;
  }

  #tryTake(): string | null {
    // A finished sentence goes out immediately, whatever the length targets say.
    const strong = this.#findBoundary(this.#buffer.length, STRONG_BOUNDARY);
    if (strong !== null && strong >= this.#opts.strongBoundaryMinChars) {
      return this.#take(strong);
    }

    // Hard cap: emit even without a clean boundary rather than stall.
    if (this.#buffer.length >= this.#opts.maxChars) {
      const fallback =
        this.#findBoundary(this.#opts.maxChars, WEAK_BOUNDARY) ??
        this.#findWordSplit(this.#opts.maxChars) ??
        this.#opts.maxChars;
      return this.#take(fallback);
    }

    // Weak boundaries and word splits must clear the length target, so we do not
    // dribble out ragged fragments.
    const min = this.#minChars();
    if (this.#buffer.length < min) return null;

    const idx =
      this.#findBoundary(this.#buffer.length, WEAK_BOUNDARY) ??
      this.#findWordSplit(this.#buffer.length);
    if (idx === null || idx < min) return null;
    return this.#take(idx);
  }

  /** Index just past the last matching boundary char at or before `limit`. */
  #findBoundary(limit: number, pattern: RegExp): number | null {
    const window = this.#buffer.slice(0, limit);
    for (let i = window.length - 1; i >= 0; i--) {
      if (pattern.test(window[i]!)) return i + 1;
    }
    return null;
  }

  /** Fall back to a word boundary so we never split mid-word. */
  #findWordSplit(limit: number): number | null {
    const space = this.#buffer.slice(0, limit).lastIndexOf(" ");
    return space > 0 ? space : null;
  }

  #take(idx: number): string {
    const chunk = this.#buffer.slice(0, idx).trim();
    this.#buffer = this.#buffer.slice(idx);
    if (chunk.length === 0) return "";
    this.#emittedFirst = true;
    return chunk;
  }
}
