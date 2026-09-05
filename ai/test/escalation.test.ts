/**
 * The ladder, and the sweep that climbs it.
 *
 * The ladder half is pure: a record and an event in, a record and an action
 * out, with the clock as an argument. Nothing here sleeps and nothing is
 * approximate — "ten minutes later" is a number, not a timeout.
 *
 * The sweep half is about the two things it must get right when the world does
 * not cooperate: a conversation that was busy thirty seconds ago, and a device
 * that was never reachable at all. Those are different situations and the
 * second one is the more urgent, which is the least obvious rule in the file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openEscalation, reduce } from "../src/escalation/ladder.ts";
import { MemoryEscalationStore } from "../src/escalation/memory-escalation-store.ts";
import { EscalationRunner, type EscalationHandler } from "../src/escalation/runner.ts";
import { DEFAULT_LADDER, type Escalation, type Ladder } from "../src/escalation/types.ts";

/** 2026-09-06 08:00 in Kolkata. */
const DUE = new Date("2026-09-06T02:30:00.000Z");
const MINUTE = 60_000;

const LADDER: Ladder = {
  nudgeAfterMinutes: 10,
  escalateAfterMinutes: 20,
  abandonAfterMinutes: 120,
};

const OCCURRENCE = {
  uid: "u-anand",
  capability: "medication",
  scheduleId: "sched-blue-tablet",
  dueAt: DUE,
  payload: { label: "the blue tablet" },
};

function at(minutesAfterDue: number): Date {
  return new Date(DUE.getTime() + minutesAfterDue * MINUTE);
}

/** A record parked on a rung, as if the sweep had put it there. */
function on(
  stage: Escalation["stage"],
  sinceMinutesAfterDue: number,
  over: Partial<Escalation> = {},
) {
  return {
    ...openEscalation(OCCURRENCE, DUE),
    stage,
    since: at(sinceMinutesAfterDue).toISOString(),
    ...over,
  };
}

describe("opening a reminder", () => {
  it("is identified by the occurrence, not by when it was noticed", () => {
    // Two dispatches of the same due instant — a retry, a second replica, a
    // restart mid-tick — must land on one record, not two ladders side by side.
    const first = openEscalation(OCCURRENCE, at(0));
    const second = openEscalation(OCCURRENCE, at(3));

    assert.equal(first.id, second.id);
    assert.equal(first.id, `sched-blue-tablet@${DUE.getTime()}`);
  });

  it("starts pending, unspoken, and carrying the schedule's payload", () => {
    const opened = openEscalation(OCCURRENCE, at(0));
    assert.equal(opened.stage, "pending");
    assert.equal(opened.attempts, 0);
    assert.equal(opened.dueAt, DUE.toISOString());
    assert.equal(opened.payload["label"], "the blue tablet");
  });
});

