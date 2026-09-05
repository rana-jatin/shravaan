/**
 * Slice 8 — degradation.
 *
 * Everything here is about what happens when a dependency goes. The assertions
 * are deliberately about BEHAVIOUR UNDER FAILURE rather than about happy paths:
 * every one of these code paths only ever runs on a bad day, which is precisely
 * why it will not be exercised by hand.
 *
 * No network, no credentials, no real clocks — time and randomness are injected
 * throughout so a test asserting "gives up after 2.5 seconds" does not take 2.5
 * seconds to run.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  LLM_RETRY,
  SOCKET_RECONNECT,
  delayFor,
  rawDelayFor,
  retryPlan,
  withBackoff,
} from "@sp-i/shared/domain/backoff.ts";
import { CircuitBreaker, guard } from "../src/domain/circuit-breaker.ts";
import {
  DEGRADATIONS,
  DegradationLedger,
  survivability,
  type DegradationKey,
} from "../src/domain/degradation.ts";
import { FLUX_MULTI_COVERAGE, redundancyProfile, standbyFor } from "../src/domain/asr-failover.ts";
import { ASR_STABLE_MS, reopenDecision } from "../src/domain/asr-reopen.ts";
import { BufferedMemWriteStream } from "../src/memory/buffered-stream.ts";
import { InMemoryMemWriteStream, type MemWriteStream } from "../src/memory/stream.ts";
import { HoldingAudio, REQUIRED_CLIPS } from "../src/audio/holding-audio.ts";
import { GuardedSessionStore } from "../src/store/guarded-store.ts";
import { NullSessionStore } from "../src/store/session-store.ts";
import { SPEAKABLE } from "../src/domain/languages.ts";
import { COPY } from "../src/copy/refusals.ts";
import type { MemWriteEvent, MemWriteKind, MessageKey } from "@sp-i/shared/domain/types.ts";

// ---------------------------------------------------------------------------

describe("backoff", () => {
  it("doubles until the ceiling", () => {
    const p = { ...LLM_RETRY, jitter: false };
    assert.equal(rawDelayFor(0, p), 250);
    assert.equal(rawDelayFor(1, p), 500);
    assert.equal(rawDelayFor(2, p), 1000);
    assert.equal(rawDelayFor(20, p), p.maxDelayMs, "must not grow without bound");
  });

  it("spreads the herd", () => {
    // The property that actually matters. Sarvam's limit is per ACCOUNT, so a
    // 429 hits every live conversation at once; un-jittered backoff marches them
    // all into the same retry instant and trips the limit again.
    const early = delayFor(2, LLM_RETRY, () => 0.01);
    const late = delayFor(2, LLM_RETRY, () => 0.99);
    assert.ok(early < late, "two sessions must not retry at the same moment");
    assert.ok(early >= 0 && late <= rawDelayFor(2, LLM_RETRY));
  });

  it("never exceeds the uncapped delay for that attempt", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const r of [0, 0.5, 0.999]) {
        const d = delayFor(attempt, SOCKET_RECONNECT, () => r);
        assert.ok(d >= 0 && d <= rawDelayFor(attempt, SOCKET_RECONNECT));
      }
    }
  });

  it("stops planning once the budget is spent", () => {
    const plan = retryPlan(LLM_RETRY);
    const total = plan.reduce((a, b) => a + b, 0);
    assert.ok(total <= LLM_RETRY.budgetMs, `plan of ${total}ms exceeds the budget`);
    assert.ok(plan.length < LLM_RETRY.maxAttempts, "the last attempt has nothing after it");
  });

  it("retries a retryable failure and returns the eventual success", async () => {
    let calls = 0;
    const out = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("429");
        return "ok";
      },
      {
        policy: { ...LLM_RETRY, jitter: false },
        retryable: () => true,
        sleep: async () => {},
        now: () => 0,
      },
    );
    assert.equal(out, "ok");
    assert.equal(calls, 3);
  });

  it("does not retry what will not fix itself", async () => {
    // A 400 does not become a 200 in 250ms, and retrying it burns the same rate
    // limit a 429 would be telling us about.
    let calls = 0;
    await assert.rejects(
      withBackoff(
        async () => {
          calls += 1;
          throw new Error("bad request");
        },
        {
          policy: LLM_RETRY,
          retryable: () => false,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    );
    assert.equal(calls, 1, "a non-retryable error must propagate on the first attempt");
  });

  it("gives up on the budget rather than on the attempt count", async () => {
    // The person waiting is the binding constraint, not the provider.
    let clock = 0;
    let calls = 0;
    const gaveUp: Array<{ elapsedMs: number }> = [];

    await assert.rejects(
      withBackoff(
        async () => {
          calls += 1;
          clock += 900; // each attempt is slow in its own right
          throw new Error("429");
        },
        {
          policy: { baseMs: 250, maxDelayMs: 2000, maxAttempts: 10, budgetMs: 1000, jitter: false },
          retryable: () => true,
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
          onGiveUp: (info) => gaveUp.push({ elapsedMs: info.elapsedMs }),
        },
      ),
    );

    assert.ok(calls < 10, `stopped after ${calls} attempts, not the full ten`);
    assert.equal(gaveUp.length, 1);
  });

  it("honours a provider-dictated wait when it is longer than ours", async () => {
    const slept: number[] = [];
    await assert.rejects(
      withBackoff(async () => Promise.reject(new Error("429")), {
        policy: { baseMs: 100, maxDelayMs: 100, maxAttempts: 2, budgetMs: 10_000, jitter: false },
        retryable: () => true,
        retryAfter: () => 3000,
        sleep: async (ms) => {
          slept.push(ms);
        },
        now: () => 0,
      }),
    );
    assert.deepEqual(slept, [3000], "ignoring Retry-After is how an account gets throttled harder");
  });

  it("abandons the retry when the turn is aborted", async () => {
    // Barge-in. Retrying into an abandoned turn answers a question the user has
    // already moved past.
    const ctrl = new AbortController();
    let calls = 0;
    await assert.rejects(
      withBackoff(
        async () => {
          calls += 1;
          ctrl.abort();
          throw new Error("429");
        },
        {
          policy: LLM_RETRY,
          retryable: () => true,
          signal: ctrl.signal,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    );
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  it("opens after the threshold and then fails fast", () => {
    const clock = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, openMs: 1000, now: () => clock });

    assert.equal(b.canAttempt(), true);
    b.onFailure();
    b.onFailure();
    assert.equal(b.state, "closed", "two failures is not yet an outage");
    b.onFailure();

    assert.equal(b.state, "open");
    assert.equal(b.canAttempt(), false, "this is the whole point: no round trip at all");
  });

  it("admits exactly one probe when half-open", () => {
    let clock = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 1000, now: () => clock });
    b.onFailure();
    assert.equal(b.canAttempt(), false);

    clock = 1001;
    assert.equal(b.state, "half_open");
    assert.equal(b.canAttempt(), true, "one probe");
    assert.equal(b.canAttempt(), false, "and only one — a recovering store must not be stampeded");
  });

  it("closes again on a successful probe", () => {
    let clock = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 100, now: () => clock });
    b.onFailure();
    clock = 200;
    assert.equal(b.canAttempt(), true);
    b.onSuccess();
    assert.equal(b.state, "closed");
    assert.equal(b.failures, 0);
  });

  it("guard returns the fallback instead of throwing", async () => {
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 });
    const first = await guard(
      b,
      async () => {
        throw new Error("ECONNREFUSED");
      },
      "fallback",
    );
    assert.equal(first, "fallback");

    let called = false;
    const second = await guard(
      b,
      async () => {
        called = true;
        return "live";
      },
      "fallback",
    );
    assert.equal(second, "fallback");
    assert.equal(called, false, "an open circuit must not even attempt the call");
  });
});

// ---------------------------------------------------------------------------

describe("degradation ledger", () => {
  it("marks once, however many times a dependency flaps", () => {
    const l = new DegradationLedger();
    assert.equal(l.mark("store_unavailable"), true);
    assert.equal(l.mark("store_unavailable"), false, "the transition, not the event");
    assert.deepEqual(l.list(), ["store_unavailable"]);
  });

  it("mirrors into session state exactly once per change", () => {
    const seen: DegradationKey[][] = [];
    const l = new DegradationLedger([], (keys) => seen.push(keys));
    l.mark("store_unavailable");
    l.mark("store_unavailable");
    l.mark("tools_unavailable");
    l.clear("store_unavailable");
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[2], ["tools_unavailable"]);
  });

  it("rehydrates a resumed session and ignores keys it does not know", () => {
    // A resumed session inherits what was broken when it paused. An unknown key
    // from an older build must not crash the session that reads it.
    const l = new DegradationLedger(["store_unavailable", "something_from_the_future"]);
    assert.deepEqual(l.list(), ["store_unavailable"]);
  });

  it("keeps talking through shallow failures and stops for mute ones", () => {
    assert.equal(survivability([]).level, "ok");
    assert.equal(survivability(["store_unavailable", "tools_unavailable"]).level, "degraded");

    const fatal = survivability(["store_unavailable", "tts_unavailable"]);
    assert.equal(fatal.level, "mute");
    assert.equal(fatal.fatal, "tts_unavailable");
  });

  it("never asks the user to hear about a shallow degradation", () => {
    // A companion filing an operations report is worse than one that is quietly
    // a little thinner today.
    for (const [key, spec] of Object.entries(DEGRADATIONS)) {
      if (spec.severity === "shallow") {
        assert.equal(spec.message_key, undefined, `${key} would be announced to the user`);
      }
    }
  });

  it("gives every mute failure something to say", () => {
    // The inverse failure — going quiet without saying why — is the exact bug
    // this system exists to never produce.
    for (const [key, spec] of Object.entries(DEGRADATIONS)) {
      if (spec.severity === "mute") {
        assert.ok(spec.message_key, `${key} would end the session in silence`);
      }
    }
  });

  it("needs pre-rendered audio for exactly the failure that breaks synthesis", () => {
    const needsBytes = Object.entries(DEGRADATIONS)
      .filter(([, s]) => s.requires_prerendered_audio)
      .map(([k]) => k);
    assert.deepEqual(needsBytes, ["tts_unavailable"]);
  });

  it("reports what the user lost without being told", () => {
    const l = new DegradationLedger();
    l.mark("store_unavailable");
    l.mark("asr_unavailable");
    const silent = l.silentLosses();
    assert.equal(silent.length, 1);
    assert.equal(silent[0]!.key, "store_unavailable");
    assert.ok(silent[0]!.lost.length > 0);
  });
});

// ---------------------------------------------------------------------------

describe("asr failover", () => {
  it("covers two of eleven languages, and that is the whole redundancy story", () => {
    const profile = redundancyProfile(SPEAKABLE.map((l) => l.code));
    assert.deepEqual(profile.redundant.sort(), [...FLUX_MULTI_COVERAGE].sort());
    assert.equal(
      profile.singleVendor.length,
      SPEAKABLE.length - FLUX_MULTI_COVERAGE.length,
      "nine speakable languages have no second ASR at any stage",
    );
  });

  it("offers the standby for Hindi", () => {
    const d = standbyFor("hi-IN", { configured: true, current: "sarvam" });
    assert.equal(d.available, true);
    assert.equal(d.available && d.languageHint, "hi", "Flux wants a bare subtag, not hi-IN");
  });

  it("refuses honestly for a language Deepgram cannot hear", () => {
    const d = standbyFor("ta-IN", { configured: true, current: "sarvam" });
    assert.equal(d.available, false);
    assert.equal(d.available === false && d.reason, "no_coverage");
  });

  it("reports an unconfigured standby as unavailable rather than as coverage", () => {
    // These two are different incidents and must not be conflated in a postmortem.
    const d = standbyFor("hi-IN", { configured: false, current: "sarvam" });
    assert.equal(d.available === false && d.reason, "not_configured");
  });

  it("does not loop back to Sarvam once failed over", () => {
    const d = standbyFor("hi-IN", { configured: true, current: "deepgram" });
    assert.equal(d.available === false && d.reason, "already_failed_over");
  });
});

// ---------------------------------------------------------------------------

/**
 * The reopen ladder, and the regression that motivated extracting it.
 *
 * The session used to zero this count on the socket's `open` event. Sarvam
 * accepts the WebSocket upgrade and only then rejects a bad parameter, so a
 * doomed socket opens exactly like a healthy one and the count went 0 → 1 → 0 → 1
 * forever. Both thresholds here are above 1, so both were dead code against a
 * live key: no failover, and — worse — no give-up, leaving the session
 * reconnecting in a tight loop while the user heard nothing.
 */
