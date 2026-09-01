/**
 * Where the silence before a reply actually goes.
 *
 * `docs/03-latency-budget.md` §5 is titled "What must be measured before this is
 * a budget", and until now nothing measured it: the only duration recorded
 * anywhere on the turn path was `elapsed_ms` for a tool call. So "it feels
 * slower" could be ASR endpointing, LLM first token, our own chunker or TTS
 * first audio — four different problems with four different fixes, and no way
 * to tell them apart from a log.
 *
 * This records the four server-side rows of the budget table and nothing else.
 *
 * WHAT IT CANNOT SEE, and why the total here is not what the user experiences:
 * stages 1, 2 and 8 — device capture, both network hops, and playback priming —
 * happen off this process. `gap_ms` is the server's share of the silence,
 * roughly 545 ms of the 945 ms estimate. A device-side number has to come from
 * the device.
 *
 * Pure on purpose: marks in, a report out, no logging and no clock of its own
 * unless one is handed to it. That is what makes the budget assertions in
 * test/turn-timer.test.ts possible without a session.
 */

/** The points we can observe, in the order they must occur. */
export type TurnStage =
  /** ASR handed us a final transcript. The user has stopped talking. */
  | "asr_final"
  /** The LLM request is about to go out — everything before it is our own work. */
  | "llm_sent"
  /** First content token back. The model has started answering. */
  | "llm_first_token"
  /** First clause handed to TTS. The chunker's whole reason for existing. */
  | "first_clause"
  /** First audio dispatched to the device. The silence ends here. */
  | "first_audio";

/**
 * Server-side rows of the budget in docs/03-latency-budget.md §3.
 *
 * `prepare_ms` is row 4 (a pipelined Redis read, 5 ms) plus the lock and turn
 * append that surround it — the only row here that is entirely ours and the
 * only one with a high-confidence source.
 */
export const BUDGET_MS = {
  prepare_ms: 5,
  llm_ttft_ms: 250,
  clause_ms: 40,
  tts_ttfa_ms: 250,
} as const;

export type TurnTiming = {
  /** asr_final → llm_sent. Lock, turn append, state persist, message build. */
  prepare_ms: number;
  /** llm_sent → llm_first_token. Sarvam publishes no figure for this. */
  llm_ttft_ms: number;
  /** llm_first_token → first_clause. Our chunker. */
  clause_ms: number;
  /** first_clause → first_audio. Sarvam publishes no figure for this either. */
  tts_ttfa_ms: number;
  /** asr_final → first_audio. The server's share of the silence. */
  gap_ms: number;
  /** Stages over their budgeted allowance, worst first. Empty is the good case. */
  over_budget: string[];
};

export class TurnTimer {
  readonly #marks = new Map<TurnStage, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * FIRST WRITE WINS, which is the whole contract.
   *
   * `llm_first_token` and `first_clause` are marked from inside the streaming
   * callback, so they fire on every delta; a mark that overwrote would report
   * the last token of the reply rather than the first, and the first is the one
   * the user is waiting on.
   */
  mark(stage: TurnStage): void {
    if (!this.#marks.has(stage)) this.#marks.set(stage, this.#now());
  }

  /** Null until the turn actually reached audio. A refused or barged-in turn never does. */
  report(): TurnTiming | null {
    const at = (s: TurnStage) => this.#marks.get(s);
    const final = at("asr_final");
    const sent = at("llm_sent");
    const token = at("llm_first_token");
    const clause = at("first_clause");
    const audio = at("first_audio");
    if (
      final === undefined ||
      sent === undefined ||
      token === undefined ||
      clause === undefined ||
      audio === undefined
    ) {
      return null;
    }

    const timing = {
      prepare_ms: sent - final,
      llm_ttft_ms: token - sent,
      clause_ms: clause - token,
      tts_ttfa_ms: audio - clause,
      gap_ms: audio - final,
    };

    const over = (Object.keys(BUDGET_MS) as Array<keyof typeof BUDGET_MS>)
      .filter((k) => timing[k] > BUDGET_MS[k])
      .sort((a, b) => timing[b] - BUDGET_MS[b] - (timing[a] - BUDGET_MS[a]))
      .map((k) => `${k}=${timing[k]}ms>${BUDGET_MS[k]}ms`);

    return { ...timing, over_budget: over };
  }
}
