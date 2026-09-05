/**
 * Medication reminders, end to end.
 *
 * The last describe in this file is the one that matters: a person asks for a
 * reminder, the clock reaches it, the device says it into a real `Session`, and
 * saying "I've taken it" stops the family being told. Every machine built over
 * the last five steps is in that path, and none of them is faked.
 *
 * The describes above it are the parts that machine is made of, and most of
 * them are about refusing to be clever — the label is not corrected, the dose
 * is not inferred, nothing is written down about what anybody took.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { medicationCapability } from "../src/capabilities/medication.ts";
import { registerCapabilities } from "../src/capabilities/register.ts";
import { MEDICATION_COPY, familyNotice } from "../src/copy/medication.ts";
import { MemoryEscalationStore } from "../src/escalation/memory-escalation-store.ts";
import { EscalationRunner } from "../src/escalation/runner.ts";
import { SessionRegistry } from "../src/orchestrator/session-registry.ts";
import { MemoryScheduleStore } from "../src/scheduler/memory-schedule-store.ts";
import { Ticker } from "../src/scheduler/ticker.ts";
import {
  createCancelMedicationReminder,
  createConfirmMedication,
  createListMedicationReminders,
  createSetMedicationReminder,
  type MedicationDeps,
} from "../src/tools/medication.ts";
import { fakeHost, invocation, makeSession, testConfig } from "./helpers.ts";

const KOLKATA = "Asia/Kolkata";
/** 2026-09-06, 07:59 in Kolkata — a minute before an 08:00 dose. */
const BEFORE_EIGHT = Date.parse("2026-09-06T02:29:00.000Z");
const MINUTE = 60_000;

function deps(over: Partial<MedicationDeps> = {}) {
  const lines: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];
  const d: MedicationDeps = {
    schedules: new MemoryScheduleStore(),
    escalations: new MemoryEscalationStore(),
    maxPerUser: 12,
    log: (level, msg, extra) => void lines.push({ level, msg, extra: extra ?? {} }),
    ...over,
  };
  return { deps: d, lines };
}

const ctx = (uid = "u-anand") => invocation({ uid, host: fakeHost({ timezone: () => KOLKATA }) });

