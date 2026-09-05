/**
 * The tick loop.
 *
 * Every test here is about the loop falling behind, because that is the only
 * thing the loop is really for: expanding a recurrence is already covered in
 * scheduler.test.ts, and the store contract in schedule-store.test.ts. What is
 * left is the asymmetry — silence beats a second tablet — and it is asserted
 * rather than described.
 *
 * The clock is a variable. Nothing here sleeps.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryScheduleStore } from "../src/scheduler/memory-schedule-store.ts";
import { Ticker, type OccurrenceHandler } from "../src/scheduler/ticker.ts";
import type { Occurrence, Schedule, ScheduleStore } from "../src/scheduler/types.ts";

/** 2026-09-06 08:00 in Kolkata, which is 02:30 UTC. The offset is the point. */
const EIGHT_AM_IST = Date.parse("2026-09-06T02:30:00.000Z");
const MINUTE = 60_000;

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    uid: "u1",
    capability: "medication",
    payload: { label: "the blue tablet" },
    timezone: "Asia/Kolkata",
    recurrence: { kind: "daily", times: ["08:00"] },
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/** A ticker over a fixed set of schedules, with the clock in the caller's hand. */
function harness(
  schedules: Schedule[],
  opts: {
    handlers?: Record<string, OccurrenceHandler>;
    at?: number;
    staleAfterMs?: number;
    store?: ScheduleStore;
  } = {},
) {
  let now = opts.at ?? EIGHT_AM_IST - 5 * MINUTE;
  const seen: Occurrence[] = [];
  const lines: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];

  const store = opts.store ?? new MemoryScheduleStore();
  const ready = Promise.all(schedules.map((s) => store.put(s)));

  const handlers = new Map<string, OccurrenceHandler>(
    Object.entries(opts.handlers ?? { medication: (o) => void seen.push(o) }),
  );

  const ticker = new Ticker({
    store,
    handlers,
    now: () => now,
    log: (level, msg, extra) => lines.push({ level, msg, ...(extra ? { extra } : {}) }),
    ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
  });

  return {
    ticker,
    seen,
    lines,
    store,
    ready,
    advanceTo: (ms: number) => {
      now = ms;
    },
    advanceBy: (ms: number) => {
      now += ms;
    },
  };
}

describe("dispatching what is due", () => {
  it("hands a due occurrence to the handler for its capability", async () => {
    const h = harness([schedule()]);
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    const summary = (await h.ticker.tick())!;

    assert.equal(summary.due, 1);
    assert.equal(summary.dispatched, 1);
    assert.equal(h.seen.length, 1);
    assert.equal(h.seen[0]!.at.toISOString(), "2026-09-06T02:30:00.000Z");
    assert.equal(h.seen[0]!.schedule.payload["label"], "the blue tablet");
  });

  it("does not dispatch the same occurrence to the next window", async () => {
    // The window is half-open at the start, so a second pass over an unchanged
    // clock is empty rather than a repeat. Told twice is a second tablet.
    const h = harness([schedule()]);
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    await h.ticker.tick();
    await h.ticker.tick();
    h.advanceBy(MINUTE);
    await h.ticker.tick();

    assert.equal(h.seen.length, 1);
  });

  it("routes each capability to its own handler and nobody else's", async () => {
    const medication: Occurrence[] = [];
    const checkin: Occurrence[] = [];
    const h = harness(
      [
        schedule({ id: "m", capability: "medication" }),
        schedule({ id: "c", capability: "checkin" }),
      ],
      {
        handlers: {
          medication: (o) => void medication.push(o),
          checkin: (o) => void checkin.push(o),
        },
      },
    );
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    await h.ticker.tick();

    assert.deepEqual(
      medication.map((o) => o.schedule.id),
      ["m"],
    );
    assert.deepEqual(
      checkin.map((o) => o.schedule.id),
      ["c"],
    );
  });

  it("delivers a backlog oldest first", async () => {
    // After a stall the order people experience should be the order things
    // happened, not the order the store handed them over.
    // Both inside the staleness horizon; the point is only the order.
    const h = harness([
      schedule({ id: "second", recurrence: { kind: "daily", times: ["08:10"] } }),
      schedule({ id: "first", recurrence: { kind: "daily", times: ["08:00"] } }),
    ]);
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + 12 * MINUTE);
    await h.ticker.tick();

    assert.deepEqual(
      h.seen.map((o) => o.schedule.id),
      ["first", "second"],
    );
  });

  it("skips a disabled schedule without comment", async () => {
    const h = harness([schedule({ enabled: false })]);
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    assert.equal((await h.ticker.tick())!.due, 0);
    assert.equal(h.seen.length, 0);
    assert.deepEqual(h.lines, []);
  });

  it("says nothing at all on a tick with nothing due", async () => {
    // Two lines a minute of "nothing happened" is how a log stops being read.
    const h = harness([schedule()]);
    await h.ready;

    h.advanceBy(MINUTE);
    await h.ticker.tick();
    assert.deepEqual(h.lines, []);
  });
});

