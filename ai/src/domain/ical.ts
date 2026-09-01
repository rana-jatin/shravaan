/**
 * Enough iCalendar to read someone's diary aloud.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A FEED URL AND NOT THE GOOGLE CALENDAR API.
 *
 * The API needs OAuth per user — a consent screen, a token store, a refresh
 * cycle. An eighty-year-old with a screenless voice device cannot complete that
 * flow, so it would require caregiver-assisted setup before the product does
 * anything at all.
 *
 * Google Calendar publishes a per-calendar "secret address in iCal format"
 * (Settings > Settings for my calendars > Integrate calendar). A caregiver
 * pastes that one URL and the device can read the diary: no OAuth, no tokens,
 * no Google Cloud project, no consent screen. Verified against a live feed.
 *
 * It is READ-ONLY, which is exactly the right amount of power. A companion that
 * can silently delete a hospital appointment is a worse product than one that
 * cannot, and every use we have for a calendar is reading it.
 *
 * The API becomes necessary the day the agent needs to WRITE an event. Not yet.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately not a full RFC 5545 implementation. It handles what a personal
 * calendar actually contains and says so where it does not — see `expand`.
 *
 * THE STANDARD THIS FILE IS HELD TO: every wrong answer here is spoken aloud as
 * fact to someone who cannot see a screen that would contradict it. Omitting an
 * appointment is bad. Announcing one that does not exist, or announcing the
 * right appointment on the wrong day, is worse — nothing in a spoken answer
 * marks it as uncertain. So where this file cannot be sure, it drops the
 * occurrence rather than guessing at it.
 */

export type CalendarEvent = {
  uid: string;
  summary: string;
  location: string | null;
  /** Local start. All-day events carry midnight and `allDay: true`. */
  start: Date;
  end: Date | null;
  allDay: boolean;
};

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const DAY_MS = 86_400_000;

/** Midnight local to `d`, so day arithmetic is not thrown by a time of day. */
function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole calendar days from `a` to `b`. Counts days, not 86 400 000 ms chunks. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((midnight(b).getTime() - midnight(a).getTime()) / DAY_MS);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Start of the week containing `d`, per the rule's WKST. */
function startOfWeek(d: Date, wkst: number): Date {
  const s = midnight(d);
  s.setDate(s.getDate() - ((s.getDay() - wkst + 7) % 7));
  return s;
}

/**
 * Unfold, per RFC 5545 section 3.1.
 *
 * A long value is wrapped with a leading space or tab on the continuation, and
 * a naive line-splitter therefore truncates every long SUMMARY at 75 octets —
 * silently, and only for the long ones, which are exactly the descriptive
 * appointments worth reading aloud.
 */
export function unfold(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Text values escape comma, semicolon, backslash and newline. */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `20210216` or `20260831T081451Z` to a Date.
 *
 * TZID is read but NOT applied: doing it properly needs a tz database, and
 * getting it half right would shift a hospital appointment by hours. A floating
 * local time is treated as local, which is correct for the overwhelmingly
 * common case of a calendar kept in the user's own timezone.
 */
function parseDate(value: string): { date: Date; allDay: boolean } | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    return {
      date: new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])),
      allDay: true,
    };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!dt) return null;

  const [, y, mo, d, h, mi, sec, z] = dt;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)] as const;
  return {
    date: z ? new Date(Date.UTC(...parts)) : new Date(...parts),
    allDay: false,
  };
}

/**
 * The identity of one occurrence, for matching EXDATE and RECURRENCE-ID against
 * what the rule generates. All-day occurrences are keyed by their date alone,
 * because a feed is free to write the exclusion either way round.
 */
function stamp(date: Date, allDay: boolean): number {
  return allDay ? midnight(date).getTime() : date.getTime();
}

type RawEvent = {
  props: Map<string, string>;
  /** EXDATE may repeat AND be comma-separated, so it cannot live in `props`. */
  exdates: string[];
};

