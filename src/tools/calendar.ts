/**
 * `get_appointments` — what is coming up. And `add_appointment` — putting
 * something in the diary.
 *
 * TWO BACKENDS, ONE SHAPE. A calendar reaches this file as a `CalendarSource`,
 * and the tool does not know which kind it got:
 *
 *   iCal feed  — no credential at all. A caregiver pastes the "secret address
 *                in iCal format". Read-only, and our own RRULE expander.
 *   API        — a Google credential. `singleEvents=true` means GOOGLE expands
 *                the recurrences, which is the real reason to prefer it: our
 *                expander had seven defects in it (D10), and Google's handles
 *                BYSETPOS, BYMONTHDAY, RDATE and true TZID conversion.
 *
 * Both stay supported on purpose. A deployment with no Google project still has
 * a working calendar, and the API path is an upgrade rather than a dependency.
 *
 * This finally uses `progress.calendar`, which has sat in src/copy/fillers.ts in
 * all eleven languages since slice 6 waiting for a tool to belong to.
 */

import { parseCalendar, type CalendarEvent } from "../domain/ical.ts";
import type { GoogleCalendar } from "../providers/google-calendar.ts";
import type { ToolSpec } from "./registry.ts";
import type { HttpFetch } from "./builtin.ts";

/** A network hop, possibly several calendars. */
const CALENDAR_MS = 6000;
const CALENDAR_FILLER_MS = 600;
const WRITE_MS = 6000;
const WRITE_FILLER_MS = 600;

/** How far ahead each window looks. Spoken answers, so kept short. */
const WINDOWS = {
  today: 1,
  tomorrow: 2,
  week: 7,
} as const;

export type CalendarWindow = keyof typeof WINDOWS;

/**
 * One calendar, however it is reached.
 *
 * `label` is SPOKEN — "your calendar", "hospital" — so a deployment names it as
 * a person would, and a partial failure can say which one is missing.
 */
export type CalendarSource = {
  label: string;
  read(
    from: Date,
    to: Date,
    ctx: { timezone: string; signal: AbortSignal },
  ): Promise<CalendarEvent[]>;
};

