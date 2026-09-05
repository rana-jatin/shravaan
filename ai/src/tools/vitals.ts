/**
 * Writing down a number somebody said, and reading it back.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ NEITHER TOOL EVER SAYS WHAT A READING MEANS, and every design decision in
 * this file follows from that. No "that's a bit high", no comparison to last
 * week, no trend, no normal range. The result the model receives is a number,
 * a unit and a time, because anything more would be handed to a language model
 * and spoken to an elderly person as medical advice within a turn.
 *
 * The judgement happens once, elsewhere: the safety service checks every
 * reading against its bands and raises an alert, and the escalation ladder asks
 * how the person is in reviewed copy. That is the only path by which this
 * product ever reacts to a vital sign.
 *
 * WHICH IS WHY `log_vital` DOES NOT REPORT THAT IT ALERTED. The service tells
 * us; we hand it to the capability through a callback and return nothing about
 * it, because a result field saying `alerted: true` is an invitation the model
 * will eventually accept.
 *
 * READING BACK IS DELIBERATELY SHALLOW. `recent_vitals` answers "what was my
 * blood pressure on Tuesday" and nothing larger. It is not a history, not an
 * export, and not a summary — a companion that could pull a month of somebody's
 * vitals into a prompt would eventually be asked to interpret them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { expandStored, parseReading, VITAL_KINDS, type Reading } from "../domain/vitals.ts";
import type { VitalsSink } from "../providers/elderguard.ts";
import type { ToolSpec } from "./registry.ts";
import { NETWORK_FILLER_MS, NETWORK_MS } from "./external.ts";

export const VITALS_CAPABILITY = "vitals";

export type VitalsDeps = {
  sink: VitalsSink;
  /**
   * Told when a stored reading raised an alert on the safety service.
   *
   * A CALLBACK RATHER THAN A RETURN VALUE, so the fact never reaches the model.
   * The capability uses it to start asking now instead of on the next poll,
   * which is the difference between a person hearing "how are you feeling?"
   * within seconds of reciting an alarming number and hearing it a minute
   * later for no visible reason.
   */
  onAlerted?: (uid: string) => void;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

export function createLogVital(deps: VitalsDeps): ToolSpec {
  return {
    name: "log_vital",
    description:
      "Record a health reading the user has just said out loud — pulse, oxygen, " +
      "temperature, blood pressure or blood sugar. Use it whenever they state a " +
      "number about their body. Report only that it was noted; never comment on " +
      "whether a reading is high, low or normal.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Which reading it is.",
          // Language-neutral tokens. See the note on `enum` in tools/types.ts:
          // the model reasons in Hindi about an English-described tool, and a
          // translated enum invites an answer validation would then reject.
          enum: [...VITAL_KINDS],
        },
        value: {
          type: "number",
          description: "The number. For blood pressure, the upper (systolic) one.",
        },
        second: {
          type: "number",
          description: "Blood pressure only: the lower (diastolic) number.",
        },
        unit: {
          type: "string",
          description:
            "Temperature only: 'c' or 'f'. Household thermometers are often " +
            "Fahrenheit — pass 'f' if the user said a number near 98.",
          enum: ["c", "f"],
        },
        context: {
          type: "string",
          description: "Blood sugar only: whether it was taken before or after eating.",
          enum: ["fasting", "after_meal", "unspecified"],
        },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    deadline_ms: NETWORK_MS,
    filler_threshold_ms: NETWORK_FILLER_MS,

    handler: async (args, ctx) => {
      const parsed = parseReading(args);
      // A DOMAIN OUTCOME, NOT AN ERROR. A person saying a number the device
      // cannot use is an ordinary conversational event; `ok: false` would cost
      // a spoken_fallback_key and eleven translations to say something the
      // model can say better itself. See the header of tools/builtin.ts.
      if (!parsed.ok) return { logged: false, reason: parsed.reason, kind: parsed.kind };

      const outcome = await deps.sink.record(ctx.uid, parsed.reading);
      if (!outcome.ok) {
        deps.log?.("warn", "vital not stored", { uid: ctx.uid, reason: outcome.reason });
        return { logged: false, reason: outcome.reason, kind: parsed.reading.kind };
      }

      if (outcome.alerted) deps.onAlerted?.(ctx.uid);

      // THE NUMBER IS NOT LOGGED. Same rule as the medication label: a value is
      // the whole of what makes this a health record, and an operator reading
      // server logs has no business seeing somebody's blood sugar.
      deps.log?.("info", "vital recorded", { uid: ctx.uid, kind: parsed.reading.kind });

      return { logged: true, ...describe(parsed.reading) };
    },
  };
}

export function createRecentVitals(deps: VitalsDeps): ToolSpec {
  return {
    name: "recent_vitals",
    description:
      "Look up the user's recently recorded health readings. Read them back as " +
      "numbers and times only — never say whether one is high, low, normal, " +
      "improving or worrying.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Optional. Narrow to one kind of reading.",
          enum: [...VITAL_KINDS],
        },
        limit: { type: "integer", description: "How many to return. Default 5, at most 20." },
      },
      required: [],
      additionalProperties: false,
    },
    deadline_ms: NETWORK_MS,
    filler_threshold_ms: NETWORK_FILLER_MS,

    handler: async (args, ctx) => {
      const wanted = String(args["kind"] ?? "").trim();
      const limit = clamp(Number(args["limit"] ?? 5), 1, 20);

      // Over-fetch, because one stored row can hold several metrics and the
      // filter runs after expanding them: asking for five blood pressures out
      // of rows that also carry a pulse would otherwise return two.
      const rows = await deps.sink.recent(ctx.uid, Math.min(100, limit * 4));
      const readings = expandStored(rows)
        .filter((r) => (wanted === "" ? true : r.kind === wanted))
        .slice(0, limit);

      return {
        found: readings.length,
        // Empty is an answer, not a failure. "Nothing has been recorded yet" is
        // a true and useful sentence, and the alternative — an error — would be
        // spoken as though something had gone wrong.
        readings,
      };
    },
  };
}

/** What the model is told about a reading it just stored. Numbers, nothing else. */
function describe(reading: Reading): Record<string, unknown> {
  return {
    kind: reading.kind,
    value: reading.value,
    ...(reading.second === undefined ? {} : { second: reading.second }),
    ...(reading.context === undefined ? {} : { context: reading.context }),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
