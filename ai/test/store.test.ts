/**
 * SessionStore contract — slice 3.
 *
 * The same suite runs against both implementations. The in-memory store is not a
 * stand-in that gets special treatment: if Redis and memory disagree, one of them
 * is wrong, and a test that only ever ran against the easy one would not tell us
 * which.
 *
 * Redis tests are skipped unless REDIS_URL is set. Skipping is reported, not
 * silent — a green run with no Redis proves less than a green run with it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TTL, TURN_WINDOW } from "@sp-i/shared/domain/redis-keys.ts";
import type {
  JsonContext,
  MemWriteEvent,
  Profile,
  SessionState,
  Turn,
} from "@sp-i/shared/domain/types.ts";
import { MemorySessionStore } from "../src/store/memory-store.ts";
import { RedisMemWriteStream } from "../src/memory/stream.ts";
import { MEM_WRITES_MAXLEN } from "@sp-i/shared/domain/redis-keys.ts";
import { NullSessionStore, type SessionStore } from "../src/store/session-store.ts";

const REDIS_URL = process.env["REDIS_URL"];

function makeState(sid: string, over: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString();
  return {
    sid,
    user_id: "u1",
    language: "hi-IN",
    language_source: "detected",
    turn_no: 0,
    agent_speaking: false,
    last_tool: null,
    slots: {},
    started_at: now,
    last_activity_at: now,
    asr_provider: "sarvam",
    degraded: [],
    switch_declined_acknowledged: false,
    ...over,
  };
}

const makeTurn = (tid: number, text: string, role: Turn["role"] = "user"): Turn => ({
  tid,
  role,
  text,
  language: "hi-IN",
  at: new Date().toISOString(),
});

/** The shared contract. Anything implementing SessionStore must satisfy this. */
function contractSuite(
  name: string,
  make: () => SessionStore,
  cleanup?: (s: SessionStore) => Promise<void>,
) {
  describe(`SessionStore contract: ${name}`, () => {
    it("round-trips session state", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      await s.saveState(makeState(sid, { turn_no: 4, language: "ta-IN" }));

      const got = await s.loadState(sid);
      assert.equal(got?.turn_no, 4);
      assert.equal(got?.language, "ta-IN");
      await cleanup?.(s);
    });

    it("returns null for an unknown session", async () => {
      const s = make();
      assert.equal(await s.loadState(`missing-${Math.random()}`), null);
      await cleanup?.(s);
    });

    it("keeps turns newest-first", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      await s.appendTurn(sid, makeTurn(1, "first"), TURN_WINDOW);
      await s.appendTurn(sid, makeTurn(2, "second"), TURN_WINDOW);

      const turns = await s.loadTurns(sid, TURN_WINDOW);
      assert.equal(turns[0]?.text, "second");
      assert.equal(turns[1]?.text, "first");
      await cleanup?.(s);
    });

    it("caps the window and drops the oldest", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      for (let i = 1; i <= TURN_WINDOW + 5; i++) {
        await s.appendTurn(sid, makeTurn(i, `turn-${i}`), TURN_WINDOW);
      }

      const turns = await s.loadTurns(sid, TURN_WINDOW);
      assert.equal(turns.length, TURN_WINDOW);
      assert.equal(turns[0]?.text, `turn-${TURN_WINDOW + 5}`);
      assert.ok(!turns.some((t) => t.text === "turn-1"), "oldest turn must be evicted");
      await cleanup?.(s);
    });

    it("loads state, turns and profile in one call", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      const uid = `u-${Math.random()}`;

      await s.saveState(makeState(sid, { user_id: uid, turn_no: 2 }));
      await s.appendTurn(sid, makeTurn(1, "hello"), TURN_WINDOW);
      await s.saveProfile({
        uid,
        distilled_at: new Date().toISOString(),
        preferred_language: "bn-IN",
        facts: [],
        recent_episodes: [],
        open_threads: [],
      } satisfies Profile);

      const ctx = await s.loadForTurn(sid, uid, TURN_WINDOW);
      assert.equal(ctx.state?.turn_no, 2);
      assert.equal(ctx.turns.length, 1);
      assert.equal(ctx.profile?.preferred_language, "bn-IN");
      await cleanup?.(s);
    });

    it("grants a lock once and refuses a second holder", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      assert.equal(await s.acquireLock(sid, "token-a"), true);
      assert.equal(await s.acquireLock(sid, "token-b"), false, "two turns must not run at once");
      await cleanup?.(s);
    });

    it("only lets the owner release a lock", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      await s.acquireLock(sid, "token-a");

      // A non-owner release must be a no-op. Otherwise a turn whose lock already
      // expired could delete a lock a later turn legitimately holds.
      await s.releaseLock(sid, "token-b");
      assert.equal(await s.acquireLock(sid, "token-c"), false, "lock was released by a non-owner");

      await s.releaseLock(sid, "token-a");
      assert.equal(await s.acquireLock(sid, "token-c"), true);
      await cleanup?.(s);
    });

    it("invalidates cached context on demand", async () => {
      const s = make();
      const uid = `u-${Math.random()}`;
      const ctx: JsonContext = {
        uid,
        fetched_at: new Date().toISOString(),
        identity: { display_name: "Test" },
        entitlements: [],
      };
      await s.saveContext(ctx);
      assert.ok(await s.loadContext(uid));

      await s.invalidateContext(uid);
      assert.equal(await s.loadContext(uid), null, "a tool mutation must drop the cache");
      await cleanup?.(s);
    });

    it("clears every session key on endSession", async () => {
      const s = make();
      const sid = `t-${Math.random()}`;
      await s.saveState(makeState(sid));
      await s.appendTurn(sid, makeTurn(1, "x"), TURN_WINDOW);

      await s.endSession(sid);
      assert.equal(await s.loadState(sid), null);
      assert.deepEqual(await s.loadTurns(sid, TURN_WINDOW), []);
      await cleanup?.(s);
    });
  });
}

