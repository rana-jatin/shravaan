/**
 * iCalendar parsing and get_appointments.
 *
 * The structure asserted here was taken from a LIVE Google Calendar feed
 * (Holidays in India, 524 events), not invented: all-day events as
 * `DTSTART;VALUE=DATE`, folded continuation lines, and `\,` escapes in text.
 *
 * The RRULE tests carry the most weight. A personal calendar for an older
 * person is mostly recurring — weekly physiotherapy, a monthly check-up,
 * birthdays — so an expander that quietly drops those reports a FREE DAY to
 * someone who has a hospital appointment. That is the failure this file exists
 * to prevent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCalendar, unfold } from "../src/domain/ical.ts";
import { GoogleCalendar } from "../src/providers/google-calendar.ts";
import { createGetAppointments, googleSource, icalSource } from "../src/tools/calendar.ts";
import type { HttpFetch } from "@sp-i/shared/providers/http.ts";
import { ToolRegistry, toSchema } from "../src/tools/registry.ts";
import { fakeHost, invocation, jsonFetch } from "./helpers.ts";

type HttpFetchLike = HttpFetch;

const wrap = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");

const event = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

const FROM = new Date(2026, 8, 1);
const TO = new Date(2026, 8, 30);

describe("iCal line folding", () => {
  it("rejoins a continuation line", () => {
    // Values wrap at 75 octets with a leading space. Splitting naively
    // truncates exactly the long, descriptive appointments worth reading out.
    const out = unfold("SUMMARY:Doctor appointment at the\r\n  city hospital");
    assert.deepEqual(out, ["SUMMARY:Doctor appointment at the city hospital"]);
  });

  it("treats a tab continuation the same as a space", () => {
    assert.deepEqual(unfold("SUMMARY:One\r\n\ttwo"), ["SUMMARY:Onetwo"]);
  });
});

describe("parsing a calendar", () => {
  it("reads an all-day event, as Google actually publishes them", () => {
    const ics = wrap(
      event([
        "DTSTART;VALUE=DATE:20260904",
        "DTEND;VALUE=DATE:20260905",
        "SUMMARY:Janmashtami",
        "UID:a",
      ]),
    );
    const [e] = parseCalendar(ics, FROM, TO);

    assert.equal(e?.summary, "Janmashtami");
    assert.equal(e?.allDay, true);
    assert.equal(e?.start.getFullYear(), 2026);
    assert.equal(e?.start.getMonth(), 8);
    assert.equal(e?.start.getDate(), 4);
  });

  it("reads a timed event with a location", () => {
    const ics = wrap(
      event([
        "DTSTART:20260904T103000",
        "DTEND:20260904T110000",
        "SUMMARY:Doctor",
        "LOCATION:City Hospital\\, Prayagraj",
        "UID:b",
      ]),
    );
    const [e] = parseCalendar(ics, FROM, TO);

    assert.equal(e?.allDay, false);
    assert.equal(e?.start.getHours(), 10);
    assert.equal(e?.start.getMinutes(), 30);
    // `\,` is an escape, not a literal backslash.
    assert.equal(e?.location, "City Hospital, Prayagraj");
  });

  it("skips a CANCELLED event — it must never be read out", () => {
    const ics = wrap(
      event([
        "DTSTART;VALUE=DATE:20260904",
        "SUMMARY:Cancelled visit",
        "STATUS:CANCELLED",
        "UID:c",
      ]),
      event(["DTSTART;VALUE=DATE:20260905", "SUMMARY:Real visit", "UID:d"]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.summary, "Real visit");
  });

  it("ignores events outside the window", () => {
    const ics = wrap(event(["DTSTART;VALUE=DATE:20251225", "SUMMARY:Last year", "UID:e"]));
    assert.deepEqual(parseCalendar(ics, FROM, TO), []);
  });

  it("returns events soonest first", () => {
    const ics = wrap(
      event(["DTSTART;VALUE=DATE:20260920", "SUMMARY:Later", "UID:f"]),
      event(["DTSTART;VALUE=DATE:20260903", "SUMMARY:Sooner", "UID:g"]),
    );
    assert.deepEqual(
      parseCalendar(ics, FROM, TO).map((e) => e.summary),
      ["Sooner", "Later"],
    );
  });

  it("survives junk without throwing", () => {
    assert.deepEqual(parseCalendar("", FROM, TO), []);
    assert.deepEqual(parseCalendar("<html>not a calendar</html>", FROM, TO), []);
    // No SUMMARY: nothing to say, so nothing to report.
    assert.deepEqual(
      parseCalendar(wrap(event(["DTSTART;VALUE=DATE:20260904", "UID:h"])), FROM, TO),
      [],
    );
  });
});

describe("recurring events — where a dropped rule reports a free day", () => {
  it("expands a WEEKLY appointment across the window", () => {
    const ics = wrap(
      event(["DTSTART:20260901T100000", "SUMMARY:Physiotherapy", "RRULE:FREQ=WEEKLY", "UID:w"]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.ok(out.length >= 4, `expected weekly occurrences, got ${out.length}`);
    assert.ok(out.every((e) => e.summary === "Physiotherapy"));
  });

  it("honours BYDAY so 'every Tuesday and Thursday' yields both", () => {
    const ics = wrap(
      event(["DTSTART:20260901T100000", "SUMMARY:Class", "RRULE:FREQ=WEEKLY;BYDAY=TU,TH", "UID:x"]),
    );
    const days = new Set(parseCalendar(ics, FROM, TO).map((e) => e.start.getDay()));
    assert.deepEqual([...days].sort(), [2, 4], "Tuesday and Thursday only");
  });

  it("honours COUNT", () => {
    const ics = wrap(
      event(["DTSTART:20260901T100000", "SUMMARY:Course", "RRULE:FREQ=WEEKLY;COUNT=3", "UID:y"]),
    );
    assert.equal(parseCalendar(ics, FROM, TO).length, 3);
  });

  it("honours UNTIL", () => {
    const ics = wrap(
      event([
        "DTSTART:20260901T100000",
        "SUMMARY:Treatment",
        "RRULE:FREQ=WEEKLY;UNTIL=20260916T000000Z",
        "UID:z",
      ]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.ok(out.length <= 3);
    assert.ok(out.every((e) => e.start <= new Date(2026, 8, 16)));
  });

  it("honours INTERVAL", () => {
    const ics = wrap(
      event([
        "DTSTART:20260901T100000",
        "SUMMARY:Fortnightly",
        "RRULE:FREQ=WEEKLY;INTERVAL=2",
        "UID:i",
      ]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.ok(out.length <= 3, `every other week, got ${out.length}`);
  });

  it("expands a YEARLY birthday into the right year", () => {
    const ics = wrap(
      event([
        "DTSTART;VALUE=DATE:20200910",
        "SUMMARY:Amma's birthday",
        "RRULE:FREQ=YEARLY",
        "UID:b1",
      ]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.start.getFullYear(), 2026);
    assert.equal(out[0]?.start.getDate(), 10);
  });

  it("cannot be made to spin by an endless rule", () => {
    const ics = wrap(
      event(["DTSTART:20200101T100000", "SUMMARY:Daily", "RRULE:FREQ=DAILY", "UID:d1"]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.ok(out.length > 0 && out.length < 100);
  });
});

describe("get_appointments", () => {
  function tool(body: string, status = 200, label = "mine") {
    return createGetAppointments({
      sources: [
        icalSource(label, "https://cal.test/a.ics", async () => ({
          ok: status < 300,
          status,
          text: async () => body,
        })),
      ],
      limit: 6,
    });
  }

  const ctx = () => invocation({ host: fakeHost({ timezone: () => "Asia/Kolkata" }) });

  it("says plainly when there is nothing on", async () => {
    const out = await tool(wrap()).handler({ window: "today" }, ctx());
    assert.equal(out["found"], 0);
    assert.equal(out["reason"], "nothing_scheduled");
  });

  it("throws when EVERY feed fails", async () => {
    // The critical case: reporting a free day to someone who has a hospital
    // appointment is far worse than admitting the calendar is unreachable.
    await assert.rejects(
      () => tool("", 503).handler({ window: "today" }, ctx()),
      /every calendar feed failed/,
    );
  });

  it("reports a partial answer as partial when only some feeds fail", async () => {
    const ok: HttpFetchLike = async () => ({ ok: true, status: 200, text: async () => wrap() });
    const bad: HttpFetchLike = async () => ({ ok: false, status: 500, text: async () => "" });
    const spec = createGetAppointments({
      sources: [
        icalSource("good", "https://ok.test/a.ics", ok),
        icalSource("bad", "https://bad.test/b.ics", bad),
      ],
    });
    const out = await spec.handler({ window: "week" }, ctx());

    // So the model can say "though I couldn't reach one of your calendars"
    // rather than implying the day is free.
    assert.deepEqual(out["unreachable_calendars"], ["bad"]);
  });

  it("carries the progress line waiting since slice 6", () => {
    const def = new ToolRegistry().register(tool(wrap())).get("get_appointments")!;
    assert.equal(def.progress_key, "progress.calendar");
    assert.ok(def.filler_threshold_ms < def.deadline_ms);
    assert.equal(toSchema(def).function.strict, true);
  });

  it("merges an iCal feed and an API calendar into one answer", async () => {
    // The point of the source seam: the tool cannot tell them apart, so a
    // deployment can move to the API one calendar at a time.
    //
    // Dated off the real clock, because `window` is resolved against today and
    // a hard-coded date would make this pass only during one week of 2026.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const ymd =
      `${tomorrow.getFullYear()}` +
      `${String(tomorrow.getMonth() + 1).padStart(2, "0")}` +
      `${String(tomorrow.getDate()).padStart(2, "0")}`;

    const api = new GoogleCalendar({
      auth: { mode: "api_key", key: "k" },
      // Google filters by timeMin/timeMax server-side, so the fake returns its
      // item regardless of window — which is exactly the contract under test.
      fetch: jsonFetch({
        items: [
          {
            id: "g1",
            status: "confirmed",
            summary: "From the API",
            start: { dateTime: "2026-09-03T09:00:00+05:30" },
            end: { dateTime: "2026-09-03T10:00:00+05:30" },
          },
        ],
      }),
    });
    const feed = wrap(event([`DTSTART;VALUE=DATE:${ymd}`, "SUMMARY:From the feed", "UID:merge"]));

    const spec = createGetAppointments({
      sources: [
        icalSource("feed", "https://cal.test/a.ics", async () => ({
          ok: true,
          status: 200,
          text: async () => feed,
        })),
        googleSource("api", "primary", api),
      ],
    });
    const out = await spec.handler({ window: "week" }, ctx());
    const names = (out["appointments"] as { what: string }[]).map((a) => a.what);
    assert.ok(names.includes("From the API"), names.join(", "));
    assert.ok(names.includes("From the feed"), names.join(", "));
  });
});

describe("a long-running recurrence still reaches today", () => {
  it("finds a DAILY event created years ago", () => {
    // THE REGRESSION. Stepping one day at a time from 2020 exhausts the step
    // bound before reaching 2026 and returns nothing — which reads as "you have
    // nothing on" to someone with a daily medication reminder.
    const ics = wrap(
      event(["DTSTART:20200101T080000", "SUMMARY:Tablets", "RRULE:FREQ=DAILY", "UID:old"]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.ok(out.length >= 28, `a daily event should fill the month, got ${out.length}`);
    assert.equal(out[0]?.summary, "Tablets");
  });

  it("finds a WEEKLY event created years ago", () => {
    const ics = wrap(
      event(["DTSTART:20200107T100000", "SUMMARY:Physio", "RRULE:FREQ=WEEKLY", "UID:oldw"]),
    );
    assert.ok(parseCalendar(ics, FROM, TO).length >= 4);
  });

  it("finds a MONTHLY check-up created years ago", () => {
    const ics = wrap(
      event(["DTSTART:20200115T090000", "SUMMARY:Check-up", "RRULE:FREQ=MONTHLY", "UID:oldm"]),
    );
    assert.equal(parseCalendar(ics, FROM, TO).length, 1);
  });

  it("does not resurrect a COUNT-limited rule that already finished", () => {
    // Skipping ahead must not reset the count — six sessions in 2020 are over.
    const ics = wrap(
      event([
        "DTSTART:20200101T100000",
        "SUMMARY:Six sessions",
        "RRULE:FREQ=WEEKLY;COUNT=6",
        "UID:c6",
      ]),
    );
    assert.deepEqual(parseCalendar(ics, FROM, TO), []);
  });
});

/**
 * Everything below was found by probing the parser rather than by a test
 * failing, and every one of them produced a WRONG SPOKEN ANSWER rather than a
 * crash: the right appointment on the wrong day, an appointment that does not
 * exist, or an appointment under someone else's name. None of them would look
 * like a fault from the outside — which is exactly why they are pinned here.
 */
