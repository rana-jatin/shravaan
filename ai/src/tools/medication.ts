/**
 * The four things a person can say about their tablets.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY OUTCOME HERE IS DATA. "There was nothing waiting to confirm" and "none
 * of those were times" are successes with a reason, not `ok: false` — the rule
 * in tools/builtin.ts, and it matters more here than anywhere: this is the one
 * tool family a confused or unwell person will use wrong, and an error result
 * costs a `spoken_fallback_key` and eleven translations to say something the
 * model could have said better itself.
 *
 * THE LABEL IS THE USER'S WORDS, KEPT VERBATIM. "the blue tablet", "my sugar
 * medicine", "Ecosprin". Nothing here matches it against a drug list, corrects
 * a spelling or infers a dose, and nothing downstream does either — the device
 * repeats what it was told. Recognising medications would make this a system
 * that gives medical advice, which is a different product with different
 * obligations and no consent from anybody here.
 *
 * ⚠ AND THERE IS NO ADHERENCE RECORD. `confirm_medication` closes an open
 * reminder and the record is deleted. It does not write "took it at 08:04"
 * anywhere, so "did I take my tablet on Tuesday" has no answer, deliberately —
 * the same rule as game scores, and for the same reason. See the note on
 * `EscalationStore`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";
import { acknowledgeOpen } from "../escalation/acknowledge.ts";
import type { EscalationStore } from "../escalation/types.ts";
import { isValidTimeZone, parseWallClock } from "../scheduler/timezone.ts";
import type { Schedule, ScheduleStore, Weekday } from "../scheduler/types.ts";
import type { ToolSpec } from "./registry.ts";
import { STORE_MS } from "./types.ts";

export const MEDICATION_CAPABILITY = "medication";

export type MedicationDeps = {
  schedules: ScheduleStore;
  escalations: EscalationStore;
  /** See `MEDICATION_MAX_PER_USER` — a speech limit, not a storage one. */
  maxPerUser: number;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

/** A label the model can hand back, without deciding two spellings are one drug. */
function normalise(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

/** For matching an existing reminder. Case and spacing only — never spelling. */
function matchKey(label: string): string {
  return normalise(label).toLowerCase();
}

function medicationSchedules(all: Schedule[]): Schedule[] {
  return all.filter((s) => s.capability === MEDICATION_CAPABILITY);
}

function labelOf(schedule: Schedule): string {
  const label = schedule.payload["label"];
  return typeof label === "string" ? label : "your medication";
}

export function createSetMedicationReminder(deps: MedicationDeps): ToolSpec {
  return {
    name: "set_medication_reminder",
    description:
      "Set a recurring reminder for a medication the user names. Times are 24-hour " +
      "HH:MM in the user's own timezone. Use the user's own words for the label — " +
      "do not correct, expand or translate them. Setting a reminder for a label that " +
      "already exists replaces it.",
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "What the user calls it, in their words: 'the blue tablet'.",
        },
        times: {
          type: "array",
          description: "24-hour times, e.g. ['08:00','20:00'].",
          items: { type: "string" },
        },
        days: {
          type: "array",
          description:
            "Optional. Weekdays as integers, 0 = Sunday. Omit for every day, " +
            "which is what almost every medication is.",
          items: { type: "integer" },
        },
      },
      required: ["label", "times"],
      additionalProperties: false,
    },
    deadline_ms: STORE_MS,

    handler: async (args, ctx) => {
      const label = normalise(String(args["label"] ?? ""));
      if (label === "") return { set: false, reason: "no_label" };

      const rawTimes = Array.isArray(args["times"]) ? args["times"] : [];
      const times: string[] = [];
      const rejected: string[] = [];
      for (const value of rawTimes) {
        const text = String(value).trim();
        const parsed = parseWallClock(text);
        // Padded on the way in, so "8:00" and "08:00" cannot become two
        // reminders for the same moment.
        if (parsed) {
          times.push(
            `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`,
          );
        } else rejected.push(text);
      }

      const unique = [...new Set(times)].sort();
      if (unique.length === 0) return { set: false, reason: "no_valid_times", rejected };

      const days = readDays(args["days"]);

      // The user's zone, not the server's. A local 08:00 treated as UTC fires at
      // half past one in the morning in India.
      const timezone = ctx.host.timezone();
      if (!isValidTimeZone(timezone)) return { set: false, reason: "unknown_timezone", timezone };

      const mine = medicationSchedules(await deps.schedules.forUser(ctx.uid));
      const existing = mine.find((s) => matchKey(labelOf(s)) === matchKey(label));

      if (!existing && mine.length >= deps.maxPerUser) {
        // Refused rather than accepted-and-ignored. A cap the user cannot see
        // is a reminder they believe is set.
        return { set: false, reason: "too_many", limit: deps.maxPerUser, current: mine.length };
      }

      const schedule: Schedule = {
        id: existing?.id ?? randomUUID(),
        uid: ctx.uid,
        capability: MEDICATION_CAPABILITY,
        // The label is kept as the user said it, and is what gets spoken back.
        payload: { label },
        timezone,
        recurrence: { kind: "daily", times: unique, ...(days ? { days } : {}) },
        enabled: true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };

      await deps.schedules.put(schedule);
      deps.log?.("info", "medication reminder set", {
        uid: ctx.uid,
        times: unique,
        days: days ?? "every day",
        replaced: Boolean(existing),
        // The LABEL IS NOT LOGGED. What somebody takes is the most sensitive
        // thing this capability touches, and a log line is the easiest place
        // for it to end up somewhere nobody consented to.
      });

      return {
        set: true,
        label,
        times: unique,
        ...(days ? { days } : {}),
        replaced: Boolean(existing),
        ...(rejected.length > 0 ? { ignored: rejected } : {}),
      };
    },
  };
}

