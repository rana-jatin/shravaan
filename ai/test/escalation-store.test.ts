/**
 * EscalationStore contract.
 *
 * Same shape as schedule-store.test.ts and for the same reason: one suite, both
 * implementations, so a divergence is a failure rather than a surprise in
 * production. Run green against a real Redis 6.0 before it was committed.
 *
 * The one behaviour here that has no equivalent next door is the TTL. Schedules
 * never expire; escalations do, and the Redis half checks that the backstop is
 * actually applied — a record that outlives its ladder is a quiet accumulation
 * of somebody's medication history, which this product has no consent for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryEscalationStore } from "../src/escalation/memory-escalation-store.ts";
import { openEscalation } from "../src/escalation/ladder.ts";
import {
  compareEscalations,
  type Escalation,
  type EscalationStore,
} from "../src/escalation/types.ts";

const REDIS_URL = process.env["REDIS_URL"];
const DUE = new Date("2026-09-06T02:30:00.000Z");

type Fixture = {
  tag: string;
  anand: string;
  meera: string;
  make: (over?: Partial<Escalation>) => Escalation;
};

function tagged(): Fixture {
  const tag = `esc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const anand = `u-anand-${tag}`;
  let seq = 0;
  return {
    tag,
    anand,
    meera: `u-meera-${tag}`,
    make: (over: Partial<Escalation> = {}) => ({
      ...openEscalation(
        {
          uid: anand,
          capability: "medication",
          scheduleId: `${tag}-${String(seq++).padStart(2, "0")}`,
          dueAt: DUE,
          payload: { label: "the blue tablet" },
        },
        DUE,
      ),
      ...over,
    }),
  };
}

const inTag =
  (tag: string) =>
  (e: Escalation): boolean =>
    e.id.startsWith(tag);

async function cleanupTag(store: EscalationStore, tag: string): Promise<void> {
  for (const e of (await store.open()).filter(inTag(tag))) await store.remove(e.id);
}

function contractSuite(name: string, make: () => EscalationStore) {
  describe(`EscalationStore contract: ${name}`, () => {
    it("round-trips a record, payload and all", async () => {
      const store = make();
      const { tag, make: escalation } = tagged();
      const written = escalation({ stage: "nudged", attempts: 3, lastRefusal: "media" });

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

    it("hides a settled record from the sweep even before it is removed", async () => {
      // `put` then `remove` is two steps, and a sweeper that dies between them
      // must not hand the next one an acknowledged reminder to keep climbing.
      const store = make();
      const { tag, anand, make: escalation } = tagged();
      const answered = escalation({ stage: "acknowledged", settledAt: DUE.toISOString() });
      const live = escalation();

      await store.put(answered);
      await store.put(live);

      assert.deepEqual(
        (await store.open()).filter(inTag(tag)).map((e) => e.id),
        [live.id],
      );
      assert.deepEqual(
        (await store.openFor(anand)).map((e) => e.id),
        [live.id],
      );
      // Still fetchable by id: hidden from the sweep is not the same as gone.
      assert.equal((await store.get(answered.id))?.stage, "acknowledged");

      await cleanupTag(store, tag);
      await store.remove(answered.id);
      await store.close?.();
    });

    it("keeps one person's reminders out of another's list", async () => {
      const store = make();
      const { tag, anand, meera, make: escalation } = tagged();
      const mine = escalation({ uid: anand });
      const theirs = escalation({ uid: meera });

      await store.put(mine);
      await store.put(theirs);

      assert.deepEqual(
        (await store.openFor(anand)).map((e) => e.id),
        [mine.id],
      );
      assert.deepEqual(
        (await store.openFor(meera)).map((e) => e.id),
        [theirs.id],
      );

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("returns a backlog oldest due first", async () => {
      // After an outage, reminders are worked in the order they happened.
      const store = make();
      const { tag, anand, make: escalation } = tagged();
      const evening = escalation({ dueAt: "2026-09-06T14:30:00.000Z" });
      const morning = escalation({ dueAt: "2026-09-06T02:30:00.000Z" });

      await store.put(evening);
      await store.put(morning);

      assert.deepEqual(
        (await store.open()).filter(inTag(tag)).map((e) => e.id),
        [morning.id, evening.id],
      );
      assert.deepEqual(
        (await store.openFor(anand)).map((e) => e.id),
        [morning.id, evening.id],
      );

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("replaces on a second put rather than accumulating", async () => {
      const store = make();
      const { tag, make: escalation } = tagged();
      const original = escalation();

      await store.put(original);
      await store.put({ ...original, stage: "nudged", attempts: 2 });

      const mine = (await store.open()).filter(inTag(tag));
      assert.equal(mine.length, 1);
      assert.equal(mine[0]!.stage, "nudged");

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("removes from the record and from both listings at once", async () => {
      const store = make();
      const { tag, anand, make: escalation } = tagged();
      const doomed = escalation();
      const kept = escalation();

      await store.put(doomed);
      await store.put(kept);
      await store.remove(doomed.id);

      assert.equal(await store.get(doomed.id), null);
      assert.deepEqual(
        (await store.openFor(anand)).map((e) => e.id),
        [kept.id],
      );
      assert.deepEqual(
        (await store.open()).filter(inTag(tag)).map((e) => e.id),
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

    it("hands out copies, so a sweep cannot edit the store by accident", async () => {
      const store = make();
      const { tag, make: escalation } = tagged();
      const written = escalation();

      await store.put(written);
      const read = (await store.get(written.id))!;
      read.stage = "escalated";
      read.attempts = 99;

      const again = (await store.get(written.id))!;
      assert.equal(again.stage, "pending");
      assert.equal(again.attempts, 0);

      await cleanupTag(store, tag);
      await store.close?.();
    });

    it("reports an empty list rather than failing on somebody with nothing due", async () => {
      const store = make();
      assert.deepEqual(await store.openFor(`nobody-${Math.random()}`), []);
      await store.close?.();
    });
  });
}

contractSuite("memory", () => new MemoryEscalationStore());

describe("compareEscalations", () => {
  it("orders by when the dose was due, with the id breaking ties", () => {
    const { make } = tagged();
    const a = make({ id: "b", dueAt: "2026-09-06T08:00:00.000Z" });
    const b = make({ id: "a", dueAt: "2026-09-06T08:00:00.000Z" });
    const c = make({ id: "c", dueAt: "2026-09-06T06:00:00.000Z" });

    assert.deepEqual(
      [a, b, c].sort(compareEscalations).map((e) => e.id),
      ["c", "a", "b"],
    );
  });
});

if (REDIS_URL) {
  const { RedisEscalationStore } = await import("../src/escalation/redis-escalation-store.ts");
  const { Redis } = await import("ioredis");
  const { TTL, key } = await import("@sp-i/shared/domain/redis-keys.ts");

  contractSuite("redis", () => new RedisEscalationStore(REDIS_URL));

  describe("RedisEscalationStore: the backstop and the indexes", () => {
    it("gives every record a TTL, so a forgotten one cannot become a history", async () => {
      const redis = new Redis(REDIS_URL);
      const store = new RedisEscalationStore(redis);
      const { tag, make: escalation } = tagged();
      const written = escalation();

      await store.put(written);
      const ttl = await redis.ttl(key.escalation(written.id));

      assert.ok(ttl > 0, "expected an expiry");
      assert.ok(ttl <= TTL.ESCALATION_SECONDS, "expected the documented backstop");

      await cleanupTag(store, tag);
      await redis.quit();
    });

    it("skips an id whose record has expired, and drops it from the index", async () => {
      // The ordinary way this store gets untidy: the value expires under its
      // backstop while the index entry, which has no TTL, stays behind.
      const redis = new Redis(REDIS_URL);
      const store = new RedisEscalationStore(redis);
      const orphan = `orphan-${Math.random().toString(36).slice(2, 8)}`;

      await redis.sadd(key.escalationIndex(), orphan);
      assert.equal(
        (await store.open()).some((e) => e.id === orphan),
        false,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await redis.sismember(key.escalationIndex(), orphan), 0);

      await redis.quit();
    });

    it("skips a value that is not JSON rather than throwing on the sweep path", async () => {
      const redis = new Redis(REDIS_URL);
      const store = new RedisEscalationStore(redis);
      const id = `corrupt-${Math.random().toString(36).slice(2, 8)}`;

      await redis.set(key.escalation(id), "{ not json");
      await redis.sadd(key.escalationIndex(), id);

      assert.equal(
        (await store.open()).some((e) => e.id === id),
        false,
      );

      await redis.del(key.escalation(id));
      await redis.srem(key.escalationIndex(), id);
      await redis.quit();
    });

    it("closes a client that never connected without opening one to do it", async () => {
      const store = new RedisEscalationStore(REDIS_URL);
      await store.close();
    });
  });
} else {
  describe("EscalationStore contract: redis", () => {
    it("SKIPPED — set REDIS_URL to run the contract against real Redis", { skip: true }, () => {});
  });
}
