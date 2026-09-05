/**
 * An alert somebody else raised, all the way to a family message.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PATH UNDER TEST CROSSES THREE MACHINES AND TWO PROCESSES. A band reports
 * a reading to the safety service; that service checks it against its bands and
 * writes an alert row; the watcher here picks it up and opens a ladder; the
 * sweep asks the person; the family is told if nobody answers. Nothing in this
 * package saw the reading, and nothing in that service knows a conversation
 * exists.
 *
 * WHAT THE ASSERTIONS ARE FOR. Two of them are about numbers not being spoken —
 * the sentence the person hears carries none, the message the family gets
 * carries all of them — because that asymmetry IS the design and it is one
 * `t()` call away from being lost. The rest are about the loop not doing the
 * same thing twice: an alert seen on ten consecutive polls is one ladder, and
 * a ladder that ends closes the row that started it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MemoryEscalationStore } from "../src/escalation/memory-escalation-store.ts";
import { EscalationRunner, type EscalationHandler } from "../src/escalation/runner.ts";
import { registerCapabilities } from "../src/capabilities/register.ts";
import { vitalsCapability } from "../src/capabilities/vitals.ts";
import { AlertWatcher } from "../src/vitals/alert-watcher.ts";
import { copyKeysFor, VITALS_COPY, vitalsNotice } from "../src/copy/vitals.ts";
import { t } from "../src/i18n/resolve.ts";
import { SessionRegistry, type LiveSession } from "../src/orchestrator/session-registry.ts";
import type { AlertFeed, OwnedAlert, RemoteAlert } from "../src/providers/elderguard.ts";
import { testConfig } from "./helpers.ts";

const MINUTE = 60_000;

function alert(over: Partial<OwnedAlert> = {}): OwnedAlert {
  return {
    id: "alert-1",
    uid: "u1",
    device_id: "d1",
    alert_type: "anomaly",
    status: "open",
    source: "telemetry",
    details: {
      observed_at: "2026-09-01T09:00:00.000Z",
      readings: [{ metric: "heart_rate_bpm", value: 195, direction: "high", threshold: 180 }],
    },
    created_at: "2026-09-01T09:00:05.000Z",
    ...over,
  };
}

class FakeFeed implements AlertFeed {
  alerts: OwnedAlert[] = [];
  readonly settled: Array<{ uid: string; id: string; status: string }> = [];
  polls = 0;
  failWith: Error | null = null;

  async allOpen(): Promise<OwnedAlert[]> {
    this.polls++;
    if (this.failWith) throw this.failWith;
    return this.alerts;
  }
  async open(): Promise<RemoteAlert[]> {
    return this.alerts;
  }
  async settle(uid: string, id: string, status: "acknowledged" | "resolved"): Promise<void> {
    this.settled.push({ uid, id, status });
    // What the real service does: a settled alert leaves the open feed.
    this.alerts = this.alerts.filter((a) => a.id !== id);
  }
}

/** A LiveSession that records what it was asked to say. */
function fakeSession(over: Partial<LiveSession> = {}): LiveSession & { said: string[] } {
  const said: string[] = [];
  const state = { turn_no: 3, last_activity_at: new Date().toISOString() };
  return {
    sid: "s1",
    uid: "u1",
    closed: false,
    said,

    state: state as any,
    speakProactively: async (speech) => {
      said.push(speech.text("hi-IN"));
      return { spoken: true };
    },
    ...over,
  } as LiveSession & { said: string[] };
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

describe("watching for alerts nobody here raised", () => {
  function watcher(feed: AlertFeed, store: MemoryEscalationStore, now = () => 0) {
    return new AlertWatcher({ feed, escalations: store, capability: "vitals", now });
  }

  it("opens a ladder for an out-of-range reading", async () => {
    const feed = new FakeFeed();
    feed.alerts = [alert()];
    const store = new MemoryEscalationStore();

    const summary = await watcher(feed, store).poll();

    assert.deepEqual(summary, { seen: 1, opened: 1, known: 0, skipped: 0 });
    const open = await store.open();
    assert.equal(open.length, 1);
    assert.equal(open[0]?.uid, "u1");
    assert.equal(open[0]?.capability, "vitals");
    assert.equal(open[0]?.payload["alert_id"], "alert-1");
  });

  it("opens exactly one ladder however many times it sees the same alert", async () => {
    // The alert stays open on the service until the ladder ends, so the feed
    // returns it on every poll. Ten polls is one question, not ten.
    const feed = new FakeFeed();
    feed.alerts = [alert()];
    const store = new MemoryEscalationStore();
    const w = watcher(feed, store);

    for (let i = 0; i < 10; i++) await w.poll();

    assert.equal((await store.open()).length, 1);
  });

  it("dates the record from when it was first seen, not when it was raised", async () => {
    // THE FAILURE THIS PREVENTS. After an outage the feed hands over alerts
    // hours old, and dating the ladder from `created_at` would put it straight
    // past the nudge window — a family told before the device said one word.
    const feed = new FakeFeed();
    feed.alerts = [alert({ created_at: "2026-09-01T09:00:00.000Z" })];
    const store = new MemoryEscalationStore();
    const seenAt = Date.parse("2026-09-01T15:00:00.000Z");

    await watcher(feed, store, () => seenAt).poll();

    assert.equal(new Date((await store.open())[0]!.since).getTime(), seenAt);
  });

  it("leaves an SOS alone", async () => {
    // The safety service already emailed the family the moment the button was
    // pressed, and the emergency capability owns what the device says about an
    // alarm. Two systems narrating one event to a frightened person is worse
    // than one of them staying quiet.
    const feed = new FakeFeed();
    feed.alerts = [alert({ alert_type: "sos" })];
    const store = new MemoryEscalationStore();

    const summary = await feedPoll(feed, store);
    assert.deepEqual(summary, { seen: 1, opened: 0, known: 0, skipped: 1 });
    assert.deepEqual(await store.open(), []);
  });

  async function feedPoll(feed: AlertFeed, store: MemoryEscalationStore) {
    return watcher(feed, store).poll();
  }

  it("says the service is unreachable once, not once every thirty seconds", async () => {
    const feed = new FakeFeed();
    feed.failWith = new Error("ECONNREFUSED");
    const lines: string[] = [];
    const w = new AlertWatcher({
      feed,
      escalations: new MemoryEscalationStore(),
      capability: "vitals",
      log: (level, msg) => lines.push(`${level}:${msg}`),
    });

    for (let i = 0; i < 5; i++) assert.equal(await w.poll(), null);
    assert.equal(lines.filter((l) => l.startsWith("error")).length, 1);

    // And it says so when it comes back, which is the line that matters.
    feed.failWith = null;
    await w.poll();
    assert.equal(lines.filter((l) => l.includes("reachable again")).length, 1);
  });

  it("does not start a second ladder when the store cannot be read", async () => {
    // A doubled ladder is two prompts and two family messages about one event.
    const feed = new FakeFeed();
    feed.alerts = [alert()];
    const store = new MemoryEscalationStore();
    store.get = async () => {
      throw new Error("redis is down");
    };

    const summary = await watcher(feed, store).poll();
    assert.deepEqual(summary, { seen: 1, opened: 0, known: 0, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

describe("what the person hears and what the family reads", () => {
  it("never puts a number in anything spoken", () => {
    // The record knows the pulse was 195. The sentence must not.
    for (const key of ["ask_reading", "nudge_reading", "ask_fall", "nudge_fall"] as const) {
      for (const language of Object.keys(VITALS_COPY[key])) {
        const line = t(VITALS_COPY, key, language as never);
        assert.ok(!/\d/.test(line), `${key}/${language} contains a digit: ${line}`);
      }
    }
  });

  it("names a fall, because vagueness is worst exactly there", () => {
    const keys = copyKeysFor("fall");
    assert.notEqual(keys.ask, copyKeysFor("anomaly").ask);
    assert.match(t(VITALS_COPY, keys.ask, "en-IN"), /fall/i);
  });

  it("gives the family the numbers the person was not given", () => {
    // The asymmetry IS the design: a reading is not something the person can
    // act on, and it is something the family can.
    const notice = vitalsNotice({
      kind: "anomaly",
      observedAt: new Date("2026-09-01T09:00:00Z"),
      timezone: "Asia/Kolkata",
      readings: [{ metric: "heart_rate_bpm", value: 195, direction: "high", threshold: 180 }],
      attempts: 2,
      everSpoken: true,
    });

    assert.match(notice.body, /heart rate bpm: 195 \(above 180\)/);
    // And it still claims nothing.
    assert.match(notice.body, /not a diagnosis/);
    assert.ok(!/abnormal|dangerous|critical/i.test(notice.body));
  });

  it("says plainly when it never reached them at all", () => {
    const notice = vitalsNotice({
      kind: "fall",
      observedAt: new Date("2026-09-01T09:00:00Z"),
      timezone: "Asia/Kolkata",
      readings: [],
      attempts: 1,
      everSpoken: false,
    });
    assert.match(notice.body, /never able to speak/);
    assert.match(notice.body, /Fall detection is often wrong/);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("an alert, from the feed to the family", () => {
  function wire(opts: { contacts?: string | null } = {}) {
    const escalations = new MemoryEscalationStore();
    const sessions = new SessionRegistry();
    let clock = Date.parse("2026-09-01T09:00:00.000Z");
    const sent: Array<{ subject: string; body: string }> = [];

    const cfg = testConfig({
      vitals: { apiBase: "http://safety.local/api/v1", apiKey: "k" },
      emergency: { contacts: opts.contacts === undefined ? "Aman <a@x.invalid>" : opts.contacts },
      mail: { from: "d@x.invalid", transport: "smtp" },
    });

    const wiring = registerCapabilities(cfg, () => {}, {
      capabilities: [vitalsCapability],
      escalations,
      sessions,
      now: () => clock,
    });

    const handler = wiring.escalationHandlers.get("vitals");
    assert.ok(handler, "vitals registered no escalation handler");

    return {
      escalations,
      sessions,
      sent,
      wiring,
      handler: handler,
      advance: (ms: number) => (clock += ms),
      now: () => clock,
    };
  }

  it("asks the person, without saying why", async () => {
    const w = wire();
    const session = fakeSession();
    w.sessions.add(session);

    const feed = new FakeFeed();
    feed.alerts = [alert()];
    await new AlertWatcher({
      feed,
      escalations: w.escalations,
      capability: "vitals",
      now: w.now,
    }).poll();

    const runner = new EscalationRunner({
      store: w.escalations,
      handlers: w.wiring.escalationHandlers,
      now: w.now,
    });
    const summary = await runner.sweep();

    assert.equal(summary?.spoken, 1);
    assert.deepEqual(session.said, [t(VITALS_COPY, "ask_reading", "hi-IN")]);
    assert.ok(!/\d/.test(session.said[0]!));
  });

  it("settles the alert where it was raised once somebody answers", async () => {
    // WITHOUT THIS the watcher finds the same alert on the next poll and asks
    // again, for as long as the row stays open.
    const w = wire();
    const session = fakeSession();
    w.sessions.add(session);

    const feed = new FakeFeed();
    feed.alerts = [alert()];
    const watch = new AlertWatcher({
      feed,
      escalations: w.escalations,
      capability: "vitals",
      now: w.now,
    });
    await watch.poll();

    // Replace the handler's remote client with the fake for this wiring: the
    // capability built its own against a URL nothing is listening on.
    const handler = w.handler;
    handler.settled = async (record) => {
      await feed.settle(record.uid, String(record.payload["alert_id"]), "acknowledged");
    };

    const runner = new EscalationRunner({
      store: w.escalations,
      handlers: new Map([["vitals", handler]]),
      now: w.now,
    });
    await runner.sweep();

    // The person says something: any reply at all is the answer.

    (session.state as any).turn_no = 4;
    await runner.sweep();

    assert.deepEqual(await w.escalations.open(), []);
    assert.deepEqual(feed.settled, [{ uid: "u1", id: "alert-1", status: "acknowledged" }]);
    // And the next poll has nothing to re-open.
    assert.deepEqual((await watch.poll())?.opened, 0);
  });

  it("tells the family when nobody answers, and only then", async () => {
    const w = wire();
    const session = fakeSession();
    w.sessions.add(session);

    const feed = new FakeFeed();
    feed.alerts = [alert()];
    await new AlertWatcher({
      feed,
      escalations: w.escalations,
      capability: "vitals",
      now: w.now,
    }).poll();

    const notices: string[] = [];
    const handler: EscalationHandler = {
      ...w.handler,
      notify: async (record) => {
        notices.push(String(record.payload["alert_type"]));
        return { delivered: true };
      },
      settled: async () => {},
    };

    const runner = new EscalationRunner({
      store: w.escalations,
      handlers: new Map([["vitals", handler]]),
      now: w.now,
    });

    await runner.sweep(); // asks
    assert.deepEqual(notices, []);

    w.advance(2 * MINUTE + 1000);
    await runner.sweep(); // nudges — still nobody told
    assert.deepEqual(notices, []);
    assert.equal(session.said.length, 2);

    w.advance(3 * MINUTE + 1000);
    await runner.sweep(); // now the family
    assert.deepEqual(notices, ["anomaly"]);
  });

  it("is registered with tools but no ladder when there is nobody to tell", () => {
    // Half-configured is allowed here, like medication: the device still asks,
    // and the boot log says plainly that the second half is off.
    const w = wire({ contacts: null });
    const report = w.wiring.reports[0];
    assert.equal(report?.detail["vitals"], "log+read, alerts unreported");
  });

  it("stops its watcher on dispose", () => {
    const w = wire();
    // Two servers in one process must not leave each other's timers running.
    // The report owns the handle; nothing here is a module-level singleton.
    assert.ok(w.wiring.reports[0]?.dispose);
    w.wiring.dispose();
  });
});
