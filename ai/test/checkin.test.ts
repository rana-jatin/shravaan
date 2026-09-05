/**
 * The daily check-in.
 *
 * Most of this file is about the one thing that is genuinely different from a
 * medication reminder: what counts as an answer. A tablet is confirmed by an
 * act the model reports; a check-in is answered by the person saying anything
 * at all, which no tool call can represent.
 *
 * The last describe is the point of the whole refactor: medication and
 * check-in running side by side on one ticker and one sweep, each climbing its
 * own ladder at its own pace, with neither aware the other exists.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkinCapability } from "../src/capabilities/checkin.ts";
import { medicationCapability } from "../src/capabilities/medication.ts";
import { registerCapabilities } from "../src/capabilities/register.ts";
import { CHECKIN_COPY, checkinNotice } from "../src/copy/checkin.ts";
import { MemoryEscalationStore } from "../src/escalation/memory-escalation-store.ts";
import { EscalationRunner } from "../src/escalation/runner.ts";
import { SessionRegistry } from "../src/orchestrator/session-registry.ts";
import { MemoryScheduleStore } from "../src/scheduler/memory-schedule-store.ts";
import { Ticker } from "../src/scheduler/ticker.ts";
import { fakeHost, invocation, makeSession, says, settle, testConfig } from "./helpers.ts";

const KOLKATA = "Asia/Kolkata";
/** 2026-09-06, 09:59 in Kolkata — a minute before a 10:00 check-in. */
const BEFORE_TEN = Date.parse("2026-09-06T04:29:00.000Z");
const MINUTE = 60_000;

const ctx = (uid = "u-anand") => invocation({ uid, host: fakeHost({ timezone: () => KOLKATA }) });

function wire(over: Parameters<typeof testConfig>[0] = {}, startAt = BEFORE_TEN) {
  let now = startAt;
  const schedules = new MemoryScheduleStore();
  const escalations = new MemoryEscalationStore();
  const sessions = new SessionRegistry();
  const lines: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];

  const wiring = registerCapabilities(
    testConfig({ checkin: { enabled: true }, ...over }),
    (level, msg, extra) => void lines.push({ level, msg, extra: extra ?? {} }),
    {
      capabilities: [medicationCapability, checkinCapability],
      schedules,
      escalations,
      sessions,
      now: () => now,
    },
  );

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

  return {
    wiring,
    schedules,
    escalations,
    sessions,
    lines,
    ticker,
    runner,
    advanceTo: (minutesAfterDue: number) => {
      now = BEFORE_TEN + minutesAfterDue * MINUTE;
    },
  };
}

describe("setting a check-in", () => {
  it("stores one schedule at the user's own local time", async () => {
    const w = wire();
    const out = await w.wiring.tools.get("set_daily_checkin")!.handler({ time: "10:00" }, ctx());

    assert.equal(out["set"], true);
    const stored = await w.schedules.forUser("u-anand");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.timezone, KOLKATA);
    assert.deepEqual(stored[0]!.recurrence.kind === "daily" ? stored[0]!.recurrence.times : [], [
      "10:00",
    ]);
  });

  it("moves the existing one rather than adding a second", async () => {
    // One person, one check-in. Two would be two mornings' worth of prompts.
    const w = wire();
    const set = w.wiring.tools.get("set_daily_checkin")!.handler;
    await set({ time: "10:00" }, ctx());
    const again = await set({ time: "9:30" }, ctx());

    assert.equal(again["moved"], true);
    assert.equal(again["time"], "09:30");
    assert.equal((await w.schedules.forUser("u-anand")).length, 1);
  });

  it("answers a time it cannot read with data", async () => {
    const w = wire();
    const out = await w.wiring.tools
      .get("set_daily_checkin")!
      .handler({ time: "in the morning" }, ctx());
    assert.deepEqual(out, { set: false, reason: "not_a_time", given: "in the morning" });
  });

  it("stores nothing about the person, only the zone a message needs", async () => {
    const w = wire();
    await w.wiring.tools.get("set_daily_checkin")!.handler({ time: "10:00" }, ctx());
    assert.deepEqual((await w.schedules.forUser("u-anand"))[0]!.payload, { timezone: KOLKATA });
  });

  it("says out loud what cancelling costs", async () => {
    // Switching this off removes the only thing that would notice a silent
    // morning, and the model should be able to say so.
    const w = wire();
    await w.wiring.tools.get("set_daily_checkin")!.handler({ time: "10:00" }, ctx());
    const out = await w.wiring.tools.get("cancel_daily_checkin")!.handler({}, ctx());

    assert.equal(out["cancelled"], true);
    assert.match(String(out["note"]), /nobody will be alerted/);
    assert.deepEqual(await w.schedules.forUser("u-anand"), []);
  });

  it("treats turning off something that was never on as data", async () => {
    const w = wire();
    const out = await w.wiring.tools.get("cancel_daily_checkin")!.handler({}, ctx());
    assert.deepEqual(out, { cancelled: false, reason: "not_set" });
  });

  it("has no confirm tool at all", () => {
    // A check-in is answered by the person SAYING ANYTHING. A tool the model
    // had to remember to call would be a thing it could forget, and the failure
    // is a family told nobody was home when somebody plainly was.
    const w = wire();
    assert.deepEqual(w.wiring.reports.find((r) => r.name === "checkin")!.tools, [
      "set_daily_checkin",
      "cancel_daily_checkin",
    ]);
  });
});