contractSuite("memory", () => new MemorySessionStore());

if (REDIS_URL) {
  const { RedisSessionStore } = await import("../src/store/redis-store.ts");
  contractSuite(
    "redis",
    () => new RedisSessionStore(REDIS_URL),
    async (s) => {
      await s.close();
    },
  );
} else {
  describe("SessionStore contract: redis", () => {
    it("SKIPPED — set REDIS_URL to run the contract against real Redis", { skip: true }, () => {});
  });
}

describe("TTL semantics", () => {
  it("expires a session after the idle window", () => {
    let now = 1_000_000;
    const s = new MemorySessionStore(() => now);
    const sid = "ttl-1";

    return (async () => {
      await s.saveState(makeState(sid));
      now += TTL.SESSION_SECONDS * 1000 - 1;
      assert.ok(await s.loadState(sid), "still live just inside the window");

      now += 2;
      assert.equal(await s.loadState(sid), null, "expired just outside it");
    })();
  });

  it("touch extends a live session — this is what makes the window IDLE", async () => {
    let now = 1_000_000;
    const s = new MemorySessionStore(() => now);
    const sid = "ttl-2";
    await s.saveState(makeState(sid));

    // Someone walks away for 25 minutes, comes back and speaks.
    now += 25 * 60 * 1000;
    await s.touch(sid);

    // Another 25 minutes. An absolute TTL would have dropped this long ago.
    now += 25 * 60 * 1000;
    assert.ok(await s.loadState(sid), "activity must extend the window");
  });

  it("touch never resurrects an already-expired session", async () => {
    let now = 1_000_000;
    const s = new MemorySessionStore(() => now);
    const sid = "ttl-3";
    await s.saveState(makeState(sid));

    now += TTL.SESSION_SECONDS * 1000 + 1;
    await s.touch(sid);
    assert.equal(await s.loadState(sid), null);
  });

  it("expires user context absolutely, even under repeated access", async () => {
    let now = 1_000_000;
    const s = new MemorySessionStore(() => now);
    const uid = "ttl-4";
    await s.saveContext({
      uid,
      fetched_at: new Date().toISOString(),
      identity: { display_name: "T" },
      entitlements: [],
    });

    // Read it constantly. An idle TTL would keep it alive forever, letting a
    // suspended account retain its entitlements for as long as it stays chatty.
    for (let i = 0; i < 20; i++) {
      now += 60 * 1000;
      await s.loadContext(uid);
    }
    assert.equal(await s.loadContext(uid), null, "context TTL must be absolute");
  });

  it("keeps the profile alive far longer than a session", async () => {
    let now = 1_000_000;
    const s = new MemorySessionStore(() => now);
    await s.saveProfile({
      uid: "ttl-5",
      distilled_at: new Date().toISOString(),
      preferred_language: "hi-IN",
      facts: [],
      recent_episodes: [],
      open_threads: [],
    });

    now += 3 * 24 * 60 * 60 * 1000; // three days
    assert.ok(await s.loadProfile("ttl-5"), "continuity depends on the profile outliving sessions");
  });
});