/** A calendar reached by its public/secret iCal URL. No credential. */
export function icalSource(label: string, url: string, fetcher?: HttpFetch): CalendarSource {
  const f = fetcher ?? globalThis.fetch;
  return {
    label,
    async read(from, to, ctx) {
      const res = await f(url, { signal: ctx.signal, headers: { accept: "text/calendar" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCalendar(await res.text(), from, to);
    },
  };
}

/** A calendar reached through the Google Calendar API. */
export function googleSource(
  label: string,
  calendarId: string,
  client: GoogleCalendar,
  limit = 25,
): CalendarSource {
  return {
    label,
    read: (from, to, ctx) =>
      client.listEvents({
        calendarId,
        from,
        to,
        limit,
        timezone: ctx.timezone,
        signal: ctx.signal,
      }),
  };
}

export type CalendarDeps = {
  sources: CalendarSource[];
  /** Most events read aloud in one answer. */
  limit?: number;
};

/**
 * Day boundaries in the user's zone, not the server's.
 *
 * `to` is EXCLUSIVE — midnight at the start of the first day NOT being asked
 * about. That matters more than it sounds: an all-day event starts at midnight,
 * so an inclusive end puts tomorrow's birthday inside today's answer.
 */
function windowFor(window: CalendarWindow, timezone: string): { from: Date; to: Date } {
  const now = new Date();
  // Midnight local to the user. Intl is how we learn what "today" means there
  // without pulling in a timezone library.
  const local = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const startOfToday = new Date(local.getFullYear(), local.getMonth(), local.getDate());

  if (window === "tomorrow") {
    const from = new Date(startOfToday);
    from.setDate(from.getDate() + 1);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to };
  }

  const to = new Date(startOfToday);
  to.setDate(to.getDate() + WINDOWS[window]);
  return { from: startOfToday, to };
}

/** Spoken shape, not ISO. The model renders it into the user's language. */
function describe(e: CalendarEvent, timezone: string): Record<string, unknown> {
  const day = e.start.toLocaleDateString("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return {
    what: e.summary,
    day,
    ...(e.allDay
      ? { all_day: true }
      : {
          time_24h: e.start.toLocaleTimeString("en-GB", {
            timeZone: timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        }),
    ...(e.location ? { where: e.location } : {}),
  };
}

export function createGetAppointments(deps: CalendarDeps): ToolSpec {
  const limit = deps.limit ?? 6;

  return {
    name: "get_appointments",
    description:
      "Look at the user's calendar — appointments, birthdays, anything they have " +
      "written down. Use this whenever they ask what is happening today, what " +
      "they have on, when their next appointment is, or whether they are free. " +
      "You cannot see their diary otherwise. Read it back conversationally, not " +
      "as a list, and lead with the time.",
    parameters: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description: "How far ahead to look.",
          enum: ["today", "tomorrow", "week"],
        },
      },
      required: ["window"],
      additionalProperties: false,
    },
    deadline_ms: CALENDAR_MS,
    filler_threshold_ms: CALENDAR_FILLER_MS,
    progress_key: "progress.calendar",
    handler: async (args, ctx) => {
      const window = (String(args["window"] ?? "today").trim() || "today") as CalendarWindow;
      if (!(window in WINDOWS)) return { found: 0, reason: "unknown_window", window };

      const timezone = ctx.host.timezone();
      const { from, to } = windowFor(window, timezone);

      const events: CalendarEvent[] = [];
      const failed: string[] = [];

      // Sources are read together and failures are COLLECTED, not thrown. One
      // broken calendar must not hide the appointments in the others — under-
      // reporting a diary is bad, but reporting nothing is worse.
      await Promise.all(
        deps.sources.map(async (source) => {
          try {
            events.push(...(await source.read(from, to, { timezone, signal: ctx.signal })));
          } catch {
            failed.push(source.label);
          }
        }),
      );

      // Every source failed. THAT is infrastructure, and it throws so the
      // executor spends the reviewed unavailable copy rather than reporting a
      // free day to someone who has a hospital appointment.
      if (deps.sources.length > 0 && failed.length === deps.sources.length) {
        throw new Error(`every calendar feed failed: ${failed.join(", ")}`);
      }

      events.sort((a, b) => a.start.getTime() - b.start.getTime());
      const shown = events.slice(0, limit);

      return {
        found: shown.length,
        window,
        ...(shown.length === 0 ? { reason: "nothing_scheduled" } : {}),
        appointments: shown.map((e) => describe(e, timezone)),
        ...(events.length > shown.length ? { more: events.length - shown.length } : {}),
        // A partial answer must say it is partial, so the model can add "though
        // I couldn't reach one of your calendars" rather than implying a free day.
        ...(failed.length > 0 ? { unreachable_calendars: failed } : {}),
      };
    },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type AddAppointmentDeps = {
  client: GoogleCalendar;
  /** The calendar written to. A write target is always explicit, never guessed. */
  calendarId: string;
  /** Spoken name of that calendar, for the confirmation the model reads back. */
  label: string;
};

/**
 * `add_appointment` — write one event.
 *
 * ⚠ WHY CREATE BUT NOT CANCEL. Creating a wrong appointment is recoverable and
 * visible: the user hears it read back, and a spurious entry is an annoyance.
 * DELETING the right one is neither — a voice agent that mishears can remove a
 * hospital appointment, and the user has no screen on which to notice it gone.
 * `cancel_appointment` is therefore held back until there is a spoken
 * confirmation turn to gate it, which is a session-level piece of work rather
 * than another tool. See docs/05-open-questions.md.
 *
 * The tool returns `confirm_back`: the appointment as the companion should say
 * it, so the user hears what was actually written rather than what they meant.
 * Same reasoning as `asked_for` on get_weather (D9) — a resolver that cannot
 * express doubt will state a wrong answer with total confidence.
 */
export function createAddAppointment(deps: AddAppointmentDeps): ToolSpec {
  return {
    name: "add_appointment",
    description:
      "Put something in the user's calendar — an appointment, a visit, a reminder " +
      "of something they must not forget. Work out the exact date yourself from " +
      "what they said (use get_time first if you need to know today's date), and " +
      "always read the saved appointment back to them afterwards so they can hear " +
      "it is right. Do not use this to look things up; that is get_appointments.",
    parameters: {
      type: "object",
      properties: {
        what: {
          type: "string",
          description: "What the appointment is, in the user's own words.",
        },
        date: {
          type: "string",
          description: "The day, as YYYY-MM-DD. Resolve relative dates yourself.",
        },
        time_24h: {
          type: "string",
          description:
            "Start time as HH:MM on a 24-hour clock. Omit for something with no " +
            "particular time, which is saved as an all-day entry.",
        },
        duration_minutes: {
          type: "integer",
          description: "How long it lasts. Defaults to an hour.",
        },
        where: { type: "string", description: "Location, if the user gave one." },
      },
      required: ["what", "date"],
      additionalProperties: false,
    },
    deadline_ms: WRITE_MS,
    filler_threshold_ms: WRITE_FILLER_MS,
    progress_key: "progress.calendar",
    handler: async (args, ctx) => {
      const what = String(args["what"] ?? "").trim();
      const date = String(args["date"] ?? "").trim();
      const rawTime = args["time_24h"] == null ? "" : String(args["time_24h"]).trim();
      const where = args["where"] == null ? "" : String(args["where"]).trim();

      // Domain outcomes, not errors: a refusal the model can rephrase costs
      // nothing, while a thrown error spends the reviewed unavailable copy.
      if (!what) return { saved: false, reason: "missing_what" };
      if (!DATE_RE.test(date)) return { saved: false, reason: "bad_date", got: date };
      if (rawTime && !TIME_RE.test(rawTime)) {
        return { saved: false, reason: "bad_time", got: rawTime };
      }

      const timezone = ctx.host.timezone();
      const allDay = rawTime === "";
      let start: string;
      let end: string;

      if (allDay) {
        start = date;
        // Google's all-day `end` is EXCLUSIVE: a one-day event ends the NEXT
        // day. Writing the same date makes a zero-length event that some
        // clients then fail to show at all.
        const next = new Date(`${date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        end = next.toISOString().slice(0, 10);
      } else {
        const minutes = Number(args["duration_minutes"]);
        const span = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 1440) : 60;
        const [h, m] = rawTime.split(":").map(Number) as [number, number];
        // Wall-clock arithmetic on a fixed UTC day, so the offset never enters
        // into it — the strings are handed to Google alongside the timezone.
        const base = new Date(Date.UTC(2000, 0, 1, h, m));
        base.setUTCMinutes(base.getUTCMinutes() + span);
        const endDay = new Date(`${date}T00:00:00Z`);
        endDay.setUTCDate(endDay.getUTCDate() + (base.getUTCDate() - 1));
        start = `${date}T${rawTime}:00`;
        end = `${endDay.toISOString().slice(0, 10)}T${String(base.getUTCHours()).padStart(2, "0")}:${String(base.getUTCMinutes()).padStart(2, "0")}:00`;
      }

      const created = await deps.client.insertEvent({
        calendarId: deps.calendarId,
        summary: what,
        start,
        end,
        timezone,
        ...(where ? { location: where } : {}),
        signal: ctx.signal,
      });

      const spokenDay = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
      });

      return {
        saved: true,
        calendar: deps.label,
        event_id: created.id,
        // Read this back. It is what was WRITTEN, not what was asked for.
        confirm_back: {
          what,
          day: spokenDay,
          ...(allDay ? { all_day: true } : { time_24h: rawTime }),
          ...(where ? { where } : {}),
        },
      };
    },
  };
}