export function createListMedicationReminders(deps: MedicationDeps): ToolSpec {
  return {
    name: "list_medication_reminders",
    description: "List the medication reminders the user currently has set.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    deadline_ms: STORE_MS,

    handler: async (_args, ctx) => {
      const mine = medicationSchedules(await deps.schedules.forUser(ctx.uid));
      return {
        reminders: mine.map((s) => ({
          label: labelOf(s),
          times: s.recurrence.kind === "daily" ? s.recurrence.times : [],
          ...(s.recurrence.kind === "daily" && s.recurrence.days
            ? { days: s.recurrence.days }
            : {}),
          paused: !s.enabled,
        })),
      };
    },
  };
}

export function createCancelMedicationReminder(deps: MedicationDeps): ToolSpec {
  return {
    name: "cancel_medication_reminder",
    description:
      "Stop reminding the user about one medication. Match on the label they use. " +
      "If you are not sure which one they mean, list them and ask first.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "The label of the reminder to remove." },
      },
      required: ["label"],
      additionalProperties: false,
    },
    deadline_ms: STORE_MS,

    handler: async (args, ctx) => {
      const label = normalise(String(args["label"] ?? ""));
      const mine = medicationSchedules(await deps.schedules.forUser(ctx.uid));
      const found = mine.find((s) => matchKey(labelOf(s)) === matchKey(label));

      // Not an error: naming a reminder that is not there is an ordinary thing
      // to do, and the model can say so better than a fallback key can.
      if (!found) {
        return { cancelled: false, reason: "no_such_reminder", have: mine.map(labelOf) };
      }

      await deps.schedules.remove(found.id);
      deps.log?.("info", "medication reminder cancelled", { uid: ctx.uid });
      return { cancelled: true, label: labelOf(found) };
    },
  };
}

export function createConfirmMedication(deps: MedicationDeps): ToolSpec {
  return {
    name: "confirm_medication",
    description:
      "Record that the user has taken a medication they were just reminded about. " +
      "Call this whenever they say they have taken it, or answer yes to a reminder. " +
      "This stops the device asking again and stops it alerting their family.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    deadline_ms: STORE_MS,

    handler: async (_args, ctx) => {
      const settled = await acknowledgeOpen(
        { store: deps.escalations, ...(deps.log ? { log: deps.log } : {}) },
        ctx.uid,
        { capability: MEDICATION_CAPABILITY },
      );

      // Nothing was waiting. Ordinary — somebody saying "I've taken my tablet"
      // in the middle of an unrelated conversation is being sociable, not
      // answering a prompt, and telling them they are wrong would be absurd.
      if (settled.length === 0) return { confirmed: 0, reason: "nothing_waiting" };

      return {
        confirmed: settled.length,
        labels: settled.map((e) => {
          const label = e.payload["label"];
          return typeof label === "string" ? label : "your medication";
        }),
      };
    },
  };
}

function readDays(value: unknown): Weekday[] | null {
  if (!Array.isArray(value)) return null;
  const days = value
    .map((d) => Number(d))
    .filter((d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6);
  const unique = [...new Set(days)].sort();
  // Seven of seven is every day, which is what an absent `days` already means.
  // Storing it explicitly would be a second way to say the same thing.
  return unique.length === 0 || unique.length === 7 ? null : unique;
}