describe("climbing the ladder", () => {
  it("asks for the reminder to be spoken while it is still pending", () => {
    const step = reduce(on("pending", 0), { type: "elapsed" }, at(0.5), LADDER);
    assert.deepEqual(step.action, { kind: "speak", stage: "reminded" });
    // Asking is not doing. The record must not move until something lands.
    assert.equal(step.changed, false);
    assert.equal(step.escalation.stage, "pending");
  });

  it("keeps asking on every sweep, which is how a busy conversation recovers", () => {
    for (const minute of [0.5, 1, 5, 9.9]) {
      const step = reduce(on("pending", 0), { type: "elapsed" }, at(minute), LADDER);
      assert.equal(step.action.kind, "speak", `minute ${minute}`);
    }
  });

  it("becomes reminded once it has actually been said", () => {
    const step = reduce(on("pending", 0), { type: "spoken" }, at(1), LADDER);
    assert.equal(step.escalation.stage, "reminded");
    assert.equal(step.escalation.attempts, 1);
    assert.equal(step.escalation.since, at(1).toISOString());
    assert.equal(step.changed, true);
  });

  it("counts an attempt that did not land, and remembers why", () => {
    // "Eight attempts, all `media`" and "eight attempts, all `closed`" are
    // different situations for whoever is asked why nobody was reminded.
    const step = reduce(on("pending", 0), { type: "not_spoken", reason: "busy" }, at(1), LADDER);
    assert.equal(step.escalation.stage, "pending");
    assert.equal(step.escalation.attempts, 1);
    assert.equal(step.escalation.lastRefusal, "busy");
    assert.equal(step.changed, true);
  });

  it("forgets the refusal once something finally lands", () => {
    const refused = reduce(
      on("pending", 0),
      { type: "not_spoken", reason: "media" },
      at(1),
      LADDER,
    ).escalation;
    const spoken = reduce(refused, { type: "spoken" }, at(2), LADDER).escalation;

    assert.equal(spoken.lastRefusal, undefined);
    assert.equal(spoken.attempts, 2);
  });

  it("says it again once the nudge window has passed", () => {
    assert.equal(reduce(on("reminded", 0), { type: "elapsed" }, at(9), LADDER).action.kind, "none");
    assert.deepEqual(reduce(on("reminded", 0), { type: "elapsed" }, at(10), LADDER).action, {
      kind: "speak",
      stage: "nudged",
    });
  });

  it("tells somebody else once the nudge has gone unanswered", () => {
    assert.equal(reduce(on("nudged", 10), { type: "elapsed" }, at(29), LADDER).action.kind, "none");
    assert.deepEqual(reduce(on("nudged", 10), { type: "elapsed" }, at(30), LADDER).action, {
      kind: "notify",
    });
  });

  it("goes quiet once the family has been told", () => {
    const step = reduce(on("escalated", 30), { type: "elapsed" }, at(60), LADDER);
    assert.deepEqual(step.action, { kind: "none" });
    assert.equal(step.changed, false);
  });

  it("never descends: an extra utterance does not postpone the escalation", () => {
    // Speaking again from `nudged` moves the count but not the clock. Otherwise
    // a device that repeated itself would keep pushing the one signal that
    // matters further away.
    const nudged = on("nudged", 10);
    const step = reduce(nudged, { type: "spoken" }, at(15), LADDER);

    assert.equal(step.escalation.stage, "nudged");
    assert.equal(step.escalation.since, nudged.since);
    assert.equal(step.escalation.attempts, nudged.attempts + 1);
  });
});

describe("the rule that is easy to get backwards", () => {
  it("escalates a reminder it could never say, without ever nudging it", () => {
    // Silence from a device that was never able to speak is not evidence about
    // the person. Treating it as if it were would delay the only useful signal.
    const step = reduce(on("pending", 0), { type: "elapsed" }, at(10), LADDER);
    assert.deepEqual(step.action, { kind: "notify" });
  });

  it("does not pretend an unreachable device was ever reminded", () => {
    const notified = reduce(on("pending", 0), { type: "notified" }, at(10), LADDER);
    assert.equal(notified.escalation.stage, "escalated");
    assert.equal(notified.escalation.attempts, 0);
  });
});