describe("setting a reminder", () => {
  it("stores the label exactly as the user said it", async () => {
    // "my sugar medicine" is not a drug name and must not become one. Matching
    // it against a list would make this a system that gives medical advice.
    const { deps: d } = deps();
    const out = await createSetMedicationReminder(d).handler(
      { label: "  my   sugar medicine ", times: ["08:00"] },
      ctx(),
    );

    assert.equal(out["set"], true);
    assert.equal(out["label"], "my sugar medicine");
    const stored = await d.schedules.forUser("u-anand");
    assert.equal(stored[0]!.payload["label"], "my sugar medicine");
  });

  it("uses the user's timezone, never the server's", async () => {
    // A local 08:00 treated as UTC fires at half past one in the morning here.
    const { deps: d } = deps();
    await createSetMedicationReminder(d).handler({ label: "blue tablet", times: ["08:00"] }, ctx());
    assert.equal((await d.schedules.forUser("u-anand"))[0]!.timezone, KOLKATA);
  });

  it("pads and de-duplicates times so one moment is one reminder", async () => {
    const { deps: d } = deps();
    const out = await createSetMedicationReminder(d).handler(
      { label: "blue tablet", times: ["8:00", "08:00", "20:00"] },
      ctx(),
    );
    assert.deepEqual(out["times"], ["08:00", "20:00"]);
  });

  it("reports times it could not read as data, and keeps the ones it could", async () => {
    const { deps: d } = deps();
    const out = await createSetMedicationReminder(d).handler(
      { label: "blue tablet", times: ["08:00", "morning", "25:00"] },
      ctx(),
    );

    assert.equal(out["set"], true);
    assert.deepEqual(out["times"], ["08:00"]);
    assert.deepEqual(out["ignored"], ["morning", "25:00"]);
  });

  it("says so rather than failing when nothing was a time", async () => {
    const { deps: d } = deps();
    const out = await createSetMedicationReminder(d).handler(
      { label: "blue tablet", times: ["whenever"] },
      ctx(),
    );
    assert.deepEqual(out, { set: false, reason: "no_valid_times", rejected: ["whenever"] });
  });

  it("replaces a reminder with the same label instead of adding a second", async () => {
    // Two reminders for one tablet is two prompts, and the second one is the
    // device sounding broken.
    const { deps: d } = deps();
    const set = createSetMedicationReminder(d).handler;
    await set({ label: "Blue Tablet", times: ["08:00"] }, ctx());
    const again = await set({ label: "blue tablet", times: ["09:00"] }, ctx());

    assert.equal(again["replaced"], true);
    const stored = await d.schedules.forUser("u-anand");
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]!.recurrence.kind === "daily" ? stored[0]!.recurrence.times : [], [
      "09:00",
    ]);
  });

  it("refuses past the cap rather than accepting and ignoring", async () => {
    // A cap the user cannot see is a reminder they believe is set.
    const { deps: d } = deps({ maxPerUser: 2 });
    const set = createSetMedicationReminder(d).handler;
    await set({ label: "one", times: ["08:00"] }, ctx());
    await set({ label: "two", times: ["09:00"] }, ctx());
    const third = await set({ label: "three", times: ["10:00"] }, ctx());

    assert.equal(third["set"], false);
    assert.equal(third["reason"], "too_many");
    assert.equal(third["limit"], 2);
  });

  it("treats every weekday as no restriction at all", async () => {
    const { deps: d } = deps();
    const out = await createSetMedicationReminder(d).handler(
      { label: "blue tablet", times: ["08:00"], days: [0, 1, 2, 3, 4, 5, 6] },
      ctx(),
    );
    assert.equal(out["days"], undefined);
  });

  it("keeps the days when they are a real restriction", async () => {
    const { deps: d } = deps();
    const out = await createSetMedicationReminder(d).handler(
      { label: "blue tablet", times: ["08:00"], days: [1, 3, 5, 3] },
      ctx(),
    );
    assert.deepEqual(out["days"], [1, 3, 5]);
  });

  it("never writes the label to the log", async () => {
    // What somebody takes is the most sensitive thing this capability touches,
    // and a log line is the easiest place for it to end up unconsented.
    const { deps: d, lines } = deps();
    await createSetMedicationReminder(d).handler({ label: "Ecosprin 75", times: ["08:00"] }, ctx());
    assert.equal(JSON.stringify(lines).includes("Ecosprin"), false);
  });

  it("keeps one person's reminders out of another's", async () => {
    const { deps: d } = deps();
    const set = createSetMedicationReminder(d).handler;
    await set({ label: "mine", times: ["08:00"] }, ctx("u-anand"));
    await set({ label: "theirs", times: ["08:00"] }, ctx("u-meera"));

    const listed = await createListMedicationReminders(d).handler({}, ctx("u-anand"));
    assert.deepEqual(
      (listed["reminders"] as Array<{ label: string }>).map((r) => r.label),
      ["mine"],
    );
  });
});

describe("listing and cancelling", () => {
  it("lists what was set, times and all", async () => {
    const { deps: d } = deps();
    await createSetMedicationReminder(d).handler(
      { label: "blue tablet", times: ["08:00", "20:00"], days: [1, 3] },
      ctx(),
    );

    const out = await createListMedicationReminders(d).handler({}, ctx());
    assert.deepEqual(out["reminders"], [
      { label: "blue tablet", times: ["08:00", "20:00"], days: [1, 3], paused: false },
    ]);
  });

  it("cancels by the label the user uses, whatever the case", async () => {
    const { deps: d } = deps();
    await createSetMedicationReminder(d).handler({ label: "blue tablet", times: ["08:00"] }, ctx());
    const out = await createCancelMedicationReminder(d).handler({ label: "Blue Tablet" }, ctx());

    assert.equal(out["cancelled"], true);
    assert.deepEqual(await d.schedules.forUser("u-anand"), []);
  });

  it("answers a label it does not have with data, and says what it does have", async () => {
    const { deps: d } = deps();
    await createSetMedicationReminder(d).handler({ label: "blue tablet", times: ["08:00"] }, ctx());
    const out = await createCancelMedicationReminder(d).handler({ label: "white one" }, ctx());

    assert.equal(out["cancelled"], false);
    assert.equal(out["reason"], "no_such_reminder");
    assert.deepEqual(out["have"], ["blue tablet"]);
  });
});