describe("what counts as an answer", () => {
  async function asked() {
    const w = wire();
    const h = makeSession({ uid: "u-anand" });
    await h.session.start();
    w.sessions.add(h.session);

    await w.wiring.tools.get("set_daily_checkin")!.handler({ time: "10:00" }, ctx());
    w.advanceTo(2);
    await w.ticker.tick();
    await w.runner.sweep();
    return { ...w, h };
  }

  it("asks the question and remembers where it asked it", async () => {
    const w = await asked();

    assert.equal(w.h.tts().said(), "नमस्ते! आज कैसा लग रहा है आपको?");
    const record = (await w.escalations.open())[0]!;
    assert.equal(record.stage, "reminded");
    assert.deepEqual(record.payload["askedAt"], {
      sid: w.h.session.sid,
      turn: w.h.session.state.turn_no,
    });
  });

  it("is answered by ANY reply, and never asks again", async () => {
    // "theek hoon", "kaun hai" and a complaint about the heat are all the same
    // answer to the only question being asked.
    const w = await asked();
    w.h.tts().emitDone();
    w.h.llm.script.push(says("Sunkar accha laga."));
    w.h.asr().utterance("garmi bahut hai aaj");
    await settle();

    w.advanceTo(25);
    const sweep = (await w.runner.sweep())!;

    assert.equal(sweep.settled, 1);
    assert.deepEqual(await w.escalations.open(), []);
    // Asked once, and only once.
    assert.equal(w.h.tts().spoken.length, 2, "the reply, and nothing else proactive");
  });

  it("does not read the reply, only that there was one", async () => {
    // One bit. A check-in that noticed how somebody sounded would be a
    // wellbeing assessment, which is ADR 0009's territory and off by default.
    const w = await asked();
    w.h.tts().emitDone();
    w.h.llm.script.push(says("Achha."));
    w.h.asr().utterance("bahut bura lag raha hai mujhe");
    await settle();

    w.advanceTo(25);
    await w.runner.sweep();

    // Settled, silently. Nothing about the words reaches a log or a message.
    assert.deepEqual(await w.escalations.open(), []);
    assert.equal(JSON.stringify(w.lines).includes("bura"), false);
  });

  it("asks again when nobody has said anything", async () => {
    const w = await asked();
    w.h.tts().emitDone();
    // The question was asked at minute 2, so the nudge is due at 22.
    w.advanceTo(23);
    await w.runner.sweep();

    assert.equal(w.h.tts().spoken.length, 2);
    assert.notEqual(w.h.tts().spoken[0], w.h.tts().spoken[1]);
    assert.equal((await w.escalations.open())[0]!.stage, "nudged");
  });

  it("does not count the device's own unprompted speech as a reply", async () => {
    // THE REGRESSION THIS FILE FOUND. `speakProactively` used to advance
    // `turn_no`, so a medication reminder spoken into the same conversation
    // read as the person answering the check-in — and the check-in settled
    // without anybody having said a word. `turn_no` counts what the PERSON
    // says; see the note in Session#speakProactively.
    const w = await asked();
    const before = w.h.session.state.turn_no;

    w.h.tts().emitDone();
    await w.h.session.speakProactively({ reason: "something_else", text: () => "Aur ek baat." });

    assert.equal(w.h.session.state.turn_no, before, "the device speaking is not the person");
    w.advanceTo(5);
    await w.runner.sweep();
    assert.equal((await w.escalations.open())[0]!.stage, "reminded", "still waiting for a reply");
  });

  it("treats a reconnected device as 'cannot tell', not as an answer", async () => {
    // A fresh session counts turns from zero, so a person happily chatting in a
    // new one could otherwise read as never having answered — or, worse, a new
    // session with a high turn count could read as an answer nobody gave.
    const w = await asked();
    w.sessions.remove(w.h.session.sid);
    w.h.session.close("device_disconnected");

    const replacement = makeSession({ uid: "u-anand" });
    await replacement.session.start();
    w.sessions.add(replacement.session);

    w.advanceTo(5);
    await w.runner.sweep();
    assert.equal((await w.escalations.open())[0]!.stage, "reminded", "not settled by a stranger");

    // And it is not a dead end: the nudge asks again in the new conversation.
    w.advanceTo(23);
    await w.runner.sweep();
    assert.equal(replacement.tts().spoken.length, 1);
    assert.equal(
      ((await w.escalations.open())[0]!.payload["askedAt"] as { sid: string }).sid,
      replacement.session.sid,
    );

    replacement.session.close("test");
  });

  it("tells somebody when the morning stays silent", async () => {
    const w = await asked();
    w.h.tts().emitDone();
    w.advanceTo(23);
    await w.runner.sweep();

    // Nudged at 23, and the alert is due forty minutes after that.
    w.h.tts().emitDone();
    w.advanceTo(64);
    const sweep = (await w.runner.sweep())!;

    // No contacts configured here, so the ladder reports that rather than
    // silently claiming it told somebody.
    assert.equal(sweep.withheld, 1);
    assert.equal((await w.escalations.open())[0]!.lastRefusal, "no_contacts");
  });
});

