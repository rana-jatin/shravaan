/**
 * The scheduler domain.
 *
 * Everything here is pure, so everything here is testable — which matters more
 * for this module than most. A reminder that fires at the wrong hour wakes an
 * elderly person in the night, and a device that wakes people at night is one
 * they unplug. An unplugged device cannot raise an alarm either.
 *
 * India is UTC+05:30, so the half-hour offset is not an edge case for this
 * product — it is every single user.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dueBetween, nextOccurrence, occurrencesBetween } from "../src/scheduler/occurrences.ts";
import {
  isValidTimeZone,
  minutesOfDay,
  offsetMinutes,
  parseWallClock,
  wallClockIn,
  zonedTimeToUtc,
} from "../src/scheduler/timezone.ts";
import type { Recurrence, Schedule } from "../src/scheduler/types.ts";

const KOLKATA = "Asia/Kolkata";
const LONDON = "Europe/London";
const KATHMANDU = "Asia/Kathmandu";

function schedule(recurrence: Recurrence, over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    uid: "u1",
    capability: "medication",
    payload: { medicine: "the blue one" },
    timezone: KOLKATA,
    recurrence,
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const at = (iso: string) => new Date(iso);

describe("wall clock and instant", () => {
  it("reads the local clock in a half-hour zone", () => {
    // 2026-09-06T02:30Z is 08:00 in Kolkata. Every user of this product lives
    // on the wrong side of an hour boundary.
    const parts = wallClockIn(at("2026-09-06T02:30:00Z"), KOLKATA);
    assert.equal(parts.hour, 8);
    assert.equal(parts.minute, 0);
    assert.equal(parts.day, 6);
    assert.equal(parts.weekday, 0, "6 September 2026 is a Sunday");
  });

  it("resolves a local wall clock back to the right instant", () => {
    const instant = zonedTimeToUtc({ year: 2026, month: 9, day: 6, hour: 8, minute: 0 }, KOLKATA);
    assert.equal(instant.toISOString(), "2026-09-06T02:30:00.000Z");
  });

  it("round-trips through a quarter-hour zone", () => {
    // Nepal is UTC+05:45. Anything reasoning in whole hours is wrong here.
    const instant = zonedTimeToUtc({ year: 2026, month: 9, day: 6, hour: 8, minute: 0 }, KATHMANDU);
    assert.equal(instant.toISOString(), "2026-09-06T02:15:00.000Z");
    assert.equal(wallClockIn(instant, KATHMANDU).hour, 8);
  });

  it("reports the offset in minutes, not hours", () => {
    assert.equal(offsetMinutes(at("2026-09-06T02:30:00Z"), KOLKATA), 330);
    assert.equal(offsetMinutes(at("2026-09-06T02:30:00Z"), KATHMANDU), 345);
  });

  it("crosses a local midnight correctly", () => {
    // 00:15 in Kolkata is the PREVIOUS UTC day. A scheduler that iterated UTC
    // days would lose every reminder set for just after midnight.
    const instant = zonedTimeToUtc({ year: 2026, month: 9, day: 6, hour: 0, minute: 15 }, KOLKATA);
    assert.equal(instant.toISOString(), "2026-09-05T18:45:00.000Z");
    assert.equal(wallClockIn(instant, KOLKATA).day, 6);
  });

  it("handles a zone that actually observes DST", () => {
    // London: BST (+01:00) in summer, GMT in winter. Kolkata never shifts, so
    // a bug here would be invisible to the deployment and wrong for a traveller.
    const summer = zonedTimeToUtc({ year: 2026, month: 7, day: 1, hour: 8, minute: 0 }, LONDON);
    const winter = zonedTimeToUtc({ year: 2026, month: 12, day: 1, hour: 8, minute: 0 }, LONDON);
    assert.equal(summer.toISOString(), "2026-07-01T07:00:00.000Z");
    assert.equal(winter.toISOString(), "2026-12-01T08:00:00.000Z");
  });

  it("keeps 08:00 local across a spring-forward", () => {
    // The clocks move on 29 March 2026 in London. A person taking a tablet at
    // 08:00 takes it at 08:00 on both sides of that.
    const before = zonedTimeToUtc({ year: 2026, month: 3, day: 28, hour: 8, minute: 0 }, LONDON);
    const after = zonedTimeToUtc({ year: 2026, month: 3, day: 30, hour: 8, minute: 0 }, LONDON);
    assert.equal(wallClockIn(before, LONDON).hour, 8);
    assert.equal(wallClockIn(after, LONDON).hour, 8);
    // And the instants really are an hour apart in UTC terms.
    assert.equal(before.toISOString(), "2026-03-28T08:00:00.000Z");
    assert.equal(after.toISOString(), "2026-03-30T07:00:00.000Z");
  });

  it("validates a zone when a schedule is saved, not when it fires", () => {
    assert.equal(isValidTimeZone(KOLKATA), true);
    assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  });

  it("parses a wall clock and refuses nonsense", () => {
    assert.deepEqual(parseWallClock("08:00"), { hour: 8, minute: 0 });
    assert.deepEqual(parseWallClock("8:05"), { hour: 8, minute: 5 });
    assert.equal(minutesOfDay({ hour: 8, minute: 30 }), 510);
    for (const bad of ["25:00", "08:60", "0800", "", "eight"]) {
      assert.equal(parseWallClock(bad), null, bad);
    }
  });
});

describe("daily reminders", () => {
  it("fires at the local time, every day", () => {
    const s = schedule({ kind: "daily", times: ["08:00", "20:00"] });
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-07T23:59:00Z"));

    assert.deepEqual(
      found.map((d) => d.toISOString()),
      [
        "2026-09-06T02:30:00.000Z", // 08:00 IST on the 6th
        "2026-09-06T14:30:00.000Z", // 20:00 IST on the 6th
        "2026-09-07T02:30:00.000Z",
        "2026-09-07T14:30:00.000Z",
      ],
    );
  });

  it("finds a reminder set for just after local midnight", () => {
    // This is the case a UTC-day loop loses: 00:15 IST is the previous UTC day.
    const s = schedule({ kind: "daily", times: ["00:15"] });
    const found = occurrencesBetween(s, at("2026-09-05T00:00:00Z"), at("2026-09-06T00:00:00Z"));

    assert.deepEqual(
      found.map((d) => d.toISOString()),
      ["2026-09-05T18:45:00.000Z"],
    );
    assert.equal(wallClockIn(found[0]!, KOLKATA).day, 6);
  });

  it("narrows to the given weekdays", () => {
    // A tablet taken Monday, Wednesday, Friday.
    const s = schedule({ kind: "daily", times: ["08:00"], days: [1, 3, 5] });
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-13T00:00:00Z"));

    const weekdays = found.map((d) => wallClockIn(d, KOLKATA).weekday);
    assert.deepEqual(weekdays, [1, 3, 5]);
  });

  it("reads the weekday from where the reminder lands, not from UTC", () => {
    // 00:15 Monday IST is Sunday evening in UTC. A Monday-only reminder must
    // still fire, and a Sunday-only one must not.
    const monday = schedule({ kind: "daily", times: ["00:15"], days: [1] });
    const sunday = schedule({ kind: "daily", times: ["00:15"], days: [0] });
    const from = at("2026-09-06T00:00:00Z");
    const to = at("2026-09-08T00:00:00Z");

    assert.equal(occurrencesBetween(monday, from, to).length, 1);
    assert.equal(occurrencesBetween(sunday, from, to).length, 0);
  });

  it("deduplicates and orders the times", () => {
    const s = schedule({ kind: "daily", times: ["20:00", "08:00", "08:00"] });
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-07T00:00:00Z"));
    assert.equal(found.length, 2);
    assert.ok(found[0]!.getTime() < found[1]!.getTime());
  });

  it("drops a malformed time without losing the others", () => {
    // A stored schedule is data that may predate a validation rule. One bad
    // entry must not stop the rest of the reminders in it from firing.
    const s = schedule({ kind: "daily", times: ["08:00", "not a time", "25:00"] });
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-07T00:00:00Z"));
    assert.equal(found.length, 1);
  });
});

describe("the half-open window", () => {
  const s = schedule({ kind: "daily", times: ["08:00"] });
  const exact = at("2026-09-06T02:30:00Z"); // 08:00 IST precisely

  it("excludes an occurrence landing exactly on the start", () => {
    const found = occurrencesBetween(s, exact, at("2026-09-06T12:00:00Z"));
    assert.equal(found.length, 0);
  });

  it("includes one landing exactly on the end", () => {
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), exact);
    assert.equal(found.length, 1);
  });

  it("fires exactly once across two adjoining ticks", () => {
    // The property that matters: told twice means a tablet taken twice, and
    // never means nobody notices it was missed.
    const first = occurrencesBetween(s, at("2026-09-06T02:00:00Z"), exact);
    const second = occurrencesBetween(s, exact, at("2026-09-06T03:00:00Z"));
    assert.equal(first.length + second.length, 1);
  });

  it("returns nothing for an inverted or empty window", () => {
    assert.deepEqual(occurrencesBetween(s, exact, exact), []);
    assert.deepEqual(occurrencesBetween(s, at("2026-09-07T00:00:00Z"), exact), []);
  });
});

describe("one-off reminders", () => {
  it("fires inside the window and never again", () => {
    const s = schedule({ kind: "once", at: "2026-09-06T02:30:00.000Z" });
    assert.equal(
      occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-07T00:00:00Z")).length,
      1,
    );
    assert.equal(
      occurrencesBetween(s, at("2026-09-07T00:00:00Z"), at("2026-09-30T00:00:00Z")).length,
      0,
    );
  });

  it("ignores an unparseable instant rather than throwing", () => {
    const s = schedule({ kind: "once", at: "whenever" });
    assert.deepEqual(
      occurrencesBetween(s, at("2026-01-01T00:00:00Z"), at("2027-01-01T00:00:00Z")),
      [],
    );
  });
});

describe("interval reminders", () => {
  it("stays inside its waking window", () => {
    // Hydration. A prompt at 3 a.m. is not a missed nicety, it is a harm.
    const s = schedule({
      kind: "interval",
      everyMinutes: 240,
      window: { from: "08:00", to: "20:00" },
    });
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-07T00:00:00Z"));

    const hours = found.map((d) => wallClockIn(d, KOLKATA).hour);
    assert.deepEqual(hours, [8, 12, 16, 20]);
  });

  it("defaults to waking hours when no window is given", () => {
    const s = schedule({ kind: "interval", everyMinutes: 120 });
    const found = occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-07T00:00:00Z"));
    const hours = found.map((d) => wallClockIn(d, KOLKATA).hour);

    assert.ok(Math.min(...hours) >= 8, "nothing before 08:00");
    assert.ok(Math.max(...hours) <= 22, "nothing after 22:00");
  });

  it("refuses a step that would never advance", () => {
    // Zero or negative would generate the same instant forever.
    for (const everyMinutes of [0, -30, Number.NaN]) {
      const s = schedule({ kind: "interval", everyMinutes });
      assert.deepEqual(
        occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-08T00:00:00Z")),
        [],
        String(everyMinutes),
      );
    }
  });

  it("refuses a window that ends before it starts", () => {
    const s = schedule({
      kind: "interval",
      everyMinutes: 60,
      window: { from: "22:00", to: "06:00" },
    });
    assert.deepEqual(
      occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-08T00:00:00Z")),
      [],
    );
  });
});

describe("a paused schedule", () => {
  it("produces nothing while disabled — a holiday is not a deletion", () => {
    const s = schedule({ kind: "daily", times: ["08:00"] }, { enabled: false });
    assert.deepEqual(
      occurrencesBetween(s, at("2026-09-06T00:00:00Z"), at("2026-09-08T00:00:00Z")),
      [],
    );
    assert.equal(nextOccurrence(s, at("2026-09-06T00:00:00Z")), null);
  });
});

describe("the next occurrence", () => {
  it("finds today's next time", () => {
    const s = schedule({ kind: "daily", times: ["08:00", "20:00"] });
    const next = nextOccurrence(s, at("2026-09-06T03:00:00Z")); // 08:30 IST
    assert.equal(next?.toISOString(), "2026-09-06T14:30:00.000Z"); // 20:00 IST
  });

  it("rolls to the next matching weekday", () => {
    // Sunday, asking on a Sunday, for a Wednesday-only reminder.
    const s = schedule({ kind: "daily", times: ["08:00"], days: [3] });
    const next = nextOccurrence(s, at("2026-09-06T00:00:00Z"));
    assert.equal(wallClockIn(next!, KOLKATA).weekday, 3);
  });

  it("returns null for a one-off already past", () => {
    const s = schedule({ kind: "once", at: "2026-09-01T00:00:00.000Z" });
    assert.equal(nextOccurrence(s, at("2026-09-06T00:00:00Z")), null);
  });

  it("gives up rather than spinning on a schedule that can never fire", () => {
    const s = schedule({ kind: "daily", times: [], days: [1] });
    assert.equal(nextOccurrence(s, at("2026-09-06T00:00:00Z")), null);
  });
});

describe("many schedules at once", () => {
  it("returns everything due, oldest first", () => {
    // A backlog after a restart is delivered in the order it happened, not
    // grouped by whichever schedule the store returned first.
    const morning = schedule({ kind: "daily", times: ["08:00"] }, { id: "morning" });
    const evening = schedule({ kind: "daily", times: ["20:00"] }, { id: "evening" });

    const due = dueBetween(
      [evening, morning],
      at("2026-09-06T00:00:00Z"),
      at("2026-09-07T12:00:00Z"),
    );

    assert.deepEqual(
      due.map((o) => o.schedule.id),
      ["morning", "evening", "morning"],
    );
    for (let i = 1; i < due.length; i++) {
      assert.ok(due[i]!.at.getTime() >= due[i - 1]!.at.getTime());
    }
  });

  it("keeps each schedule in its own timezone", () => {
    const here = schedule({ kind: "daily", times: ["08:00"] }, { id: "kolkata" });
    const there = schedule({ kind: "daily", times: ["08:00"] }, { id: "london", timezone: LONDON });

    const due = dueBetween([here, there], at("2026-09-06T00:00:00Z"), at("2026-09-06T23:59:00Z"));
    assert.deepEqual(
      due.map((o) => o.schedule.id),
      ["kolkata", "london"],
    );
    assert.equal(wallClockIn(due[0]!.at, KOLKATA).hour, 8);
    assert.equal(wallClockIn(due[1]!.at, LONDON).hour, 8);
  });

  it("carries the capability's payload through untouched", () => {
    // The scheduler never reads it. Which medication is not its business.
    const s = schedule({ kind: "daily", times: ["08:00"] });
    const due = dueBetween([s], at("2026-09-06T00:00:00Z"), at("2026-09-07T00:00:00Z"));
    assert.deepEqual(due[0]!.schedule.payload, { medicine: "the blue one" });
  });
});