describe("confirming", () => {
  it("answers nothing-waiting with data, not an error", async () => {
    // Somebody saying "I've taken my tablet" in the middle of an unrelated
    // conversation is being sociable, not answering a prompt.
    const { deps: d } = deps();
    const out = await createConfirmMedication(d).handler({}, ctx());
    assert.deepEqual(out, { confirmed: 0, reason: "nothing_waiting" });
  });

  it("writes down nothing about what was taken", async () => {
    // The record is DELETED. "Did I take it on Tuesday" has no answer here,
    // deliberately — the same rule as game scores.
    const { deps: d } = deps();
    const escalations = d.escalations as MemoryEscalationStore;
    const { openEscalation } = await import("../src/escalation/ladder.ts");
    await escalations.put(
      openEscalation(
        {
          uid: "u-anand",
          capability: "medication",
          scheduleId: "s1",
          dueAt: new Date(BEFORE_EIGHT),
          payload: { label: "blue tablet" },
        },
        new Date(BEFORE_EIGHT),
      ),
    );

    const out = await createConfirmMedication(d).handler({}, ctx());
    assert.equal(out["confirmed"], 1);
    assert.equal(escalations.size, 0);
  });
});

describe("the capability", () => {
  function wire(over: Parameters<typeof testConfig>[0] = {}) {
    const schedules = new MemoryScheduleStore();
    const escalations = new MemoryEscalationStore();
    const sessions = new SessionRegistry();
    const lines: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];

    const wiring = registerCapabilities(
      testConfig({ medication: { enabled: true }, ...over }),
      (level, msg, extra) => void lines.push({ level, msg, extra: extra ?? {} }),
      { capabilities: [medicationCapability], schedules, escalations, sessions },
    );

    return { wiring, schedules, escalations, sessions, lines };
  }

  it("is off unless a deployment turned it on", () => {
    assert.equal(medicationCapability.isConfigured(testConfig()), false);
    assert.equal(
      medicationCapability.isConfigured(testConfig({ medication: { enabled: true } })),
      true,
    );
  });

  it("registers four tools and both handlers", () => {
    const { wiring } = wire();
    assert.deepEqual(
      wiring.tools.all().map((t) => t.name),
      [
        "set_medication_reminder",
        "list_medication_reminders",
        "cancel_medication_reminder",
        "confirm_medication",
      ],
    );
    assert.ok(wiring.occurrenceHandlers.has("medication"));
    assert.ok(wiring.escalationHandlers.has("medication"));
  });

  it("runs with reminders on and the family half off, and says which", () => {
    // Unlike emergency alerting, half-configured is ALLOWED here: a reminder
    // with nobody to escalate to still does the main job.
    const { wiring, lines } = wire();
    const armed = lines.find((l) => l.msg === "medication reminders ARMED")!;

    assert.equal(armed.level, "warn");
    assert.deepEqual(armed.extra["escalates_to"], []);
    assert.match(String(armed.extra["effect"]), /nobody is told/);
    assert.equal(wiring.reports[0]!.detail["medication"], "reminders only");
  });

  it("takes its ladder from config", () => {
    const { wiring } = wire({ medication: { enabled: true, nudgeAfterMinutes: 3 } });
    assert.equal(wiring.escalationHandlers.get("medication")!.ladder.nudgeAfterMinutes, 3);
  });

  it("opens a ladder when an occurrence lands, and says nothing itself", async () => {
    // One code path speaks, and it is the sweep. Speaking here too would mean
    // the first attempt followed different rules from the retry.
    const { wiring, escalations } = wire();
    const schedule = {
      id: "s1",
      uid: "u-anand",
      capability: "medication",
      payload: { label: "blue tablet" },
      timezone: KOLKATA,
      recurrence: { kind: "daily" as const, times: ["08:00"] },
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
    };

    await wiring.occurrenceHandlers.get("medication")!({
      schedule,
      at: new Date(BEFORE_EIGHT + MINUTE),
    });

    const open = await escalations.open();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.stage, "pending");
    assert.equal(open[0]!.payload["label"], "blue tablet");
    // The zone travels with the record: by the time the family is emailed, the
    // schedule may have been deleted.
    assert.equal(open[0]!.payload["timezone"], KOLKATA);
  });

  it("reports no live session rather than pretending it spoke", async () => {
    const { wiring } = wire();
    const result = await wiring.escalationHandlers.get("medication")!.speak(
      {
        id: "x",
        uid: "u-nobody",
        capability: "medication",
        scheduleId: "s1",
        dueAt: new Date(BEFORE_EIGHT).toISOString(),
        stage: "pending",
        since: new Date(BEFORE_EIGHT).toISOString(),
        attempts: 0,
        payload: { label: "blue tablet" },
      },
      "reminded",
    );

    assert.deepEqual(result, { spoken: false, reason: "no_session" });
  });

  it("says there is nobody to tell rather than reporting a delivery", async () => {
    const { wiring } = wire();
    const result = await wiring.escalationHandlers.get("medication")!.notify({
      id: "x",
      uid: "u-anand",
      capability: "medication",
      scheduleId: "s1",
      dueAt: new Date(BEFORE_EIGHT).toISOString(),
      stage: "nudged",
      since: new Date(BEFORE_EIGHT).toISOString(),
      attempts: 2,
      payload: { label: "blue tablet", timezone: KOLKATA },
    });

    assert.deepEqual(result, { delivered: false, reason: "no_contacts" });
  });
});

