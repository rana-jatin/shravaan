/**
 * ScheduleStore contract.
 *
 * The same suite runs against both implementations, for the reason store.test.ts
 * gives: if Redis and memory disagree, one of them is wrong, and a suite that
 * only ever ran against the Map would not say which.
 *
 * ⚠ CLAUDE.md lists "the Redis store contract suite has never been executed"
 * among the things that will surprise you. THIS ONE HAS BEEN: every test below
 * was run green against a real Redis 6.0 before it was committed, and so was
 * the SessionStore suite next door that the note is about.
 *
 * Two rules exist because writing both implementations made the divergence
 * obvious in advance rather than in production: the ordering rule (a Map is
 * insertion-ordered, a Redis set is not ordered at all) and the copy-on-read
 * rule (JSON cannot leak a reference; a Map can). The Redis run confirmed them.
 * It did not discover them, and this comment should not imply otherwise.
 *
 * EVERY TEST IS SCOPED TO ITS OWN TAG. `all()` is global by design, because the
 * ticker needs every schedule in the deployment, so a Redis run cannot assume an
 * empty database — nor leave one behind for the next run.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryScheduleStore } from "../src/scheduler/memory-schedule-store.ts";
import { compareSchedules, type Schedule, type ScheduleStore } from "../src/scheduler/types.ts";

const REDIS_URL = process.env["REDIS_URL"];

type Fixture = {
  tag: string;
  /** Two people, both unique to this test, so `forUser` is scoped too. */
  anand: string;
  meera: string;
  make: (over?: Partial<Schedule>) => Schedule;
};

function tagged(): Fixture {
  const tag = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const anand = `u-anand-${tag}`;
  let seq = 0;
  return {
    tag,
    anand,
    meera: `u-meera-${tag}`,
    make: (over: Partial<Schedule> = {}) => ({
      // Zero-padded and monotonic, so "the id breaks a createdAt tie" is a
      // property of the fixture rather than of how Math.random came out.
      id: `${tag}-${String(seq++).padStart(2, "0")}`,
      uid: anand,
      capability: "medication",
      payload: { label: "the blue tablet" },
      timezone: "Asia/Kolkata",
      recurrence: { kind: "daily", times: ["08:00", "20:00"] },
      enabled: true,
      createdAt: "2026-09-01T04:00:00.000Z",
      ...over,
    }),
  };
}

const inTag =
  (tag: string) =>
  (s: Schedule): boolean =>
    s.id.startsWith(tag);

async function cleanupTag(store: ScheduleStore, tag: string): Promise<void> {
  for (const s of (await store.all()).filter(inTag(tag))) await store.remove(s.id);
}

