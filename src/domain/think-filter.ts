/**
 * Keeps a model's private reasoning out of the user's ears.
 *
 * `sarvam-105b` is a reasoning model. It is *supposed* to keep its thinking in
 * the `reasoning_content` delta field, and mostly it does — but it was observed
 * emitting a literal `</think>` followed by several hundred words of internal
 * monologue into `content`, the field we speak:
 *
 *   "I'll remember that your mother is called Sharada.\n\nWait, I need to make
 *    sure the sentence is short and conversational. And I should avoid markdown.
 *    Actually, I can just say: …</think>\nLet me check the time."
 *
 * Spoken aloud, that is the bot thinking out loud at a person who asked it the
 * time. We now default to `sarvam-105b-conversations`, which emits no reasoning
 * at all (ADR 0003) — so this is a guard against a model swap, not a live bug.
 * It is here because the failure is silent, arrives as plausible prose, and one
 * env var is all that stands between us and it.
 *
 * ## What it can and cannot do
 *
 * A well-formed `<think>…</think>` span is removed in full: nothing inside is
 * ever yielded.
 *
 * A **bare closing tag** — reasoning, then `</think>`, then the answer, with no
 * opener — cannot be fully repaired in a stream. By the time the tag arrives we
 * have already handed the reasoning downstream and TTS may already be speaking
 * it. We suppress the tag itself, and warn loudly, because a warning is the only
 * honest response to having already said the wrong thing. Buffering the whole
 * completion would fix it and would also cost the entire first-clause latency
 * win the chunker exists for, which is a bad trade at the frequency this occurs.
 *
 * ## Why it is stateful
 *
 * Tags arrive split across SSE deltas — `</th` in one frame and `ink>` in the
 * next — so a per-chunk regex would pass the halves through untouched and speak
 * them. Anything that could still become a tag is held back until the next chunk
 * proves otherwise, and released by `flush()` if the stream ends first.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/** Longest tail we might need to hold: one character short of a complete tag. */
const MAX_HOLD = Math.max(OPEN.length, CLOSE.length) - 1;

export type ThinkFilterEvents = {
  /** A bare `</think>` arrived: reasoning has already been spoken. */
  onStrayClose?: () => void;
};

export class ThinkFilter {
  #inThink = false;
  /** A tail that is a viable prefix of a tag, withheld pending the next chunk. */
  #hold = "";
  readonly #events: ThinkFilterEvents;

  constructor(events: ThinkFilterEvents = {}) {
    this.#events = events;
  }

  /** True while inside a `<think>` span — for diagnostics, not control flow. */
  get thinking(): boolean {
    return this.#inThink;
  }

  /** Feed one delta; returns only what is safe to speak. */
  push(chunk: string): string {
    let text = this.#hold + chunk;
    this.#hold = "";
    let out = "";

    for (;;) {
      if (this.#inThink) {
        const end = text.indexOf(CLOSE);
        if (end === -1) {
          // Still inside. Discard, but keep any tail that could be the start of
          // the closing tag — otherwise a split `</thi|nk>` never matches and we
          // stay inside the span for the rest of the completion.
          this.#hold = tagPrefixTail(text);
          return out;
        }
        text = text.slice(end + CLOSE.length);
        this.#inThink = false;
        continue;
      }

      const open = text.indexOf(OPEN);
      const close = text.indexOf(CLOSE);

      // A closing tag reached before any opener is the unrepairable case: the
      // reasoning ahead of it has already gone downstream.
      if (close !== -1 && (open === -1 || close < open)) {
        out += text.slice(0, close);
        text = text.slice(close + CLOSE.length);
        this.#events.onStrayClose?.();
        continue;
      }

      if (open === -1) {
        // Hold back anything that might yet become a tag; speak the rest.
        const keep = tagPrefixTail(text);
        out += keep === "" ? text : text.slice(0, text.length - keep.length);
        this.#hold = keep;
        return out;
      }

      out += text.slice(0, open);
      text = text.slice(open + OPEN.length);
      this.#inThink = true;
    }
  }

  /**
   * End of stream. Releases a held tail that never became a tag.
   *
   * Text still inside an unterminated `<think>` is dropped, not spoken: an
   * opener with no closer means the model was thinking when the stream ended,
   * and the last thing to do with that is say it out loud.
   */
  flush(): string {
    const tail = this.#inThink ? "" : this.#hold;
    this.#hold = "";
    this.#inThink = false;
    return tail;
  }

  reset(): void {
    this.#hold = "";
    this.#inThink = false;
  }
}

/**
 * The longest tail of `s` that is a proper prefix of either tag.
 *
 * `"…and then</thi"` returns `"</thi"`; `"…and then<"` returns `"<"`; ordinary
 * prose returns `""`. Only a tail starting at `<` can matter, so the scan is
 * bounded by tag length rather than by the length of the text.
 */
function tagPrefixTail(s: string): string {
  const start = Math.max(0, s.length - MAX_HOLD);
  for (let i = start; i < s.length; i++) {
    if (s[i] !== "<") continue;
    const tail = s.slice(i);
    if (OPEN.startsWith(tail) || CLOSE.startsWith(tail)) return tail;
  }
  return "";
}