describe("falling behind", () => {
  it("drops an occurrence that is older than the staleness horizon", async () => {
    // Forty minutes late, a medication prompt is competing with the next dose.
    const h = harness([schedule()], { staleAfterMs: 15 * MINUTE });
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + 40 * MINUTE);
    const summary = (await h.ticker.tick())!;

    assert.equal(summary.due, 1);
    assert.equal(summary.stale, 1);
    assert.equal(summary.dispatched, 0);
    assert.equal(h.seen.length, 0);

    const dropped = h.lines.find((l) => l.msg.startsWith("reminder dropped"))!;
    assert.equal(dropped.level, "warn");
    assert.equal(dropped.extra!["late_by_minutes"], 40);
  });

  it("still delivers one that is late but inside the horizon", async () => {
    const h = harness([schedule()], { staleAfterMs: 15 * MINUTE });
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + 14 * MINUTE);
    assert.equal((await h.ticker.tick())!.dispatched, 1);
  });

  it("does not replay the past on the first tick after a start", async () => {
    // A restart at 08:05 must not fire the 08:00 dose. `start()` sets the
    // watermark to now, and this is the assertion that keeps it there.
    const h = harness([schedule()], { at: EIGHT_AM_IST + 5 * MINUTE });
    await h.ready;

    h.ticker.start();
    h.ticker.stop();
    h.advanceBy(MINUTE);
    await h.ticker.tick();

    assert.equal(h.seen.length, 0);
  });

  it("keeps the window when the store cannot be read, and delivers it later", async () => {
    // The important half is what does NOT happen: the watermark stays put, so
    // the 08:00 dose is still delivered once Redis comes back.
    let broken = true;
    const inner = new MemoryScheduleStore();
    const flaky: ScheduleStore = {
      forUser: (uid) => inner.forUser(uid),
      get: (id) => inner.get(id),
      put: (s) => inner.put(s),
      remove: (id) => inner.remove(id),
      all: async () => {
        if (broken) throw new Error("ECONNREFUSED");
        return inner.all();
      },
    };

    const h = harness([schedule()], { store: flaky });
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    assert.equal(await h.ticker.tick(), null);
    assert.equal(h.seen.length, 0);
    assert.equal(h.lines[0]!.level, "error");

    broken = false;
    h.advanceBy(MINUTE);
    assert.equal((await h.ticker.tick())!.dispatched, 1);
    assert.equal(h.seen.length, 1);
  });

  it("refuses to run two passes at once, and loses nothing by it", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = harness([schedule()], { handlers: { medication: () => held } });
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    const first = h.ticker.tick();
    assert.equal(await h.ticker.tick(), null);

    release();
    assert.equal((await first)!.dispatched, 1);
  });

  it("does not re-open a window when the clock steps backwards", async () => {
    // An NTP correction or a VM resumed from a snapshot. Moving the watermark
    // back would hand every occurrence in between to the handler a second time.
    const h = harness([schedule()]);
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    await h.ticker.tick();
    assert.equal(h.seen.length, 1);

    h.advanceTo(EIGHT_AM_IST - MINUTE);
    assert.equal((await h.ticker.tick())!.due, 0);

    h.advanceTo(EIGHT_AM_IST + 2 * MINUTE);
    assert.equal((await h.ticker.tick())!.due, 0);
    assert.equal(h.seen.length, 1);
  });
});

describe("when nobody is listening", () => {
  it("counts a due schedule with no handler and warns once per capability", async () => {
    // A schedule outliving the capability that wrote it is ordinary: Redis keeps
    // it, a deployment turns the feature off. Warning per tick would be a flood.
    const h = harness(
      [schedule({ id: "a", capability: "vitals" }), schedule({ id: "b", capability: "vitals" })],
      { handlers: {} },
    );
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    const summary = (await h.ticker.tick())!;

    assert.equal(summary.unhandled, 2);
    assert.equal(summary.dispatched, 0);
    assert.equal(h.lines.filter((l) => l.msg.includes("does not run")).length, 1);
  });

  it("carries on when a handler throws, and does not retry it", async () => {
    // A handler that fails is one reminder; taking the loop down with it is
    // every reminder, for everybody, until somebody notices.
    let calls = 0;
    const h = harness(
      [
        schedule({ id: "bad", capability: "medication" }),
        schedule({ id: "good", capability: "checkin" }),
      ],
      {
        handlers: {
          medication: () => {
            calls++;
            throw new Error("the notifier is down");
          },
          checkin: () => {},
        },
      },
    );
    await h.ready;

    h.advanceTo(EIGHT_AM_IST + MINUTE);
    const summary = (await h.ticker.tick())!;

    assert.equal(summary.failed, 1);
    assert.equal(summary.dispatched, 1);
    assert.equal(
      h.lines.some((l) => l.level === "error"),
      true,
    );

    h.advanceBy(MINUTE);
    await h.ticker.tick();
    assert.equal(calls, 1);
  });
});

describe("the timer", () => {
  it("starts once, stops once, and reports which it is", async () => {
    const h = harness([]);
    await h.ready;

    assert.equal(h.ticker.running, false);
    h.ticker.start();
    h.ticker.start();
    assert.equal(h.ticker.running, true);
    h.ticker.stop();
    h.ticker.stop();
    assert.equal(h.ticker.running, false);
  });
});