describe("what the family is actually told", () => {
  const base = {
    label: "blue tablet",
    dueAt: new Date(BEFORE_EIGHT + MINUTE),
    timezone: KOLKATA,
    attempts: 2,
  };

  it("does not claim a dose was missed, because the device does not know that", () => {
    // It knows it asked and heard nothing. A family member reading "missed
    // dose" would act on a claim nothing here ever made.
    const notice = familyNotice({ ...base, everSpoken: true });
    assert.match(notice.body, /not a report that they missed it/);
    assert.equal(/missed (their|the) dose/i.test(notice.body), false);
  });

  it("distinguishes 'we told them and heard nothing' from 'we never reached them'", () => {
    const spoken = familyNotice({ ...base, everSpoken: true });
    const never = familyNotice({ ...base, everSpoken: false });

    assert.match(spoken.body, /reminded them/);
    assert.match(never.body, /could not reach them at all/);
  });

  it("renders the time in the user's zone, not the server's", () => {
    // 02:30 UTC is eight in the morning in Kolkata, which is the only version
    // of that time anybody reading the message can act on.
    assert.match(familyNotice({ ...base, everSpoken: true }).body, /8:00 am/i);
  });

  it("carries a short form that is not the body cut off mid-sentence", () => {
    const notice = familyNotice({ ...base, everSpoken: true });
    assert.ok(notice.short.length < 200);
    assert.match(notice.short, /check on them/i);
    assert.equal(notice.body.startsWith(notice.short), false);
  });
});