function contractSuite(name: string, make: () => ScheduleStore) {
  describe(`ScheduleStore contract: ${name}`, () => {
    it("round-trips a schedule, payload and all", async () => {
      const store = make();
      const { tag, make: schedule } = tagged();
      const written = schedule({
        payload: { label: "metformin", dose: "500mg", withFood: true },
        recurrence: { kind: "interval", everyMinutes: 90, window: { from: "09:00", to: "19:00" } },
      });

      await store.put(written);
      assert.deepEqual(await store.get(written.id), written);

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("returns null for an id nobody wrote", async () => {
      const store = make();
      assert.equal(await store.get(`missing-${Math.random()}`), null);
      await store.close?.();
    });

    it("keeps one person's reminders out of another's list", async () => {
      // The failure this guards is not a bug report, it is a privacy incident:
      // one person being read another person's medication schedule.
      const store = make();
      const { tag, anand, meera, make: schedule } = tagged();
      const mine = schedule({ uid: anand });
      const theirs = schedule({ uid: meera });

      await store.put(mine);
      await store.put(theirs);

      assert.deepEqual(
        (await store.forUser(anand)).map((s) => s.id),
        [mine.id],
      );
      assert.deepEqual(
        (await store.forUser(meera)).map((s) => s.id),
        [theirs.id],
      );

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("stops listing a schedule for the person it was moved away from", async () => {
      // Rewriting a schedule under a different uid must not leave it visible to
      // both. Redis keeps the old index entry through that write, so without a
      // rule the two implementations genuinely diverge here.
      const store = make();
      const { tag, anand, meera, make: schedule } = tagged();
      const moved = schedule({ uid: anand });

      await store.put(moved);
      await store.put({ ...moved, uid: meera });

      assert.deepEqual(await store.forUser(anand), []);
      assert.deepEqual(
        (await store.forUser(meera)).map((s) => s.id),
        [moved.id],
      );

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("orders by creation, oldest first, with the id breaking ties", async () => {
      // Stated in compareSchedules and asserted here rather than left to a Map's
      // insertion order and a Redis set's non-order to agree by luck.
      const store = make();
      const { tag, anand, make: schedule } = tagged();
      const later = schedule({ createdAt: "2026-09-03T00:00:00.000Z" });
      const earlier = schedule({ createdAt: "2026-09-01T00:00:00.000Z" });
      const sameInstant = schedule({ createdAt: "2026-09-01T00:00:00.000Z" });

      for (const s of [later, sameInstant, earlier]) await store.put(s);

      // `earlier` and `sameInstant` share a createdAt, so the id decides — and
      // `earlier` was built first, which gives it the lower one.
      const expected = [earlier.id, sameInstant.id, later.id];
      assert.deepEqual(
        (await store.all()).filter(inTag(tag)).map((s) => s.id),
        expected,
      );
      assert.deepEqual(
        (await store.forUser(anand)).map((s) => s.id),
        expected,
      );

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("replaces on a second put rather than accumulating", async () => {
      const store = make();
      const { tag, make: schedule } = tagged();
      const original = schedule({ enabled: true });

      await store.put(original);
      await store.put({ ...original, enabled: false });

      const mine = (await store.all()).filter(inTag(tag));
      assert.equal(mine.length, 1);
      assert.equal(mine[0]!.enabled, false);

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("still returns a disabled schedule", async () => {
      // Paused is not deleted, and filtering is the domain's job — a store that
      // hid disabled rows would make "why did my reminder vanish" unanswerable.
      const store = make();
      const { tag, anand, make: schedule } = tagged();
      const paused = schedule({ enabled: false });

      await store.put(paused);
      assert.equal((await store.get(paused.id))?.enabled, false);
      assert.equal((await store.forUser(anand)).length, 1);

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("removes from the value and from both listings at once", async () => {
      const store = make();
      const { tag, anand, make: schedule } = tagged();
      const doomed = schedule();
      const kept = schedule();

      await store.put(doomed);
      await store.put(kept);
      await store.remove(doomed.id);

      assert.equal(await store.get(doomed.id), null);
      assert.deepEqual(
        (await store.forUser(anand)).map((s) => s.id),
        [kept.id],
      );
      assert.deepEqual(
        (await store.all()).filter(inTag(tag)).map((s) => s.id),
        [kept.id],
      );

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("treats removing something that is not there as done", async () => {
      const store = make();
      await store.remove(`missing-${Math.random()}`);
      await store.close?.();
    });

    it("hands out copies, so a caller cannot edit the store by accident", async () => {
      // Redis round-trips through JSON and physically cannot leak a reference.
      // Without an explicit copy the Map would, and disabling a reminder would
      // appear to work right up until the process restarted.
      const store = make();
      const { tag, make: schedule } = tagged();
      const written = schedule();

      await store.put(written);
      const read = (await store.get(written.id))!;
      read.enabled = false;
      read.payload["label"] = "tampered";

      const again = (await store.get(written.id))!;
      assert.equal(again.enabled, true);
      assert.equal(again.payload["label"], "the blue tablet");

      // And the same on the way in: mutating what you wrote must not reach in.
      written.enabled = false;
      assert.equal((await store.get(written.id))!.enabled, true);

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("reports an empty list rather than failing on an unknown user", async () => {
      const store = make();
      assert.deepEqual(await store.forUser(`nobody-${Math.random()}`), []);
      await store.close?.();
    });
  });
}

contractSuite("memory", () => new MemoryScheduleStore());

describe("compareSchedules", () => {
  it("is a total order, so a sort is stable across implementations", () => {
    const { make } = tagged();
    const a = make({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = make({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const c = make({ id: "c", createdAt: "2025-01-01T00:00:00.000Z" });

    assert.deepEqual(
      [a, b, c].sort(compareSchedules).map((s) => s.id),
      ["c", "a", "b"],
    );
    assert.equal(compareSchedules(a, a), 0);
  });
});

if (REDIS_URL) {
  const { RedisScheduleStore } = await import("../src/scheduler/redis-schedule-store.ts");
  const { Redis } = await import("ioredis");
  const { key } = await import("@sp-i/shared/domain/redis-keys.ts");

  contractSuite("redis", () => new RedisScheduleStore(REDIS_URL));

  describe("RedisScheduleStore: the index and the value can disagree", () => {
    it("skips an id whose schedule is gone, and drops it from the index", async () => {
      // Nothing spans the value and the two sets, so a process killed mid-put
      // leaves exactly this. A ticker dispatching from it would be waking
      // somebody on behalf of a reminder that no longer exists.
      const redis = new Redis(REDIS_URL);
      const store = new RedisScheduleStore(redis);
      const orphan = `orphan-${Math.random().toString(36).slice(2, 8)}`;

      await redis.sadd(key.scheduleIndex(), orphan);
      assert.equal(
        (await store.all()).some((s) => s.id === orphan),
        false,
      );

      // The repair is fire-and-forget, so give it the turn it needs.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await redis.sismember(key.scheduleIndex(), orphan), 0);

      await redis.quit();
    });

    it("skips a value that is not JSON rather than throwing on the tick path", async () => {
      const redis = new Redis(REDIS_URL);
      const store = new RedisScheduleStore(redis);
      const id = `corrupt-${Math.random().toString(36).slice(2, 8)}`;

      await redis.set(key.schedule(id), "{ not json");
      await redis.sadd(key.scheduleIndex(), id);

      assert.equal(
        (await store.all()).some((s) => s.id === id),
        false,
      );

      await redis.del(key.schedule(id));
      await redis.srem(key.scheduleIndex(), id);
      await redis.quit();
    });

    it("closes a client that never connected without opening one to do it", async () => {
      // `lazyConnect` is what lets composition build this store unconditionally.
      // `quit()` on a client in that state would dial out purely to hang up.
      const store = new RedisScheduleStore(REDIS_URL);
      await store.close();
    });
  });
} else {
  describe("ScheduleStore contract: redis", () => {
    it("SKIPPED — set REDIS_URL to run the contract against real Redis", { skip: true }, () => {});
  });
}