describe("degraded path: NullSessionStore", () => {
  it("reads empty and swallows writes", async () => {
    const s = new NullSessionStore();
    await s.saveState(makeState("x"));
    assert.equal(await s.loadState("x"), null);
    assert.deepEqual((await s.loadForTurn("x", "u", 12)).turns, []);
  });

  it("always grants the lock — nothing to contend with", async () => {
    const s = new NullSessionStore();
    assert.equal(await s.acquireLock("x", "a"), true);
    assert.equal(await s.acquireLock("x", "b"), true);
  });
});

// ---------------------------------------------------------------------------

/**
 * `RedisMemWriteStream` against a fake client.
 *
 * This class ships the docs/02 section 3 contract — consumer group, at-least-once
 * delivery, MAXLEN trim — and `src/server.ts` does not wire it (see the note on
 * the class). Untested AND unwired is how a feature rots; these tests cover the
 * parts that would bite on the day someone does wire it, without needing Redis.
 *
 * The fake records commands rather than emulating Redis. That is deliberate: the
 * risk in this class is the ARGUMENTS it sends — a missing MKSTREAM, a `$` where
 * `>` belongs — and those are exactly what a recording fake can assert on.
 */
type Cmd = [string, ...unknown[]];

function fakeRedis(over: Partial<Record<string, (...a: any[]) => unknown>> = {}) {
  const cmds: Cmd[] = [];
  const rec =
    (name: string, ret: unknown = "ok") =>
    (...args: unknown[]) => {
      cmds.push([name, ...args]);
      return Promise.resolve(ret);
    };
  const client = {
    xgroup: rec("xgroup"),
    xadd: rec("xadd", "1-0"),
    xreadgroup: rec("xreadgroup", null),
    xack: rec("xack", 1),
    xpending: rec("xpending", [0]),
    quit: rec("quit"),
    ...over,
  };
  return { client, cmds };
}

const evt = (id: string): MemWriteEvent => ({
  event_id: id,
  sid: "s1",
  uid: "u1",
  tid: 1,
  at: new Date().toISOString(),
  kind: "explicit_recall",
  user_text: `fact ${id}`,
});