describe("asr reopen ladder", () => {
  const base = { standbyAvailable: false, maxReopens: 4, rand: () => 0 };

  it("counts consecutive failures when the socket never worked", () => {
    // THE REGRESSION. Each of these is an open-then-reject, the exact shape that
    // used to reset the count. The attempt number must climb.
    const attempts = [0, 1, 2, 3].map(
      (reopens) => reopenDecision({ ...base, reopens, socketWasStable: false }).reopens,
    );
    assert.deepEqual(attempts, [1, 2, 3, 4], "a rejected socket must not look like a fresh start");
  });

  it("stops reconnecting once the budget is spent", () => {
    const d = reopenDecision({ ...base, reopens: 4, socketWasStable: false });
    assert.equal(d.action, "lose_hearing", "the loop has to end somewhere the user can hear about");
  });

  it("reconnects rather than giving up while budget remains", () => {
    const d = reopenDecision({ ...base, reopens: 0, socketWasStable: false });
    assert.equal(d.action, "reopen");
    assert.equal(d.action === "reopen" && typeof d.delayMs, "number");
  });

  it("treats a connection that actually ran as a fresh incident", () => {
    // Four failures spread across an hour of healthy conversation must not
    // accumulate into a mute — the concern that motivated the original reset.
    const d = reopenDecision({ ...base, reopens: 4, socketWasStable: true });
    assert.equal(d.reopens, 1);
    assert.equal(d.action, "reopen", "a long-lived socket dropping is incident one, not five");
  });

  it("fails over on the second failure, not the first", () => {
    // Deepgram publishes no India region, so relocating a user's voice on one
    // transient blip would be a compliance decision made by a network hiccup.
    const first = reopenDecision({
      ...base,
      standbyAvailable: true,
      reopens: 0,
      socketWasStable: false,
    });
    assert.equal(first.action, "reopen", "one blip is not grounds to leave the country");

    const second = reopenDecision({
      ...base,
      standbyAvailable: true,
      reopens: 1,
      socketWasStable: false,
    });
    assert.equal(second.action, "failover");
  });

  it("prefers failover over going deaf when a standby exists", () => {
    const d = reopenDecision({
      ...base,
      standbyAvailable: true,
      reopens: 9,
      socketWasStable: false,
    });
    assert.equal(
      d.action,
      "failover",
      "a covered language should relocate before it stops hearing",
    );
  });

  it("goes deaf rather than pretending, for the nine languages with no standby", () => {
    const d = reopenDecision({
      ...base,
      standbyAvailable: false,
      reopens: 9,
      socketWasStable: false,
    });
    assert.equal(d.action, "lose_hearing");
  });

  it("separates a rejected socket from a working one by a wide margin", () => {
    // Observed: parameter rejections closed in under half a second, real
    // sessions live for minutes. The threshold must not sit near either.
    assert.ok(ASR_STABLE_MS >= 5_000, "too low: a slow rejection would count as working");
    assert.ok(ASR_STABLE_MS <= 60_000, "too high: real sessions would never reset the count");
  });
});

