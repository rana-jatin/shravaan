/**
 * Working out what was due, and when the next one is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WINDOW IS HALF-OPEN: `(from, to]`.
 *
 * A ticker asks "what became due since I last looked", and calls this with the
 * previous tick and now. Half-open at the start is what makes that safe: an
 * occurrence landing exactly on a tick boundary belongs to exactly one window,
 * so it is neither fired twice nor dropped between two ticks.
 *
 * Getting this wrong in either direction is a real harm rather than an
 * annoyance. Twice means a person is told to take a tablet they have already
 * taken. Never means nobody notices they did not.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure. No clock, no store, no I/O — every instant is an argument.
 */

import type { Occurrence, Recurrence, Schedule, Weekday } from "./types.ts";
import { minutesOfDay, parseWallClock, wallClockIn, zonedTimeToUtc } from "./timezone.ts";

/**
 * Days walked before giving up looking for the next occurrence.
 *
 * Two years. Long enough for "every Sunday" plus a leap year, short enough that
 * a schedule which can never fire — weekdays that exclude every day it lists —
 * returns null quickly instead of spinning.
 */
const MAX_LOOKAHEAD_DAYS = 732;

/**
 * Occurrences of one schedule in `(from, to]`, in order.
 *
 * BOUNDED AT `MAX_LOOKAHEAD_DAYS`. A ticker asks about minutes, so this never
 * binds in the loop it was written for. A caller asking about ten years gets
 * the first two and no warning — if that ever becomes a real question (a
 * caregiver dashboard drawing a year of adherence, say) it wants its own
 * paginating API rather than a larger constant here.
 */
export function occurrencesBetween(schedule: Schedule, from: Date, to: Date): Date[] {
  if (!schedule.enabled) return [];
  if (to.getTime() <= from.getTime()) return [];

  const recurrence = schedule.recurrence;
  if (recurrence.kind === "once") {
    const at = new Date(recurrence.at);
    if (Number.isNaN(at.getTime())) return [];
    return at.getTime() > from.getTime() && at.getTime() <= to.getTime() ? [at] : [];
  }

  const out: Date[] = [];
  // Start a day early: a local time near midnight can belong to the previous
  // local day once the zone offset is applied, and dropping it would silently
  // lose every reminder set for 00:15.
  const cursor = wallClockIn(new Date(from.getTime() - DAY_MS), schedule.timezone);
  let { year, month, day } = cursor;

  for (let guard = 0; guard <= MAX_LOOKAHEAD_DAYS; guard++) {
    for (const minutes of localMinutesFor(recurrence)) {
      const at = zonedTimeToUtc(
        { year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
        schedule.timezone,
      );

      if (at.getTime() <= from.getTime()) continue;
      if (at.getTime() > to.getTime()) return sorted(out);

      // The weekday is read from the RESOLVED instant, not from the date we
      // were iterating. Near midnight in a zone far from UTC those differ, and
      // the day a reminder actually lands on is the one that matters.
      if (matchesDay(recurrence, at, schedule.timezone)) out.push(at);
    }

    ({ year, month, day } = nextLocalDay(year, month, day));
    // Cheap bound: once the day itself is past `to`, nothing later can qualify.
    if (zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 }, schedule.timezone) > to) break;
  }

  return sorted(out);
}

/** The first occurrence strictly after `after`, or null within the lookahead. */
export function nextOccurrence(schedule: Schedule, after: Date): Date | null {
  if (!schedule.enabled) return null;

  if (schedule.recurrence.kind === "once") {
    const at = new Date(schedule.recurrence.at);
    if (Number.isNaN(at.getTime())) return null;
    return at.getTime() > after.getTime() ? at : null;
  }

  // Widen until something is found rather than expanding two years up front:
  // almost every schedule answers within a day.
  for (const days of [1, 8, 40, MAX_LOOKAHEAD_DAYS]) {
    const found = occurrencesBetween(schedule, after, new Date(after.getTime() + days * DAY_MS));
    if (found.length > 0) return found[0]!;
  }
  return null;
}

/** Everything due across many schedules, oldest first. */
export function dueBetween(schedules: readonly Schedule[], from: Date, to: Date): Occurrence[] {
  const out: Occurrence[] = [];
  for (const schedule of schedules) {
    for (const at of occurrencesBetween(schedule, from, to)) out.push({ schedule, at });
  }
  // Oldest first, so a backlog after a restart is delivered in the order it
  // happened rather than grouped by whichever schedule was stored first.
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const DAY_MS = 86_400_000;

function sorted(dates: Date[]): Date[] {
  return dates.sort((a, b) => a.getTime() - b.getTime());
}

/** Local minutes-past-midnight this recurrence fires at, ascending. */
function localMinutesFor(recurrence: Recurrence): number[] {
  if (recurrence.kind === "daily") {
    const minutes: number[] = [];
    for (const time of recurrence.times) {
      const parsed = parseWallClock(time);
      // A malformed time is dropped rather than throwing. A stored schedule is
      // data that may predate a validation rule, and one bad entry must not
      // stop the other reminders in the same schedule from firing.
      if (parsed) minutes.push(minutesOfDay(parsed));
    }
    return [...new Set(minutes)].sort((a, b) => a - b);
  }

  if (recurrence.kind === "interval") {
    const step = Math.floor(recurrence.everyMinutes);
    // A zero or negative step would generate the same instant forever.
    if (!Number.isFinite(step) || step <= 0) return [];

    const from = parseWallClock(recurrence.window?.from ?? "08:00") ?? { hour: 8, minute: 0 };
    const to = parseWallClock(recurrence.window?.to ?? "22:00") ?? { hour: 22, minute: 0 };
    const start = minutesOfDay(from);
    const end = minutesOfDay(to);
    if (end < start) return [];

    const minutes: number[] = [];
    for (let m = start; m <= end; m += step) minutes.push(m);
    return minutes;
  }

  return [];
}

function matchesDay(recurrence: Recurrence, at: Date, timeZone: string): boolean {
  if (recurrence.kind !== "daily") return true;
  const days = recurrence.days;
  if (!days || days.length === 0) return true;
  return days.includes(wallClockIn(at, timeZone).weekday as Weekday);
}

function nextLocalDay(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  // Arithmetic on the civil calendar, deliberately not on a UTC instant: adding
  // 24 hours to an instant lands on the wrong civil day whenever a zone shifts.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}