describe("the window is half-open", () => {
  it("does not put tomorrow's all-day event inside today", () => {
    // An all-day event starts at midnight, so an inclusive end swept up the
    // start of the next day. The shipped holidays feed is ENTIRELY all-day
    // events, so "what have I got today?" reliably named tomorrow's.
    const ics = wrap(event(["DTSTART;VALUE=DATE:20260902", "SUMMARY:Tomorrow", "UID:h1"]));
    assert.deepEqual(parseCalendar(ics, new Date(2026, 8, 1), new Date(2026, 8, 2)), []);
  });

  it("still includes an event at the very start of the window", () => {
    const ics = wrap(event(["DTSTART;VALUE=DATE:20260901", "SUMMARY:Today", "UID:h2"]));
    assert.equal(parseCalendar(ics, new Date(2026, 8, 1), new Date(2026, 8, 2)).length, 1);
  });
});

describe("INTERVAL on a BYDAY rule", () => {
  it("keeps a fortnightly slot fortnightly", () => {
    // Day-stepping for BYDAY dropped INTERVAL entirely, so every other Tuesday
    // was read out as every Tuesday — inventing appointments, not dropping them.
    const ics = wrap(
      event([
        "DTSTART:20260901T100000",
        "SUMMARY:Physio",
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
        "UID:f1",
      ]),
    );
    const days = parseCalendar(ics, FROM, TO).map((e) => e.start.getDate());
    assert.deepEqual(days, [1, 15, 29]);
  });

  it("does not skip a BYDAY day that falls earlier in the week than DTSTART", () => {
    // DTSTART is a Wednesday; jumping ahead by whole weeks lands on a Wednesday
    // and would step straight past that week's Monday.
    const ics = wrap(
      event([
        "DTSTART:20200101T100000",
        "SUMMARY:Class",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
        "UID:f2",
      ]),
    );
    const days = new Set(parseCalendar(ics, FROM, TO).map((e) => e.start.getDay()));
    assert.deepEqual([...days].sort(), [1, 3], "Mondays as well as Wednesdays");
  });

  it("leaves a BYDAY course that ran out of COUNT years ago finished", () => {
    // Three occurrences a week, so the jumped-over weeks count triple.
    const ics = wrap(
      event([
        "DTSTART:20200106T100000",
        "SUMMARY:Finished course",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=900",
        "UID:f3",
      ]),
    );
    assert.deepEqual(parseCalendar(ics, FROM, TO), []);
  });
});

