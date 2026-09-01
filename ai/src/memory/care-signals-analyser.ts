/**
 * The one place the gate, the call and the mapping happen in order.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS HERE AND NOWHERE ELSE.
 *
 * The memory worker is already off the turn path by construction — it consumes
 * `mem:writes` in its own loop, minutes to hours after the person stopped
 * talking (docs/01-architecture.md §7). That is the only place in this system
 * where a third-party round trip can cost nothing a user can perceive.
 *
 * The voice path never calls Deepgram for this. Not on a turn, not on session
 * close, not behind a filler. `recall_mood` reads what this already wrote, from
 * the local store, and if it has not been written yet the tool says so. A
 * companion that pauses mid-conversation to have its user's mood scored by an
 * American API is the wrong product, and it would also blow the latency budget
 * in docs/03-latency-budget.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE DEADLINE IS THE POINT OF THE TRY/CATCH. Consumer lag is a user-visible
 * quality metric here, not queue trivia: a worker stuck on a slow HTTP call is a
 * companion that has not caught up on yesterday. So the call is bounded, and
 * every failure — timeout, 400, 500, garbage body — resolves to `null`, which
 * means "this episode has no signals" and nothing else. The episode is written
 * either way.
 *
 * ⚠ WHY NOT ATTACH SIGNALS AFTERWARDS. Episodes are append-only and never edited
 * (docs/02-data-contracts.md §4.2) — that invariant is what makes "three weeks
 * ago you said…" answerable. So the analysis has to finish before the episode is
 * written, or not be part of it. Bounded-and-before beats a second mutable
 * record of what happened.
 */

import type { CareSignals, LanguageCode, MemWriteEvent } from "@sp-i/shared/domain/types.ts";
import {
  CARE_INTENTS,
  analysable,
  toCareSignals,
  userTranscript,
  type Analysability,
} from "../domain/care-signals.ts";
import type { TextAnalyser } from "../providers/deepgram-read.ts";

/**
 * What the worker depends on. A function, not a class: everything it needs is in
 * the arguments, and a test substitutes it with two lines.
 */
export type SignalsAnalyser = (input: {
  events: readonly MemWriteEvent[];
  languages: readonly LanguageCode[];
}) => Promise<CareSignals | null>;

export type AnalyserOptions = {
  /** Hard cap on the round trip. Past this the episode is written without signals. */
  deadlineMs: number;
  /** Confidence floor for a watch-list intent. See mapIntents — the number is a guess. */
  intentConfidence: number;
  /** Skip anything shorter than this, in words. */
  minWords?: number;
  /** Reports the gate's verdict, including the refusals. Never user-facing. */
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
};

export function createCareSignalsAnalyser(
  read: TextAnalyser,
  opts: AnalyserOptions,
): SignalsAnalyser {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());

  return async ({ events, languages }) => {
    const text = userTranscript(events);
    const verdict: Analysability = analysable(languages, text, opts.minWords);

    if (!verdict.ok) {
      // Logged at info, not warn. Nine of our eleven languages will land here on
      // every single session, forever — that is the documented shape of the
      // feature (ADR 0009), not an incident.
      log("info", "care signals skipped", { reason: verdict.reason, languages });
      return null;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), opts.deadlineMs);
    timer.unref?.();

    try {
      const raw = await read.analyse({
        text: verdict.text,
        sentiment: true,
        intents: true,
        customIntents: [...CARE_INTENTS],
        // Strict: only our reviewed list comes back. See CARE_INTENTS.
        customIntentMode: "strict",
        signal: abort.signal,
      });

      const signals = toCareSignals(raw, {
        intentConfidence: opts.intentConfidence,
        analysedAt: now().toISOString(),
      });

      log("info", "care signals analysed", {
        found: signals !== null,
        flagged: signals?.flagged_intents?.length ?? 0,
      });
      return signals;
    } catch (err) {
      // Deliberately terminal. No retry, no queue: a session whose analysis
      // failed simply has none, and the next session is a fresh chance at the
      // trend. Retrying inside the worker would trade a missing data point for
      // consumer lag, and lag is the metric that costs the user something.
      log("warn", "care signals unavailable", {
        aborted: abort.signal.aborted,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
