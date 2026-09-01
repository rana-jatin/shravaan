/**
 * The timer that answers "where did the silence go".
 *
 * The properties worth pinning are the ones that would make the numbers lie
 * rather than merely be absent: first-write-wins on the marks that fire per
 * delta, and a null report for a turn that never reached audio. A timing line
 * that quietly reported the LAST token instead of the first would look
 * plausible and be useless.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUDGET_MS, TurnTimer } from "../src/domain/turn-timer.ts";

/** A clock that advances only when a test says so. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("TurnTimer", () => {
  it("reports nothing until the turn reaches audio", () => {
    const c = clock();
    const timer = new TurnTimer(c.now);

    timer.mark("asr_final");
    timer.mark("llm_sent");
    timer.mark("llm_first_token");
    timer.mark("first_clause");

    assert.equal(timer.report(), null, "a turn that never spoke has no timing to report");
  });

  it("reports nothing for a turn that was never started", () => {
    assert.equal(new TurnTimer(clock().now).report(), null);
  });

  it("splits the gap into the four server-side stages", () => {
    const c = clock();
    const timer = new TurnTimer(c.now);

    timer.mark("asr_final");
    c.advance(4);
    timer.mark("llm_sent");
    c.advance(210);
    timer.mark("llm_first_token");
    c.advance(30);
    timer.mark("first_clause");
    c.advance(240);
    timer.mark("first_audio");

    const t = timer.report();
    assert.ok(t);
    assert.equal(t.prepare_ms, 4);
    assert.equal(t.llm_ttft_ms, 210);
    assert.equal(t.clause_ms, 30);
    assert.equal(t.tts_ttfa_ms, 240);
    assert.equal(t.gap_ms, 484, "the stages must account for the whole gap");
    assert.equal(t.prepare_ms + t.llm_ttft_ms + t.clause_ms + t.tts_ttfa_ms, t.gap_ms);
  });

  it("says nothing is over budget when nothing is", () => {
    const c = clock();
    const timer = new TurnTimer(c.now);
    for (const stage of ["asr_final", "llm_sent", "llm_first_token", "first_clause"] as const) {
      timer.mark(stage);
      c.advance(1);
    }
    timer.mark("first_audio");

    assert.deepEqual(timer.report()!.over_budget, []);
  });

  it("names the stage that blew its allowance", () => {
    const c = clock();
    const timer = new TurnTimer(c.now);

    timer.mark("asr_final");
    timer.mark("llm_sent");
    c.advance(4100); // the reasoning-model failure mode, in one number
    timer.mark("llm_first_token");
    timer.mark("first_clause");
    timer.mark("first_audio");

    const t = timer.report()!;
    assert.deepEqual(t.over_budget, [`llm_ttft_ms=4100ms>${BUDGET_MS.llm_ttft_ms}ms`]);
  });

  it("orders over-budget stages worst-first, by absolute overshoot", () => {
    // Both are over; the one to look at first is the one costing the most time,
    // not the one furthest over in proportion.
    const c = clock();
    const timer = new TurnTimer(c.now);

    timer.mark("asr_final");
    c.advance(105); // prepare: 100ms over a 5ms budget
    timer.mark("llm_sent");
    c.advance(1250); // llm: 1000ms over a 250ms budget
    timer.mark("llm_first_token");
    timer.mark("first_clause");
    timer.mark("first_audio");

    const t = timer.report()!;
    assert.equal(t.over_budget.length, 2);
    assert.match(t.over_budget[0]!, /^llm_ttft_ms=/, "the bigger overshoot comes first");
    assert.match(t.over_budget[1]!, /^prepare_ms=/);
  });

  it("keeps the FIRST token, not the last — the mark fires on every delta", () => {
    // `speak()` runs per content delta, so llm_first_token is marked repeatedly.
    // Overwriting would report when the model FINISHED, which is a different and
    // much larger number that would look entirely plausible in a log.
    const c = clock();
    const timer = new TurnTimer(c.now);

    timer.mark("asr_final");
    timer.mark("llm_sent");
    c.advance(200);
    timer.mark("llm_first_token"); // first delta
    c.advance(3000); // the rest of the reply streams
    timer.mark("llm_first_token"); // last delta
    timer.mark("first_clause");
    timer.mark("first_audio");

    assert.equal(timer.report()!.llm_ttft_ms, 200);
  });

  it("keeps the first llm_sent across tool rounds", () => {
    // A second tool round issues a second request. It is more waiting, but it is
    // not time-to-first-token, and folding it in would hide the real TTFT.
    const c = clock();
    const timer = new TurnTimer(c.now);

    timer.mark("asr_final");
    c.advance(5);
    timer.mark("llm_sent"); // round 0
    c.advance(900);
    timer.mark("llm_sent"); // round 1, after a tool
    c.advance(100);
    timer.mark("llm_first_token");
    timer.mark("first_clause");
    timer.mark("first_audio");

    assert.equal(timer.report()!.prepare_ms, 5);
    assert.equal(timer.report()!.llm_ttft_ms, 1000);
  });

  it("defaults to a real clock when none is injected", () => {
    const timer = new TurnTimer();
    for (const stage of [
      "asr_final",
      "llm_sent",
      "llm_first_token",
      "first_clause",
      "first_audio",
    ] as const) {
      timer.mark(stage);
    }
    const t = timer.report();
    assert.ok(t);
    assert.ok(t.gap_ms >= 0 && t.gap_ms < 1000, "a synchronous run should be near-instant");
  });

  it("matches the budget table in docs/03", () => {
    // If these move, docs/03 section 3 moved with them — or should have.
    assert.deepEqual(BUDGET_MS, {
      prepare_ms: 5,
      llm_ttft_ms: 250,
      clause_ms: 40,
      tts_ttfa_ms: 250,
    });
  });
});
