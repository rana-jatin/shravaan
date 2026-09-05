/**
 * Wall-clock time in a place, and the instant it corresponds to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE HARD PROBLEM IN THE SCHEDULER, AND WHY IT IS SOLVED THIS WAY.
 *
 * Going from an instant to a local wall clock is easy: `Intl.DateTimeFormat`
 * with a `timeZone` does it, and it carries the full tz database that Node
 * ships. Going the other way — "what instant is 08:00 on the 6th in Kolkata" —
 * has no direct API.
 *
 * The technique is to guess and correct. Treat the wall clock as if it were
 * UTC, format that guess back into the target zone, measure how far off the
 * result is, and shift by that much. One correction is enough for a fixed
 * offset; a second catches the case where the shift moves across a DST
 * boundary and the offset itself changes. Two passes converge everywhere.
 *
 * ⚠ HALF-HOUR AND QUARTER-HOUR ZONES ARE NOT AN EDGE CASE HERE. India is
 * UTC+05:30, Nepal is +05:45, and this product's users are in the first of
 * them. Anything that reasons in whole hours is wrong for every single user of
 * this device, which is why the arithmetic below is in minutes throughout.
 *
 * NO DEPENDENCY. A tz library would do this too, and this repo carries no
 * date dependency at all — the Intl data is already in the runtime, and forty
 * lines that use it are cheaper to audit than a package that must be kept
 * current with the tz database.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type WallClockParts = {
  year: number;
  month: number; // 1-12, as a person writes it
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Cached: constructing a formatter is far slower than using one. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Is this a zone the runtime knows?
 *
 * Checked when a schedule is created rather than when it fires. An unknown zone
 * throws from `Intl`, and the place to discover that is a caregiver saving a
 * reminder — not a background tick at six in the morning.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The local wall clock in `timeZone` at `instant`. */
export function wallClockIn(instant: Date, timeZone: string): WallClockParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // `hour12: false` renders midnight as "24" in some ICU versions rather than
    // "00". Both mean the same instant; only one of them sorts correctly.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** How far ahead of UTC `timeZone` is at `instant`, in minutes. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const local = wallClockIn(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // Seconds and milliseconds are not in the formatted parts, so compare at
  // minute resolution on both sides or the remainder shows up as drift.
  const instantMinutes = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (asUtc - instantMinutes) / 60_000;
}

/**
 * The instant at which the clock in `timeZone` reads this wall time.
 *
 * Two passes, for the reason in the file header. Returns a Date that may not
 * land on the requested wall clock at all in one case: a DST spring-forward
 * skips an hour, so 02:30 simply does not exist on that date in that zone. The
 * result is then the instant the clock jumps to, which is the behaviour a
 * person expects from "remind me at 02:30" on the day 02:30 was skipped —
 * earlier is safer than never for a medication.
 */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

  let instant = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
  // Second pass: the first shift may have crossed a boundary where the offset
  // itself is different. Recomputing from the corrected instant settles it.
  instant = new Date(naive - offsetMinutes(instant, timeZone) * 60_000);
  return instant;
}

/** `"08:00"` into minutes past local midnight, or null if it is not a time. */
export function parseWallClock(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Local midnight-relative minutes, for comparing times within a day. */
export function minutesOfDay(time: { hour: number; minute: number }): number {
  return time.hour * 60 + time.minute;
}