describe("a reminder, from asking for it to confirming it", () => {
  it("carries all the way through and stops when the person answers", async () => {
    const schedules = new MemoryScheduleStore();
    const escalations = new MemoryEscalationStore();
    const sessions = new SessionRegistry();
    const told: string[] = [];
    let now = BEFORE_EIGHT;

    const wiring = registerCapabilities(testConfig({ medication: { enabled: true } }), undefined, {
      capabilities: [medicationCapability],
      schedules,
      escalations,
      sessions,
      now: () => now,
    });

    // A real conversation, with fake providers.
    const h = makeSession({ uid: "u-anand" });
    await h.session.start();
    sessions.add(h.session);

    // 1. The person asks for the reminder, through the tool the model calls.
    const set = wiring.tools.get("set_medication_reminder")!;
    const out = await set.handler({ label: "blue tablet", times: ["08:00"] }, ctx("u-anand"));
    assert.equal(out["set"], true);

    // 2. The clock reaches it.
    const ticker = new Ticker({
      store: schedules,
      handlers: wiring.occurrenceHandlers,
      now: () => now,
    });
    now = BEFORE_EIGHT + 2 * MINUTE;
    const tick = (await ticker.tick())!;
    assert.equal(tick.dispatched, 1, "the occurrence reached the capability");
    assert.equal((await escalations.open())[0]!.stage, "pending");

    // 3. The sweep says it, into the live session, in that session's language.
    const runner = new EscalationRunner({
      store: escalations,
      handlers: wiring.escalationHandlers,
      now: () => now,
      log: (level, msg) => void (level === "warn" ? told.push(msg) : undefined),
    });
    const sweep = (await runner.sweep())!;

    assert.equal(sweep.spoken, 1);
    assert.equal(h.tts().said(), "blue tablet लेने का समय हो गया है।");
    assert.equal((await escalations.open())[0]!.stage, "reminded");

    // 4. The person answers, and the ladder stops before anybody is emailed.
    h.tts().emitDone();
    const confirmed = await wiring.tools.get("confirm_medication")!.handler({}, ctx("u-anand"));

    assert.deepEqual(confirmed, { confirmed: 1, labels: ["blue tablet"] });
    assert.deepEqual(await escalations.open(), []);

    // 5. Half an hour later, nothing happens — there is nothing left to climb.
    now = BEFORE_EIGHT + 35 * MINUTE;
    assert.deepEqual((await runner.sweep())!.open, 0);
    assert.deepEqual(told, []);

    h.session.close("test");
  });

  it("nudges once, then tells the family, when nobody ever answers", async () => {
    const schedules = new MemoryScheduleStore();
    const escalations = new MemoryEscalationStore();
    const sessions = new SessionRegistry();
    let now = BEFORE_EIGHT;

    const wiring = registerCapabilities(testConfig({ medication: { enabled: true } }), undefined, {
      capabilities: [medicationCapability],
      schedules,
      escalations,
      sessions,
      now: () => now,
    });

    const h = makeSession({ uid: "u-anand" });
    await h.session.start();
    sessions.add(h.session);

    await wiring.tools
      .get("set_medication_reminder")!
      .handler({ label: "blue tablet", times: ["08:00"] }, ctx("u-anand"));

    const ticker = new Ticker({
      store: schedules,
      handlers: wiring.occurrenceHandlers,
      now: () => now,
    });
    const runner = new EscalationRunner({
      store: escalations,
      handlers: wiring.escalationHandlers,
      now: () => now,
    });

    now = BEFORE_EIGHT + 2 * MINUTE;
    await ticker.tick();
    await runner.sweep();
    assert.equal(h.tts().spoken.length, 1);

    // Ten minutes on, the nudge — and it is NOT the same sentence. A device
    // that repeats itself word for word sounds broken, and tells somebody who
    // did hear the first one that they were not listening.
    h.tts().emitDone();
    now = BEFORE_EIGHT + 13 * MINUTE;
    await runner.sweep();

    assert.equal(h.tts().spoken.length, 2);
    assert.notEqual(h.tts().spoken[0], h.tts().spoken[1]);
    assert.equal((await escalations.open())[0]!.stage, "nudged");

    // Twenty more, and with nobody to email the ladder says so rather than
    // silently claiming success.
    h.tts().emitDone();
    now = BEFORE_EIGHT + 34 * MINUTE;
    const sweep = (await runner.sweep())!;

    assert.equal(sweep.withheld, 1);
    assert.equal((await escalations.open())[0]!.lastRefusal, "no_contacts");

    h.session.close("test");
  });

  it("has reviewed copy for the two languages it can ship in", () => {
    // Nine of eleven are machine-drafted and the boot log says so. These two
    // are the ones a native speaker has signed off, and a reminder is not a
    // sentence to guess at.
    for (const key of ["reminder", "nudge"] as const) {
      assert.equal(MEDICATION_COPY[key]["hi-IN"]!.needsNativeReview, false);
      assert.equal(MEDICATION_COPY[key]["en-IN"]!.needsNativeReview, false);
    }
  });
});