// ---------------------------------------------------------------------------

const ev = (kind: MemWriteKind, n: number): MemWriteEvent => ({
  event_id: `e${n}`,
  sid: "s1",
  uid: "u1",
  tid: n,
  at: new Date(n * 1000).toISOString(),
  kind,
});

/** A stream that fails until told otherwise. */
class FlakyStream implements MemWriteStream {
  failing = true;
  readonly delivered: MemWriteEvent[] = [];
  async append(event: MemWriteEvent): Promise<void> {
    if (this.failing) throw new Error("ECONNREFUSED");
    this.delivered.push(event);
  }
  async read(): Promise<never[]> {
    return [];
  }
  async ack(): Promise<void> {}
  async pendingCount(): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {}
}

describe("mem:writes under an outage", () => {
  it("never throws into the turn path", async () => {
    const s = new BufferedMemWriteStream(new FlakyStream(), { capacity: 10 });
    await s.append(ev("turn_completed", 1));
    assert.equal(s.bufferedCount, 1);
    assert.equal(s.buffering, true);
  });

  it("drains in order once the stream comes back", async () => {
    // Order is not cosmetic: a correction that arrives before the fact it
    // corrects reads to the distiller as a contradiction.
    const inner = new FlakyStream();
    const s = new BufferedMemWriteStream(inner, { capacity: 10 });
    await s.append(ev("turn_completed", 1));
    await s.append(ev("turn_completed", 2));
    await s.append(ev("correction", 3));

    inner.failing = false;
    await s.flush();

    assert.deepEqual(
      inner.delivered.map((e) => e.tid),
      [1, 2, 3],
    );
    assert.equal(s.buffering, false);
    assert.equal(s.bufferedCount, 0);
  });

  it("queues behind the backlog rather than jumping it", async () => {
    const inner = new FlakyStream();
    const s = new BufferedMemWriteStream(inner, { capacity: 10 });
    await s.append(ev("turn_completed", 1));
    inner.failing = false;
    // Still buffering: this must not overtake the event already waiting.
    await s.append(ev("turn_completed", 2));
    await s.flush();
    assert.deepEqual(
      inner.delivered.map((e) => e.tid),
      [1, 2],
    );
  });

  it("drops the least important event on overflow, not simply the oldest", async () => {
    // Losing a turn costs a detail. Losing a correction leaves a superseded fact
    // standing as current, and a companion confidently repeating something you
    // corrected is a worse failure than one that merely forgot.
    const inner = new FlakyStream();
    const s = new BufferedMemWriteStream(inner, { capacity: 3 });
    await s.append(ev("correction", 1));
    await s.append(ev("turn_completed", 2));
    await s.append(ev("turn_completed", 3));
    await s.append(ev("turn_completed", 4)); // overflows

    assert.equal(s.droppedCount, 1);
    inner.failing = false;
    await s.flush();
    assert.ok(
      inner.delivered.some((e) => e.kind === "correction"),
      "the correction must survive an overflow",
    );
    assert.deepEqual(
      inner.delivered.map((e) => e.tid),
      [1, 3, 4],
    );
  });

  it("counts drops as lost memories rather than swallowing them", async () => {
    const s = new BufferedMemWriteStream(new FlakyStream(), { capacity: 2 });
    for (let i = 0; i < 6; i++) await s.append(ev("turn_completed", i));
    assert.equal(s.bufferedCount, 2);
    assert.equal(s.droppedCount, 4, "the number of things the companion will never learn");
  });

  it("keeps the lag metric honest about work that never reached Redis", async () => {
    const s = new BufferedMemWriteStream(new FlakyStream(), { capacity: 10 });
    await s.append(ev("turn_completed", 1));
    assert.equal(await s.pendingCount(), 1);
  });

  it("passes straight through when the stream is healthy", async () => {
    const inner = new InMemoryMemWriteStream();
    const s = new BufferedMemWriteStream(inner, { capacity: 10 });
    await s.append(ev("turn_completed", 1));
    assert.equal(s.buffering, false);
    assert.equal(s.bufferedCount, 0);
    assert.equal(await inner.pendingCount(), 1);
  });
});

