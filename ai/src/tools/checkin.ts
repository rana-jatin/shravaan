/**
 * Turning the daily check-in on and off.
 *
 * TWO TOOLS, NOT FOUR, and the missing pair is the interesting part. There is
 * no `confirm_checkin`, because a check-in is answered by the person SAYING
 * ANYTHING — "theek hoon", "kaun hai", a complaint about the heat are all the
 * same answer to the only question being asked. A tool the model had to
 * remember to call would turn that into a thing it could forget to do, and the
 * failure would be a family told nobody was home when somebody plainly was.
 * The polling lives in the capability's `answered` hook instead.
 *
 * There is also no `list`: one person has one check-in, so `set` returning what
 * it set is the whole answer.
 *
 * ⚠ WHO SETS THIS UP IS AN OPEN QUESTION. Today it is the person themselves,
 * through the model, which is backwards for a feature whose point is the
 * family's peace of mind. The caregiver dashboard is where it belongs and does
 * not exist yet; until then a caregiver sets it up on the device, out loud,
 * next to the person it is about — which at least means nobody is being
 * watched without knowing it.
 */

import { randomUUID } from "node:crypto";
import { isValidTimeZone, parseWallClock } from "../scheduler/timezone.ts";
import type { Schedule, ScheduleStore, Weekday } from "../scheduler/types.ts";
import type { ToolSpec } from "./registry.ts";
import { STORE_MS } from "./types.ts";

export const CHECKIN_CAPABILITY = "checkin";

export type CheckinDeps = {
  schedules: ScheduleStore;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

function existingCheckin(all: Schedule[]): Schedule | undefined {
  return all.find((s) => s.capability === CHECKIN_CAPABILITY);
}

export function createSetDailyCheckin(deps: CheckinDeps): ToolSpec {
  return {
    name: "set_daily_checkin",
    description:
      "Have the device say hello once a day and alert the user's family if nobody " +
      "answers. Time is 24-hour HH:MM in the user's own timezone. Setting it again " +
      "moves the existing check-in rather than adding a second one.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "24-hour time, e.g. '10:00'." },
        days: {
          type: "array",
          description: "Optional. Weekdays as integers, 0 = Sunday. Omit for every day.",
          items: { type: "integer" },
        },
      },
      required: ["time"],
      additionalProperties: false,
    },
    deadline_ms: STORE_MS,

    handler: async (args, ctx) => {
      const parsed = parseWallClock(String(args["time"] ?? "").trim());
      if (!parsed) return { set: false, reason: "not_a_time", given: args["time"] };

      const time = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;

      const timezone = ctx.host.timezone();
      if (!isValidTimeZone(timezone)) return { set: false, reason: "unknown_timezone", timezone };

      const days = readDays(args["days"]);
      const mine = await deps.schedules.forUser(ctx.uid);
      const existing = existingCheckin(mine);

      const schedule: Schedule = {
        id: existing?.id ?? randomUUID(),
        uid: ctx.uid,
        capability: CHECKIN_CAPABILITY,
        // NOTHING ABOUT THE PERSON. The payload carries the zone so a family
        // message can render a local time after the schedule is gone, and that
        // is the entire contents.
        payload: { timezone },
        timezone,
        recurrence: { kind: "daily", times: [time], ...(days ? { days } : {}) },
        enabled: true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };

      await deps.schedules.put(schedule);
      deps.log?.("info", "daily check-in set", {
        uid: ctx.uid,
        time,
        days: days ?? "every day",
        moved: Boolean(existing),
      });

      return { set: true, time, ...(days ? { days } : {}), moved: Boolean(existing) };
    },
  };
}

export function createCancelDailyCheckin(deps: CheckinDeps): ToolSpec {
  return {
    name: "cancel_daily_checkin",
    description:
      "Stop the daily check-in. The user's family will no longer be told when " +
      "nobody answers. Say so plainly when confirming it.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    deadline_ms: STORE_MS,

    handler: async (_args, ctx) => {
      const found = existingCheckin(await deps.schedules.forUser(ctx.uid));
      // Not an error: turning off something that was never on is a reasonable
      // thing to ask for, and the honest answer is that it is already off.
      if (!found) return { cancelled: false, reason: "not_set" };

      await deps.schedules.remove(found.id);
      deps.log?.("info", "daily check-in cancelled", { uid: ctx.uid });
      return {
        cancelled: true,
        // Worth the model saying out loud. Switching this off removes the only
        // thing that would notice a silent morning.
        note: "nobody will be alerted if the user stops answering",
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
  return unique.length === 0 || unique.length === 7 ? null : unique;
}