describe("stopping", () => {
  it("settles the moment the person answers, from any rung", () => {
    for (const stage of ["pending", "reminded", "nudged", "escalated"] as const) {
      const step = reduce(on(stage, 0), { type: "acknowledged" }, at(5), LADDER);
      assert.equal(step.escalation.stage, "acknowledged", stage);
      assert.equal(step.escalation.reason, "answered");
      assert.deepEqual(step.action, { kind: "settle" });
    }
  });

  it("gives up when the whole thing has run too long", () => {
    // Two hours late, "take your eight o'clock tablet" is advice nobody should
    // act on, and a reminder that never stops gets the device unplugged.
    const step = reduce(on("nudged", 10), { type: "elapsed" }, at(120), LADDER);
    assert.equal(step.escalation.stage, "abandoned");
    assert.equal(step.escalation.reason, "gave_up");
    assert.deepEqual(step.action, { kind: "settle" });
  });

  it("measures giving up from when the dose was due, not from the last rung", () => {
    // A record that kept being nudged would otherwise never expire.
    const step = reduce(on("reminded", 119), { type: "elapsed" }, at(121), LADDER);
    assert.equal(step.escalation.stage, "abandoned");
  });

  it("asks for a settled record to be cleared away rather than climbing it", () => {
    const done = on("acknowledged", 5, { settledAt: at(5).toISOString() });
    const step = reduce(done, { type: "elapsed" }, at(6), LADDER);

    assert.deepEqual(step.action, { kind: "settle" });
    assert.equal(step.changed, false);
  });

  it("treats a corrupt timestamp as overdue rather than immortal", () => {
    const step = reduce(
      on("reminded", 0, { dueAt: "not a date" }),
      { type: "elapsed" },
      at(1),
      LADDER,
    );
    assert.equal(step.escalation.stage, "abandoned");
  });
});

describe("a failed notification", () => {
  it("stays where it is so the next sweep tries again", () => {
    const step = reduce(
      on("nudged", 10),
      { type: "not_notified", reason: "smtp down" },
      at(30),
      LADDER,
    );
    assert.equal(step.escalation.stage, "nudged");
    assert.equal(step.escalation.lastRefusal, "smtp down");
  });

  it("restarts the clock on the rung, so a dead relay is not retried every tick", () => {
    const failed = reduce(
      on("nudged", 10),
      { type: "not_notified", reason: "smtp down" },
      at(30),
      LADDER,
    ).escalation;

    assert.equal(reduce(failed, { type: "elapsed" }, at(40), LADDER).action.kind, "none");
    assert.equal(reduce(failed, { type: "elapsed" }, at(50), LADDER).action.kind, "notify");
  });
});

// ---------------------------------------------------------------------------

/** A handler that records what it was asked to do and answers as instructed. */
function handler(over: Partial<EscalationHandler> = {}) {
  const spoke: Array<{ id: string; stage: string }> = [];
  const told: string[] = [];
  const h: EscalationHandler = {
    ladder: LADDER,
    speak: async (e, stage) => {
      spoke.push({ id: e.id, stage });
      return { spoken: true };
    },
    notify: async (e) => {
      told.push(e.id);
      return { delivered: true };
    },
    ...over,
  };
  return { handler: h, spoke, told };
}

function runnerWith(
  handlers: Record<string, EscalationHandler>,
  opts: { at?: number; store?: MemoryEscalationStore } = {},
) {
  let now = (opts.at ?? 0.5) * MINUTE + DUE.getTime();
  const store = opts.store ?? new MemoryEscalationStore();
  const logs: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];

  const runner = new EscalationRunner({
    store,
    handlers: new Map(Object.entries(handlers)),
    now: () => now,
    log: (level, msg, extra) => void logs.push({ level, msg, extra: extra ?? {} }),
  });

  return {
    runner,
    store,
    logs,
    advanceTo: (minutesAfterDue: number) => {
      now = DUE.getTime() + minutesAfterDue * MINUTE;
    },
  };
}