// ---------------------------------------------------------------------------

describe("pre-rendered holding audio", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sp-i-holding-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        sample_rate: 24000,
        encoding: "linear16",
        speaker: "Shubh",
        rendered_at: "2026-01-01T00:00:00Z",
      }),
    );
    writeFileSync(join(dir, "degraded.voice_unavailable.hi-IN.pcm"), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(dir, "degraded.voice_unavailable.en-IN.pcm"), Buffer.from([5, 6]));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("loads what is on disk", () => {
    const h = new HoldingAudio({ dir, expectedSampleRate: 24000 });
    h.load();
    assert.equal(h.usable, true);
    assert.deepEqual([...(h.get("degraded.voice_unavailable", "hi-IN") ?? [])], [1, 2, 3, 4]);
  });

  it("falls down the refusal ladder rather than returning silence", () => {
    // Same principle as the text copy: a missing Odia clip becomes a Hindi
    // apology, never nothing.
    const h = new HoldingAudio({ dir, expectedSampleRate: 24000 });
    h.load();
    const odia = h.get("degraded.voice_unavailable", "or-IN");
    assert.ok(odia, "a missing clip must fall back, not vanish");
  });

  it("refuses a rate mismatch instead of playing a chipmunk", () => {
    const h = new HoldingAudio({ dir, expectedSampleRate: 16000 });
    h.load();
    assert.equal(h.usable, false);
    assert.equal(h.get("degraded.voice_unavailable", "hi-IN"), null);
  });

  it("survives a missing directory without throwing at boot", () => {
    const h = new HoldingAudio({ dir: join(dir, "nope"), expectedSampleRate: 24000 });
    h.load();
    assert.equal(h.usable, false);
    assert.equal(h.get("degraded.voice_unavailable", "hi-IN"), null);
  });

  it("names the languages it cannot apologise in", () => {
    const h = new HoldingAudio({ dir, expectedSampleRate: 24000 });
    h.load();
    const missing = h.missing();
    assert.equal(missing.length, SPEAKABLE.length - 2);
    assert.ok(!missing.includes("degraded.voice_unavailable.hi-IN"));
    assert.equal(REQUIRED_CLIPS.length, 1);
  });
});

