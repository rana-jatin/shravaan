/**
 * When something should happen, in the user's own day.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT THE RRULE EXPANDER IN domain/ical.ts.
 *
 * The plan for this step said to reuse it. Reading it settled the question: its
 * own header says `TZID is read but NOT applied: doing it properly needs a tz
 * database`. For a calendar that is a defensible trade — an appointment read
 * back an hour out is wrong but recoverable, and the Google path expands
 * recurrences server-side anyway.
 *
 * A medication reminder is not recoverable in the same way. "Take your tablet"
 * at 02:30 because a local 08:00 was treated as UTC wakes a person in the night
 * and teaches them to ignore the device — and the ignoring is what actually
 * causes the harm later. Timezone handling is not a detail of this feature; it
 * IS the feature.
 *
 * So the recurrence vocabulary here is deliberately small and the timezone
 * handling is real, rather than the other way round. There is no BYSETPOS, no
 * BYMONTHDAY, no RDATE: a reminder is "at these times", "on these days", or
 * "every so often between these hours". Anything a person would describe as a
 * calendar event belongs in the calendar, which already handles it properly.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOTHING HERE PERFORMS I/O, reads a clock, or knows what a reminder is for.
 * Every instant is passed in. That is what makes the DST and half-hour-offset
 * cases testable at all — see test/scheduler.test.ts.
 */

import type { Iso8601 } from "@sp-i/shared/domain/types.ts";

/** 0 = Sunday, matching `Date#getDay` and the `DAYS` table in domain/ical.ts. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** `"08:00"` — 24-hour, zero-padded, in the schedule's own timezone. */
export type WallClock = string;

export type Recurrence =
  /** A single instant. Fires once and is then spent. */
  | { kind: "once"; at: Iso8601 }
  /**
   * The common case: a medication at 08:00 and 20:00, a check-in at 10:00.
   * `days` narrows it to particular weekdays — a tablet taken Mon/Wed/Fri.
   */
  | { kind: "daily"; times: WallClock[]; days?: Weekday[] }
  /**
   * Every so often within a window. Hydration prompts, and nothing else so far.
   *
   * THE WINDOW IS NOT OPTIONAL IN PRACTICE and defaults to waking hours. An
   * interval with no bound fires at 3 a.m., which for this product is not a
   * missed nicety but a harm: a device that wakes someone at night is one they
   * unplug, and an unplugged device cannot raise an alarm either.
   */
  | { kind: "interval"; everyMinutes: number; window?: { from: WallClock; to: WallClock } };

export type Schedule = {
  id: string;
  /** Whose day this belongs to. */
  uid: string;
  /** The capability that owns the payload and will be handed the occurrence. */
  capability: string;
  /**
   * Opaque here. The scheduler never reads it — which medication, which
   * question, which prompt is the capability's business and not this module's.
   */
  payload: Record<string, unknown>;
  /** IANA zone. The user's, not the server's. */
  timezone: string;
  recurrence: Recurrence;
  /** Paused without being forgotten. A holiday is not a deletion. */
  enabled: boolean;
  createdAt: Iso8601;
};

/** One firing of one schedule. */
export type Occurrence = {
  schedule: Schedule;
  /** The instant it was due. */
  at: Date;
};

/**
 * Where schedules live between restarts.
 *
 * An interface here, implementations in step 10 — in-process and Redis, the
 * same pattern as SessionStore. Declared with the domain because the domain is
 * what defines the shape, and because a capability writing a reminder should
 * depend on this and never on Redis.
 */
export type ScheduleStore = {
  /** Everything for one person. */
  forUser(uid: string): Promise<Schedule[]>;
  /** Everything, for the ticker. */
  all(): Promise<Schedule[]>;
  put(schedule: Schedule): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<Schedule | null>;
  close?(): Promise<void>;
};