function parseEvents(lines: string[]): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  let depth = 0;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      current = { props: new Map(), exdates: [] };
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("END:VEVENT")) {
      events.push(current);
      current = null;
      depth = 0;
      continue;
    }

    // A VEVENT may nest a VALARM, and RFC 5545 requires an email alarm to carry
    // its OWN SUMMARY and DESCRIPTION. Parsing the event flat lets the alarm
    // overwrite the appointment's name, so the device announces "Reminder"
    // instead of "Cardiology appointment" — with nothing marking it wrong.
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:")) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const rawName = line.slice(0, colon);
    const value = line.slice(colon + 1);
    // `DTSTART;VALUE=DATE` / `DTSTART;TZID=Asia/Kolkata`
    const semi = rawName.indexOf(";");
    const name = (semi === -1 ? rawName : rawName.slice(0, semi)).toUpperCase();

    if (name === "EXDATE") current.exdates.push(value);
    else current.props.set(name, value);
  }
  return events;
}

/** Bounded so a malformed or endless rule cannot spin. */
const MAX_STEPS = 800;

type Rule = {
  freq: string;
  interval: number;
  count: number | null;
  until: Date | null;
  byDay: string[] | null;
  wkst: number;
};

function parseRule(rrule: string): Rule | null {
  const rules = new Map<string, string>();
  for (const part of rrule.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) rules.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  const freq = rules.get("FREQ");
  if (!freq) return null;

  const untilRaw = rules.get("UNTIL");
  const wkst = DAYS.indexOf((rules.get("WKST") ?? "MO").toUpperCase() as (typeof DAYS)[number]);

  return {
    freq: freq.toUpperCase(),
    interval: Math.max(1, Number(rules.get("INTERVAL") ?? 1) || 1),
    count: rules.get("COUNT") ? Number(rules.get("COUNT")) : null,
    until: untilRaw ? (parseDate(untilRaw)?.date ?? null) : null,
    byDay:
      rules
        .get("BYDAY")
        ?.split(",")
        .map((d) => d.trim().slice(-2).toUpperCase()) ?? null,
    wkst: wkst === -1 ? 1 : wkst,
  };
}

/** BYDAY occurrences in `start`'s own week that fall on or after `start`. */
function matchesInFirstWeek(start: Date, byDay: string[], wkst: number): number {
  const ws = startOfWeek(start, wkst);
  const floor = midnight(start);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws);
    d.setDate(d.getDate() + i);
    if (d >= floor && byDay.includes(DAYS[d.getDay()]!)) n++;
  }
  return n;
}

/**
 * Expand one event into the occurrences that fall inside `[from, to)`.
 *
 * ⚠ THE WINDOW IS HALF-OPEN, and that is load-bearing rather than pedantic. An
 * all-day event starts at midnight, so an inclusive end put TOMORROW's birthday
 * inside today's answer — and the shipped holidays feed is entirely all-day
 * events, so "what have I got today?" reliably announced the wrong day.
 *
 * ⚠ RRULE SUPPORT IS PARTIAL, AND THE GAP MATTERS MORE HERE THAN ELSEWHERE.
 *
 * A personal calendar for an older person is mostly recurring: a weekly
 * physiotherapy slot, a monthly check-up, birthdays. Ignoring RRULE entirely —
 * the obvious first version — would drop the majority of what the tool exists
 * to read, and drop it SILENTLY, reporting a free day to someone who has an
 * appointment.
 *
 * So FREQ=DAILY/WEEKLY/MONTHLY/YEARLY are expanded, honouring INTERVAL, COUNT,
 * UNTIL, WKST, BYDAY-for-weekly, EXDATE and RECURRENCE-ID overrides.
 *
 * Not handled: BYSETPOS, BYMONTH, BYMONTHDAY and RDATE. An event using those
 * yields its plain occurrences only, so it is under-reported rather than
 * invented — the direction to err in when the answer is spoken.
 */