// ---------------------------------------------------------------------------

class DeadStore extends NullSessionStore {
  calls = 0;
  override async loadForTurn(): Promise<never> {
    this.calls += 1;
    throw new Error("ECONNREFUSED");
  }
  override async saveState(): Promise<never> {
    this.calls += 1;
    throw new Error("ECONNREFUSED");
  }
  override async acquireLock(): Promise<never> {
    this.calls += 1;
    throw new Error("ECONNREFUSED");
  }
}

describe("store behind a breaker", () => {
  it("returns the stateless answer instead of throwing", async () => {
    const s = new GuardedSessionStore(new DeadStore());
    const ctx = await s.loadForTurn("s1", "u1", 12);
    assert.deepEqual(ctx, { state: null, turns: [], profile: null });
  });

  it("stops paying for the outage on every turn", async () => {
    // The reason this wrapper exists. ioredis against a dead server does not
    // fail in the ~5ms the latency budget allocates — it fails after a connect
    // timeout, on every call, forever, turning a dependency outage into a
    // latency outage.
    const dead = new DeadStore();
    const s = new GuardedSessionStore(dead, { breaker: { failureThreshold: 3, openMs: 60_000 } });

    for (let i = 0; i < 20; i++) await s.loadForTurn("s1", "u1", 12);

    assert.equal(dead.calls, 3, "three round trips, not twenty");
    assert.equal(s.healthy, false);
  });

  it("grants the turn lock during an outage", async () => {
    // Deliberate. Denying it would silently stop the user being answered at all,
    // trading a rare consistency risk for a guaranteed one.
    const s = new GuardedSessionStore(new DeadStore());
    assert.equal(await s.acquireLock("s1", "tok"), true);
  });

  it("hands back a fresh turn context each time", async () => {
    // Callers mutate the returned state in place; a shared frozen object would
    // leak one session's turns into another's.
    const s = new GuardedSessionStore(new DeadStore());
    const a = await s.loadForTurn("s1", "u1", 12);
    const b = await s.loadForTurn("s2", "u2", 12);
    a.turns.push({ tid: 1, role: "user", text: "x", language: "hi-IN", at: "now" });
    assert.equal(b.turns.length, 0);
  });
});

// ---------------------------------------------------------------------------

describe("degradation copy", () => {
  it("can say every closing message in all eleven languages", () => {
    // A refusal spoken in a language we cannot speak is silence, and this is the
    // one message that plays when everything else has already gone wrong.
    const keys = Object.keys(COPY) as MessageKey[];
    for (const key of keys.filter((k) => k.startsWith("degraded."))) {
      for (const lang of SPEAKABLE) {
        assert.ok(COPY[key][lang.code], `missing ${key} for ${lang.code}`);
      }
    }
  });

  it("has a closing line for every mute degradation", () => {
    for (const spec of Object.values(DEGRADATIONS)) {
      if (spec.message_key) assert.ok(COPY[spec.message_key], `no copy for ${spec.message_key}`);
    }
  });
});