describe("a monthly or yearly date that does not exist every period", () => {
  it("keeps a check-up on the 31st on the 31st", () => {
    // `setMonth` on 31 January rolls to 3 March AND keeps the 3rd, so the
    // appointment drifted to a different day of the month and stayed there.
    const ics = wrap(
      event(["DTSTART:20260131T090000", "SUMMARY:Check-up", "RRULE:FREQ=MONTHLY", "UID:m1"]),
    );
    const out = parseCalendar(ics, new Date(2026, 0, 1), new Date(2027, 0, 1));
    assert.ok(
      out.every((e) => e.start.getDate() === 31),
      out.map((e) => e.start.toDateString()).join(", "),
    );
    // February, April, June, September and November have no 31st: skipped, not
    // nudged onto a neighbouring day the user has nothing on.
    assert.deepEqual(
      out.map((e) => e.start.getMonth()),
      [0, 2, 4, 6, 7, 9, 11],
    );
  });

  it("puts a 29 February birthday only in leap years", () => {
    const ics = wrap(
      event([
        "DTSTART;VALUE=DATE:20240229",
        "SUMMARY:Leap birthday",
        "RRULE:FREQ=YEARLY",
        "UID:m2",
      ]),
    );
    const out = parseCalendar(ics, new Date(2026, 0, 1), new Date(2031, 0, 1));
    assert.equal(out.length, 1);
    assert.equal(out[0]?.start.getFullYear(), 2028);
    assert.equal(out[0]?.start.getMonth(), 1);
    assert.equal(out[0]?.start.getDate(), 29);
  });
});