describe("sweeping open reminders", () => {
  it("says a pending reminder and records that it landed", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));

    const summary = (await r.runner.sweep())!;

    assert.equal(summary.spoken, 1);
    assert.deepEqual(h.spoke, [{ id: `sched-blue-tablet@${DUE.getTime()}`, stage: "reminded" }]);
    assert.equal((await r.store.open())[0]!.stage, "reminded");
  });

  it("leaves it pending when the conversation was busy, and tries again", async () => {
    // The whole reason `speakProactively` refuses instead of queueing: the
    // retry lives here, where something also escalates if it never works.
    let busy = true;
    const h = handler({
      speak: async () => (busy ? { spoken: false, reason: "busy" } : { spoken: true }),
    });
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));

    const first = (await r.runner.sweep())!;
    assert.equal(first.withheld, 1);
    const afterFirst = (await r.store.open())[0]!;
    assert.equal(afterFirst.stage, "pending");
    assert.equal(afterFirst.attempts, 1);
    assert.equal(afterFirst.lastRefusal, "busy");

    busy = false;
    r.advanceTo(1);
    const second = (await r.runner.sweep())!;

    assert.equal(second.spoken, 1);
    assert.equal((await r.store.open())[0]!.stage, "reminded");
  });

  it("nudges, then tells the family, in that order and on the clock", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));

    await r.runner.sweep(); // spoken -> reminded
    r.advanceTo(5);
    await r.runner.sweep(); // too soon
    assert.equal(h.spoke.length, 1);

    r.advanceTo(11);
    await r.runner.sweep(); // spoken again -> nudged
    assert.deepEqual(
      h.spoke.map((s) => s.stage),
      ["reminded", "nudged"],
    );
    assert.deepEqual(h.told, []);

    r.advanceTo(20);
    await r.runner.sweep(); // still too soon
    assert.deepEqual(h.told, []);

    r.advanceTo(31);
    await r.runner.sweep();
    assert.equal(h.told.length, 1);
    assert.equal((await r.store.open())[0]!.stage, "escalated");
  });

  it("tells the family about a device it could never reach, and never claims it spoke", async () => {
    const h = handler({ speak: async () => ({ spoken: false, reason: "closed" }) });
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));

    await r.runner.sweep();
    r.advanceTo(11);
    await r.runner.sweep();

    assert.equal(h.told.length, 1);
    const record = (await r.store.open())[0]!;
    assert.equal(record.stage, "escalated");
    assert.equal(record.attempts, 1, "one attempt, none of them successful");
  });

  it("warns rather than informs when a reminder reaches the family", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put({ ...openEscalation(OCCURRENCE, DUE), stage: "nudged" });

    r.advanceTo(21);
    await r.runner.sweep();

    const advanced = r.logs.find((l) => l.msg === "reminder advanced")!;
    assert.equal(advanced.level, "warn");
    assert.equal(advanced.extra["to"], "escalated");
  });

  it("gives up and clears the record once it has run too long", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put({ ...openEscalation(OCCURRENCE, DUE), stage: "escalated" });

    r.advanceTo(121);
    const summary = (await r.runner.sweep())!;

    assert.equal(summary.settled, 1);
    assert.deepEqual(await r.store.open(), []);
    assert.equal(r.store.size, 0);
    assert.ok(r.logs.some((l) => l.msg === "reminder settled" && l.level === "warn"));
  });

  it("keeps going when a handler throws, and files the failure as a refusal", async () => {
    // One capability's broken notifier must not stop every other reminder in
    // the deployment from climbing.
    const broken = handler({
      speak: async () => {
        throw new Error("the session registry exploded");
      },
    });
    const fine = handler();
    const r = runnerWith({ medication: broken.handler, checkin: fine.handler });

    await r.store.put(openEscalation(OCCURRENCE, DUE));
    await r.store.put(
      openEscalation({ ...OCCURRENCE, capability: "checkin", scheduleId: "c1" }, DUE),
    );

    const summary = (await r.runner.sweep())!;

    assert.equal(summary.spoken, 1);
    assert.equal(summary.withheld, 1);
    assert.equal(fine.spoke.length, 1);
    const stuck = (await r.store.open()).find((e) => e.capability === "medication")!;
    assert.match(stuck.lastRefusal!, /exploded/);
  });

  it("says once, not every sweep, that a capability is missing", async () => {
    const r = runnerWith({});
    await r.store.put(openEscalation(OCCURRENCE, DUE));

    const first = (await r.runner.sweep())!;
    await r.runner.sweep();

    assert.equal(first.unhandled, 1);
    assert.equal(r.logs.filter((l) => l.msg.includes("does not run")).length, 1);
  });

  it("changes nothing when the store cannot be read", async () => {
    const store = new MemoryEscalationStore();
    await store.put(openEscalation(OCCURRENCE, DUE));
    const h = handler();
    const r = runnerWith({ medication: h.handler }, { store });
    store.open = async () => {
      throw new Error("ECONNREFUSED");
    };

    assert.equal(await r.runner.sweep(), null);
    assert.deepEqual(h.spoke, []);
    assert.equal(r.logs[0]!.level, "error");
  });

  it("refuses to run two sweeps at once", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = handler({ speak: async () => held.then(() => ({ spoken: true })) });
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));

    const first = r.runner.sweep();
    assert.equal(await r.runner.sweep(), null);

    release();
    assert.equal((await first)!.spoken, 1);
  });

  it("says nothing at all on a sweep where nothing moved", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put({ ...openEscalation(OCCURRENCE, DUE), stage: "reminded" });

    await r.runner.sweep();
    assert.deepEqual(r.logs, []);
  });

  it("starts once, stops once, and reports which it is", () => {
    const r = runnerWith({});
    assert.equal(r.runner.running, false);
    r.runner.start();
    r.runner.start();
    assert.equal(r.runner.running, true);
    r.runner.stop();
    assert.equal(r.runner.running, false);
  });
});