function expand(
  event: CalendarEvent,
  rrule: string | null,
  from: Date,
  to: Date,
  excluded: Set<number>,
): CalendarEvent[] {
  const durationMs = event.end ? event.end.getTime() - event.start.getTime() : 0;
  const out: CalendarEvent[] = [];

  const take = (start: Date) => {
    if (excluded.has(stamp(start, event.allDay))) return;
    out.push({
      ...event,
      start: new Date(start),
      end: durationMs > 0 ? new Date(start.getTime() + durationMs) : null,
    });
  };

  const rule = rrule ? parseRule(rrule) : null;
  if (!rule) {
    if (event.start >= from && event.start < to) take(event.start);
    return out;
  }

  const { freq, interval, count, until, byDay, wkst } = rule;
  const h = event.start.getHours();
  const mi = event.start.getMinutes();
  const s = event.start.getSeconds();

  /**
   * ⚠ THE FAST-FORWARD IS CORRECTNESS, NOT SPEED. Stepping one interval at a
   * time from DTSTART is bounded by MAX_STEPS, and a daily event created three
   * years ago exhausts that bound long before it reaches today. The occurrences
   * then come back EMPTY, which reads as "nothing scheduled" — so a daily
   * medication reminder set up years ago becomes invisible at precisely the
   * moment it matters.
   *
   * Every branch below therefore also carries forward how many occurrences it
   * jumped over, so a rule capped at COUNT is not silently reset by the jump
   * and a course of treatment that finished in 2020 stays finished.
   */
  if (freq === "DAILY" || (freq === "WEEKLY" && !byDay)) {
    const step = freq === "DAILY" ? interval : 7 * interval;
    const cursor = new Date(event.start);
    let n = 0;
    if (cursor < from) {
      n = Math.max(0, Math.floor(daysBetween(cursor, from) / step));
      cursor.setDate(cursor.getDate() + n * step);
    }
    for (let steps = 0; steps < MAX_STEPS; steps++, n++) {
      if (cursor >= to) break;
      if (until && cursor > until) break;
      if (count !== null && n >= count) break;
      if (cursor >= from) take(cursor);
      cursor.setDate(cursor.getDate() + step);
    }
    return out;
  }

  if (freq === "WEEKLY") {
    // BYDAY steps a day at a time so "every Tuesday and Thursday" yields both.
    // The week index is what carries INTERVAL: without it a fortnightly physio
    // slot is announced every week, which invents an appointment rather than
    // dropping one.
    const anchor = startOfWeek(event.start, wkst);
    const cursor = new Date(event.start);
    let n = 0;

    if (cursor < from) {
      const weeks = Math.max(0, Math.floor(daysBetween(anchor, startOfWeek(from, wkst)) / 7));
      const jump = Math.floor(weeks / interval) * interval;
      if (jump > 0) {
        n = matchesInFirstWeek(event.start, byDay!, wkst) + (jump / interval - 1) * byDay!.length;
        cursor.setDate(cursor.getDate() + jump * 7);
        // Back up to the start of that week: a BYDAY day earlier in the week
        // than DTSTART's own weekday would otherwise be stepped straight past.
        cursor.setDate(cursor.getDate() - ((cursor.getDay() - wkst + 7) % 7));
      }
    }

    for (let steps = 0; steps < MAX_STEPS; steps++) {
      if (cursor >= to) break;
      if (until && cursor > until) break;
      if (count !== null && n >= count) break;

      const weekIndex = daysBetween(anchor, startOfWeek(cursor, wkst)) / 7;
      if (
        cursor >= event.start &&
        weekIndex >= 0 &&
        weekIndex % interval === 0 &&
        byDay!.includes(DAYS[cursor.getDay()]!)
      ) {
        if (cursor >= from) take(cursor);
        n++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  if (freq === "MONTHLY" || freq === "YEARLY") {
    // Built from the ORIGINAL day-of-month each time rather than by mutating a
    // cursor. `setMonth` on the 31st rolls into the next month AND keeps the
    // rolled day, so a check-up on the 31st became "the 3rd" — permanently, and
    // for every month after. RFC 5545 says an occurrence landing on a date that
    // does not exist is ignored, which is also the safe direction here.
    const monthly = freq === "MONTHLY";
    const y0 = event.start.getFullYear();
    const m0 = event.start.getMonth();
    const d0 = event.start.getDate();

    const dateFor = (i: number): Date | null => {
      const mIndex = m0 + i * interval;
      const year = monthly ? y0 + Math.floor(mIndex / 12) : y0 + i * interval;
      const month = monthly ? ((mIndex % 12) + 12) % 12 : m0;
      // The 31st of a 30-day month, or 29 February of a common year.
      if (daysInMonth(year, month) < d0) return null;
      return new Date(year, month, d0, h, mi, s);
    };

    let i = 0;
    if (event.start < from) {
      const gap = monthly
        ? (from.getFullYear() - y0) * 12 + (from.getMonth() - m0)
        : from.getFullYear() - y0;
      i = Math.max(0, Math.floor(gap / interval));
    }

    // Skipped steps only equal skipped OCCURRENCES when every one of them was a
    // real date. Recount when the day-of-month can go missing, so COUNT is not
    // overstated for a rule anchored on the 29th, 30th or 31st.
    let emitted = i;
    if (i > 0 && d0 > 28) {
      emitted = 0;
      for (let k = 0; k < i; k++) if (dateFor(k)) emitted++;
    }

    for (let steps = 0; steps < MAX_STEPS; steps++, i++) {
      const cur = dateFor(i);
      if (!cur) continue;
      if (cur >= to) break;
      if (until && cur > until) break;
      if (count !== null && emitted >= count) break;
      if (cur >= from) take(cur);
      emitted++;
    }
    return out;
  }

  // An unrecognised FREQ (HOURLY, MINUTELY, SECONDLY) is not something a
  // personal diary contains. Fall back to the single occurrence.
  if (event.start >= from && event.start < to) take(event.start);
  return out;
}

/**
 * Parse a feed and return everything happening in `[from, to)`, soonest first.
 */
export function parseCalendar(ics: string, from: Date, to: Date): CalendarEvent[] {
  const raws = parseEvents(unfold(ics));

  // A single moved or cancelled occurrence is published as a SECOND VEVENT with
  // the same UID and a RECURRENCE-ID naming the slot it replaces — the parent
  // keeps its RRULE untouched. Without this the old slot is read out alongside
  // the new one, so a rescheduled appointment is announced twice, once at a
  // time the user no longer has it.
  const overrides = new Map<string, Set<number>>();
  for (const raw of raws) {
    const rid = raw.props.get("RECURRENCE-ID");
    const uid = raw.props.get("UID");
    if (!rid || !uid) continue;
    const parsed = parseDate(rid);
    if (!parsed) continue;
    let set = overrides.get(uid);
    if (!set) overrides.set(uid, (set = new Set()));
    set.add(stamp(parsed.date, parsed.allDay));
  }

  const events: CalendarEvent[] = [];

  for (const raw of raws) {
    const dtstart = raw.props.get("DTSTART");
    const summary = raw.props.get("SUMMARY");
    if (!dtstart || !summary) continue;

    const start = parseDate(dtstart);
    if (!start) continue;

    // Cancelled events must not be read out as appointments.
    if ((raw.props.get("STATUS") ?? "").toUpperCase() === "CANCELLED") continue;

    const dtend = raw.props.get("DTEND");
    const end = dtend ? parseDate(dtend) : null;

    const base: CalendarEvent = {
      uid: raw.props.get("UID") ?? `${dtstart}-${summary}`,
      summary: unescapeText(summary),
      location: raw.props.get("LOCATION") ? unescapeText(raw.props.get("LOCATION")!) : null,
      start: start.date,
      end: end?.date ?? null,
      allDay: start.allDay,
    };

    const excluded = new Set<number>();
    for (const line of raw.exdates) {
      for (const value of line.split(",")) {
        const parsed = parseDate(value.trim());
        if (parsed) excluded.add(stamp(parsed.date, parsed.allDay));
      }
    }
    // Applied to the PARENT only. An override whose time was not changed has a
    // DTSTART equal to its own RECURRENCE-ID and would otherwise exclude
    // itself — deleting the very appointment it exists to describe.
    if (!raw.props.get("RECURRENCE-ID")) {
      for (const t of overrides.get(base.uid) ?? []) excluded.add(t);
    }

    events.push(...expand(base, raw.props.get("RRULE") ?? null, from, to, excluded));
  }

  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}