describe("what the family is told", () => {
  const base = { askedAt: new Date(BEFORE_TEN + MINUTE), timezone: KOLKATA, attempts: 2 };

  it("reports silence and nothing else about the person", () => {
    const notice = checkinNotice({ ...base, everSpoken: true });
    assert.match(notice.body, /only knows that nobody answered/);
    assert.match(notice.body, /has not listened to anything/);
  });

  it("distinguishes 'we asked and heard nothing' from 'we never reached them'", () => {
    assert.match(checkinNotice({ ...base, everSpoken: true }).body, /said hello/);
    assert.match(checkinNotice({ ...base, everSpoken: false }).body, /never able to speak/);
  });

  it("suggests the thing that would actually help", () => {
    assert.match(checkinNotice({ ...base, everSpoken: true }).body, /phone call/);
  });

  it("has reviewed copy for the two languages it can ship in", () => {
    for (const key of ["ask", "nudge"] as const) {
      assert.equal(CHECKIN_COPY[key]["hi-IN"]!.needsNativeReview, false);
      assert.equal(CHECKIN_COPY[key]["en-IN"]!.needsNativeReview, false);
    }
  });
});

describe("two capabilities, one machine", () => {
  it("runs a check-in and a medication reminder side by side, at their own paces", async () => {
    // The point of the whole refactor. One ticker, one sweep, two ladders with
    // different timings and different ideas of what an answer is, and neither
    // capability knows the other exists.
    const w = wire({ checkin: { enabled: true }, medication: { enabled: true } });
    const h = makeSession({ uid: "u-anand" });
    await h.session.start();
    w.sessions.add(h.session);

    await w.wiring.tools.get("set_daily_checkin")!.handler({ time: "10:00" }, ctx());
    await w.wiring.tools
      .get("set_medication_reminder")!
      .handler({ label: "blue tablet", times: ["10:00"] }, ctx());

    w.advanceTo(2);
    const tick = (await w.ticker.tick())!;
    assert.equal(tick.dispatched, 2, "both capabilities were handed their occurrence");

    // ONE SPEAKS, NOT BOTH. The first utterance claims the conversation, so the
    // second is withheld as busy and comes back on the next sweep. That falls
    // out of `speakProactively` refusing rather than queueing, and it is the
    // behaviour worth having: two prompts with no pause between them is a
    // device talking at somebody, not to them.
    const first = (await w.runner.sweep())!;
    assert.equal(first.spoken, 1);
    assert.equal(first.withheld, 1);

    w.advanceTo(3);
    h.tts().emitDone();
    const second = (await w.runner.sweep())!;
    assert.equal(second.spoken, 1);
    assert.equal(h.tts().spoken.length, 2);

    // Fifteen minutes on: medication nudges (a 10 minute ladder), the check-in
    // does not (20 minutes). Same clock, same sweep, different patience — and
    // neither capability knows the other is there.
    h.tts().emitDone();
    w.advanceTo(15);
    await w.runner.sweep();

    assert.deepEqual(
      Object.fromEntries((await w.escalations.open()).map((e) => [e.capability, e.stage])),
      { medication: "nudged", checkin: "reminded" },
    );

    // And they end differently. The person simply talking settles the check-in;
    // the tablet still has to be confirmed.
    h.tts().emitDone();
    h.llm.script.push(says("Haan, theek hoon."));
    h.asr().utterance("main theek hoon");
    await settle();

    w.advanceTo(16);
    await w.runner.sweep();

    assert.deepEqual(
      (await w.escalations.open()).map((e) => e.capability),
      ["medication"],
    );

    await w.wiring.tools.get("confirm_medication")!.handler({}, ctx());
    assert.deepEqual(await w.escalations.open(), []);

    h.session.close("test");
  });
});