describe("acknowledging", () => {
  it("settles and clears every open reminder for the person who answered", async () => {
    // A morning can overlap: the eight o'clock tablet is still unacknowledged
    // when the half past eight one comes due, and "yes, done" is not a claim
    // about only one of them.
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));
    await r.store.put(openEscalation({ ...OCCURRENCE, scheduleId: "sched-white" }, DUE));

    const settled = await r.runner.acknowledge("u-anand");

    assert.equal(settled.length, 2);
    assert.ok(settled.every((e) => e.stage === "acknowledged"));
    assert.deepEqual(await r.store.open(), []);
  });

  it("can be narrowed to one capability", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler, checkin: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));
    await r.store.put(
      openEscalation({ ...OCCURRENCE, capability: "checkin", scheduleId: "c1" }, DUE),
    );

    await r.runner.acknowledge("u-anand", { capability: "medication" });

    assert.deepEqual(
      (await r.store.open()).map((e) => e.capability),
      ["checkin"],
    );
  });

  it("never touches another person's reminders", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put(openEscalation(OCCURRENCE, DUE));
    await r.store.put(openEscalation({ ...OCCURRENCE, uid: "u-meera", scheduleId: "m1" }, DUE));

    await r.runner.acknowledge("u-anand");

    assert.deepEqual(
      (await r.store.open()).map((e) => e.uid),
      ["u-meera"],
    );
  });

  it("records how far it had climbed before the answer came", async () => {
    const h = handler();
    const r = runnerWith({ medication: h.handler });
    await r.store.put({ ...openEscalation(OCCURRENCE, DUE), stage: "nudged", attempts: 2 });

    await r.runner.acknowledge("u-anand");

    const line = r.logs.find((l) => l.msg === "reminder acknowledged")!;
    assert.equal(line.extra["stage_reached"], "nudged");
    assert.equal(line.extra["attempts"], 2);
  });

  it("answers with nothing when there was nothing waiting", async () => {
    const r = runnerWith({ medication: handler().handler });
    assert.deepEqual(await r.runner.acknowledge("u-anand"), []);
  });

  it("uses the capability's own ladder, and the default is a real one", () => {
    // Pinned so a change to the shipped defaults is a deliberate edit here.
    assert.deepEqual(DEFAULT_LADDER, {
      nudgeAfterMinutes: 10,
      escalateAfterMinutes: 20,
      abandonAfterMinutes: 120,
    });
  });
});
