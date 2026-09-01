/**
 * `recall_mood` — how the last few conversations have been going.
 *
 * Split out of tools/builtin.ts. Unlike weather and news this one never leaves
 * the process, so tools/external.ts does not apply to it; it is a factory for
 * the separate reason set out below.
 */

import type { ToolSpec } from "./registry.ts";
import { STORE_MS } from "./types.ts";

/**
 * `recall_mood` — how the last few conversations have been going.
 *
 * A FACTORY FOR A DIFFERENT REASON THAN THE TWO ABOVE. Weather and news are
 * factories because they leave the process. This one never does: it reads
 * episodes the memory worker already wrote (src/memory/care-signals-analyser.ts),
 * so it costs a store hit and nothing else, on any turn, in any language.
 *
 * It is a factory because the signals it reads only exist where a deployment
 * turned the analysis on. Registering it regardless would give the model a tool
 * that always answers "nothing recorded" — the offer-then-withdraw failure the
 * divider above and registry.ts both exist to prevent.
 *
 * ⚠ WHAT THE MODEL IS ALLOWED TO DO WITH THIS. The numbers are a third party's
 * score of English words, not a reading of how someone is (src/domain/care-signals.ts).
 * So the description below tells the model to speak in ordinary language and
 * never to diagnose, and the returned shape deliberately carries a coarse
 * direction rather than a chart. "You've sounded a bit quieter this week, is
 * everything all right?" is the ceiling of what this may become out loud.
 *
 * ⚠ AND IT ONLY EVER KNOWS ABOUT ENGLISH SESSIONS. `sessions` is the number
 * ANALYSED, not the number the person had — a user who speaks Hindi on Tuesday
 * and English on Wednesday has one analysed session that week. The model is told
 * to say so rather than imply it watched the whole week.
 */
export function createRecallMood(deps: { window?: number } = {}): ToolSpec {
  // Two weeks of daily use, which is enough for a direction without reaching so
  // far back that a bad fortnight in March colours today.
  const window = deps.window ?? 14;

  return {
    name: "recall_mood",
    description:
      "Look up how the user's recent conversations have been going, when they ask " +
      "how they have been lately or you are asked to reflect on the last few days. " +
      "Speak in ordinary, gentle language — never quote the numbers, never diagnose, " +
      "and never present this as a measurement of the person. If it covers fewer " +
      "sessions than they have had, say you are only going on some of them.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    deadline_ms: STORE_MS,
    handler: async (_args, ctx) => {
      const trend = await ctx.host.recentMood(window);
      // Domain outcome, not an error: nothing analysed yet is the normal state
      // of a new device and of every non-English deployment.
      return trend === null
        ? { analysed: 0, reason: "nothing_recorded" }
        : { analysed: trend.sessions, ...trend };
    },
  };
}