describe("nested components", () => {
  it("does not let a VALARM rename the appointment", () => {
    // RFC 5545 requires an email alarm to carry its own SUMMARY. Parsed flat,
    // it overwrote the event's — so the device announced "Reminder".
    const ics = wrap(
      event([
        "DTSTART:20260904T103000",
        "SUMMARY:Cardiology appointment",
        "UID:v1",
        "BEGIN:VALARM",
        "ACTION:EMAIL",
        "TRIGGER:-PT30M",
        "SUMMARY:Reminder",
        "DESCRIPTION:This is an event reminder",
        "END:VALARM",
      ]),
    );
    assert.equal(parseCalendar(ics, FROM, TO)[0]?.summary, "Cardiology appointment");
  });
});

describe("occurrences the user has already had removed", () => {
  it("honours EXDATE, repeated and comma-separated", () => {
    const ics = wrap(
      event([
        "DTSTART:20260901T100000",
        "SUMMARY:Physio",
        "RRULE:FREQ=WEEKLY",
        "EXDATE:20260908T100000,20260915T100000",
        "EXDATE:20260922T100000",
        "UID:e1",
      ]),
    );
    assert.deepEqual(
      parseCalendar(ics, FROM, TO).map((e) => e.start.getDate()),
      [1, 29],
    );
  });

  it("does not announce a moved appointment at its old time as well as its new one", () => {
    // Google publishes a rescheduled occurrence as a SECOND VEVENT sharing the
    // UID, with RECURRENCE-ID naming the slot it replaces. The parent keeps its
    // RRULE, so without suppression the user is told about both.
    const ics = wrap(
      event(["DTSTART:20260901T100000", "SUMMARY:Physio", "RRULE:FREQ=WEEKLY", "UID:r1"]),
      event([
        "DTSTART:20260910T150000",
        "SUMMARY:Physio",
        "RECURRENCE-ID:20260908T100000",
        "UID:r1",
      ]),
    );
    const out = parseCalendar(ics, FROM, TO);
    assert.equal(out.filter((e) => e.start.getDate() === 8).length, 0, "old slot is gone");
    assert.equal(out.filter((e) => e.start.getDate() === 10).length, 1, "new slot, once");
  });

  it("drops an occurrence cancelled on its own", () => {
    const ics = wrap(
      event(["DTSTART:20260901T100000", "SUMMARY:Physio", "RRULE:FREQ=WEEKLY", "UID:r2"]),
      event([
        "DTSTART:20260908T100000",
        "SUMMARY:Physio",
        "RECURRENCE-ID:20260908T100000",
        "STATUS:CANCELLED",
        "UID:r2",
      ]),
    );
    assert.deepEqual(
      parseCalendar(ics, FROM, TO).map((e) => e.start.getDate()),
      [1, 15, 22, 29],
    );
  });

  it("does not let an override delete itself when only the name changed", () => {
    // The override's DTSTART equals its own RECURRENCE-ID, so applying the
    // suppression to it would erase the appointment it exists to describe.
    const ics = wrap(
      event(["DTSTART:20260901T100000", "SUMMARY:Physio", "RRULE:FREQ=WEEKLY", "UID:r3"]),
      event([
        "DTSTART:20260908T100000",
        "SUMMARY:Physio with Dr Rao",
        "RECURRENCE-ID:20260908T100000",
        "UID:r3",
      ]),
    );
    const eighth = parseCalendar(ics, FROM, TO).filter((e) => e.start.getDate() === 8);
    assert.equal(eighth.length, 1);
    assert.equal(eighth[0]?.summary, "Physio with Dr Rao");
  });
});
