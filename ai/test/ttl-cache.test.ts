/**
 * The cache, and the property that actually matters in it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MOST OF THESE TESTS ARE ABOUT CONCURRENCY, NOT ABOUT EXPIRY. A TTL is easy to
 * get right and easy to see when it is wrong. Single-flight is neither: three
 * conversations asking for the headlines in the same second is the ordinary
 * morning in a house with two devices, and a cache that only checks on entry
 * misses on all three because none of them has finished yet. Nothing about that
 * shows up in a single-threaded read of the code.
 *
 * The loads here are therefore deliberately un-awaited until several callers
 * are in flight, which is the only way to exercise the case at all.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TtlCache } from "../src/domain/ttl-cache.ts";

/** A load that resolves when the test says so. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("the TTL", () => {
  it("serves a stored value without calling the loader again", async () => {
    let calls = 0;
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => 0 });
    const load = async () => {
      calls++;
      return "headlines";
    };

    assert.equal(await cache.fetch("k", load), "headlines");
    assert.equal(await cache.fetch("k", load), "headlines");
    assert.equal(calls, 1);
  });

  it("reloads once the entry has expired", async () => {
    let clock = 0;
    let calls = 0;
    const cache = new TtlCache<number>({ ttlMs: 1000, now: () => clock });
    const load = async () => ++calls;

    assert.equal(await cache.fetch("k", load), 1);
    clock = 999;
    assert.equal(await cache.fetch("k", load), 1);
    clock = 1000; // The boundary is expiry, not freshness.
    assert.equal(await cache.fetch("k", load), 2);
  });

  it("is a pass-through when the ttl is zero", async () => {
    // The debugging switch: `NEWS_CACHE_SECONDS=0` and every question is a
    // fetch again, which is what somebody chasing a stale headline wants.
    let calls = 0;
    const cache = new TtlCache<number>({ ttlMs: 0 });
    const load = async () => ++calls;

    await cache.fetch("k", load);
    await cache.fetch("k", load);
    assert.equal(calls, 2);
    assert.equal(cache.size, 0);
    assert.equal(cache.enabled, false);
  });

  it("evicts the least recently READ, not the least recently written", async () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 2, now: () => 0 });
    await cache.fetch("a", async () => "A");
    await cache.fetch("b", async () => "B");

    // Touching "a" makes "b" the oldest, even though "b" was written later.
    assert.equal(cache.get("a"), "A");
    await cache.fetch("c", async () => "C");

    assert.equal(cache.get("a"), "A");
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("c"), "C");
  });

  it("keeps the key space bounded", async () => {
    // `get_weather` is keyed by whatever place a person names, so without this
    // a twenty-four hour TTL is a slow leak rather than a cache.
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 3, now: () => 0 });
    for (let i = 0; i < 50; i++) await cache.fetch(`place-${i}`, async () => i);
    assert.equal(cache.size, 3);
  });
});

describe("single-flight", () => {
  it("makes one request for three callers who arrive together", async () => {
    // THE CASE THIS FILE EXISTS FOR. All three arrive before the first load has
    // resolved, so a cache checked only on entry would miss on all three.
    let calls = 0;
    const gate = deferred<string>();
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => 0 });
    const load = () => {
      calls++;
      return gate.promise;
    };

    const all = Promise.all([
      cache.fetch("k", load),
      cache.fetch("k", load),
      cache.fetch("k", load),
    ]);
    gate.resolve("headlines");

    assert.deepEqual(await all, ["headlines", "headlines", "headlines"]);
    assert.equal(calls, 1);
    assert.equal(cache.stats().shared, 2);
  });

  it("does not share between different keys", async () => {
    let calls = 0;
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => 0 });
    const load = async () => {
      calls++;
      return "x";
    };
    await Promise.all([cache.fetch("a", load), cache.fetch("b", load)]);
    assert.equal(calls, 2);
  });

  it("fails every waiter and caches nothing", async () => {
    // Caching an error would turn one bad minute into `ttl` bad minutes, in
    // front of a tool somebody is waiting on in real time.
    const gate = deferred<string>();
    const cache = new TtlCache<string>({ ttlMs: 60_000, now: () => 0 });

    const first = cache.fetch("k", () => gate.promise);
    const second = cache.fetch("k", () => gate.promise);
    gate.reject(new Error("feed returned HTTP 503"));

    await assert.rejects(() => first, /503/);
    await assert.rejects(() => second, /503/);
    assert.equal(cache.get("k"), undefined);
  });

  it("retries on the next call after a failure, rather than wedging the key", async () => {
    // The in-flight slot has to be released whichever way the load goes. If it
    // were not, one 503 would make that key permanently unfetchable.
    const cache = new TtlCache<string>({ ttlMs: 60_000, now: () => 0 });
    await assert.rejects(() => cache.fetch("k", () => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await cache.fetch("k", async () => "second time"), "second time");
  });

  it("does not report an unhandled rejection when a load fails", async () => {
    // The bookkeeping chain (`.finally` to release the slot) is a DERIVED
    // promise. Left unhandled it would be reported separately from the one the
    // caller is awaiting, and in a server that surfaces as a spurious crash.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const cache = new TtlCache<string>({ ttlMs: 60_000 });
      await assert.rejects(() => cache.fetch("k", () => Promise.reject(new Error("boom"))));
      // A turn of the microtask queue plus a macrotask, which is when Node
      // decides a rejection was never handled.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(seen, []);
  });

  it("counts what it did, for a boot log", async () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => 0 });
    await cache.fetch("k", async () => "v");
    await cache.fetch("k", async () => "v");
    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.size, 1);
  });
});