describe("RedisMemWriteStream (unwired — see src/memory/stream.ts)", () => {
  it("appends with a MAXLEN cap so the stream cannot grow without bound", async () => {
    const { client, cmds } = fakeRedis();
    const s = new RedisMemWriteStream(client as never);

    await s.append(evt("e1"));

    const xadd = cmds.find((c) => c[0] === "xadd");
    assert.ok(xadd, "expected an XADD");
    assert.ok(xadd.includes("MAXLEN"), "XADD must cap the stream");
    assert.ok(xadd.includes("~"), "approximate trim — exact trim is O(n) per write");
    assert.equal(xadd[xadd.indexOf("MAXLEN") + 2], MEM_WRITES_MAXLEN);
  });

  it("creates the consumer group with MKSTREAM before the first read", async () => {
    const { client, cmds } = fakeRedis();
    const s = new RedisMemWriteStream(client as never);

    await s.read("c1", 10, 0);

    const xgroup = cmds.find((c) => c[0] === "xgroup");
    assert.ok(xgroup, "expected XGROUP CREATE");
    assert.ok(
      xgroup.includes("MKSTREAM"),
      "without MKSTREAM the group cannot be created before the first write",
    );
  });

  it("tolerates BUSYGROUP — another replica created the group first", async () => {
    const { client } = fakeRedis({
      xgroup: () => Promise.reject(new Error("BUSYGROUP Consumer Group name already exists")),
    });
    const s = new RedisMemWriteStream(client as never);

    await assert.doesNotReject(() => s.read("c1", 10, 0));
  });

  it("propagates a real XGROUP failure rather than pretending the group exists", async () => {
    const { client } = fakeRedis({
      xgroup: () => Promise.reject(new Error("NOAUTH Authentication required")),
    });
    const s = new RedisMemWriteStream(client as never);

    await assert.rejects(() => s.read("c1", 10, 0), /NOAUTH/);
  });

  it("creates the group once, not once per read", async () => {
    const { client, cmds } = fakeRedis();
    const s = new RedisMemWriteStream(client as never);

    await s.read("c1", 10, 0);
    await s.read("c1", 10, 0);
    await s.read("c1", 10, 0);

    assert.equal(cmds.filter((c) => c[0] === "xgroup").length, 1);
  });

  it("reads NEW entries only — `>` and not `$`", async () => {
    const { client, cmds } = fakeRedis();
    const s = new RedisMemWriteStream(client as never);

    await s.read("worker-7", 25, 500);

    const rg = cmds.find((c) => c[0] === "xreadgroup");
    assert.ok(rg);
    assert.equal(rg.at(-1), ">", "`$` would skip everything appended before this read");
    assert.ok(rg.includes("worker-7"), "consumer name must reach Redis for XPENDING to work");
    assert.equal(rg[rg.indexOf("COUNT") + 1], 25);
    assert.equal(rg[rg.indexOf("BLOCK") + 1], 500);
  });

  it("parses entries out of the XREADGROUP reply shape", async () => {
    const { client } = fakeRedis({
      xreadgroup: () =>
        Promise.resolve([
          [
            "mem:writes",
            [
              ["1-1", ["event", JSON.stringify(evt("a"))]],
              ["1-2", ["event", JSON.stringify(evt("b"))]],
            ],
          ],
        ]),
    });
    const s = new RedisMemWriteStream(client as never);

    const got = await s.read("c1", 10, 0);

    assert.deepEqual(
      got.map((e) => e.id),
      ["1-1", "1-2"],
    );
    assert.equal(got[0]!.event.event_id, "a");
  });

  it("drops a corrupt entry instead of wedging the consumer group forever", async () => {
    const { client } = fakeRedis({
      xreadgroup: () =>
        Promise.resolve([
          [
            "mem:writes",
            [
              ["1-1", ["event", "{not json"]],
              ["1-2", ["event", JSON.stringify(evt("good"))]],
            ],
          ],
        ]),
    });
    const s = new RedisMemWriteStream(client as never);

    const got = await s.read("c1", 10, 0);

    assert.equal(got.length, 1, "the good entry still arrives");
    assert.equal(got[0]!.event.event_id, "good");
  });

  it("returns [] on an empty stream rather than throwing", async () => {
    const { client } = fakeRedis({ xreadgroup: () => Promise.resolve(null) });
    const s = new RedisMemWriteStream(client as never);

    assert.deepEqual(await s.read("c1", 10, 0), []);
  });

  it("does not send an empty XACK", async () => {
    const { client, cmds } = fakeRedis();
    const s = new RedisMemWriteStream(client as never);

    await s.ack([]);

    assert.equal(cmds.filter((c) => c[0] === "xack").length, 0, "XACK with no ids is an error");
  });

  it("acks every id in one command", async () => {
    const { client, cmds } = fakeRedis();
    const s = new RedisMemWriteStream(client as never);

    await s.ack(["1-1", "1-2", "1-3"]);

    const xack = cmds.find((c) => c[0] === "xack");
    assert.ok(xack);
    assert.ok(["1-1", "1-2", "1-3"].every((id) => xack.includes(id)));
  });

  it("reports pending depth — the continuity metric, not queue trivia", async () => {
    const { client } = fakeRedis({ xpending: () => Promise.resolve([4, "1-1", "1-4", []]) });
    const s = new RedisMemWriteStream(client as never);

    assert.equal(await s.pendingCount(), 4);
  });

  it("reports zero pending when XPENDING answers null", async () => {
    const { client } = fakeRedis({ xpending: () => Promise.resolve(null) });
    const s = new RedisMemWriteStream(client as never);

    assert.equal(await s.pendingCount(), 0);
  });
});
