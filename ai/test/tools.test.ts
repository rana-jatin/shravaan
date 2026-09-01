/**
 * Tools, fillers and entitlements — slice 6.
 *
 * The failure paths matter more than the happy path here. A tool that succeeds
 * needs no help; a tool that times out, or that the user is not entitled to,
 * is where an agent either stays coherent or starts lying about what it is doing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FALLBACKS,
  FILLERS,
  PROGRESS,
  pendingCopyReview,
  resolveFallback,
  resolveFiller,
  resolveProgress,
} from "../src/copy/fillers.ts";
import { SPEAKABLE, isSpeakable } from "../src/domain/languages.ts";
import type { JsonContext } from "@sp-i/shared/domain/types.ts";
import { ToolExecutor } from "../src/tools/executor.ts";
import { ToolRegistry, validateArgs } from "../src/tools/registry.ts";
import type { PendingCall } from "../src/tools/types.ts";
import { fakeHost } from "./helpers.ts";

const ctxWith = (entitlements: JsonContext["entitlements"]): JsonContext => ({
  uid: "u1",
  fetched_at: new Date().toISOString(),
  identity: { display_name: "Test" },
  entitlements,
});

function registry(overrides: Partial<Parameters<ToolRegistry["register"]>[0]> = {}) {
  return new ToolRegistry().register({
    name: "get_balance",
    description: "Look up the account balance",
    parameters: {
      type: "object",
      properties: { account: { type: "string" } },
      required: ["account"],
    },
    handler: async () => ({ balance: 1200 }),
    ...overrides,
  });
}

function executor(
  reg: ToolRegistry,
  over: Partial<ConstructorParameters<typeof ToolExecutor>[0]> = {},
) {
  const spoken: string[] = [];
  const pendingWrites: PendingCall[] = [];
  const cleared: string[] = [];
  const exec = new ToolExecutor({
    registry: reg,
    uid: "u1",
    sid: "s1",
    speakFiller: (lang) => spoken.push(lang),
    host: fakeHost(),
    setPending: async (c) => void pendingWrites.push(c),
    clearPending: async (id) => void cleared.push(id),
    ...over,
  });
  return { exec, spoken, pendingWrites, cleared };
}

describe("entitlement gating", () => {
  it("hides an ungranted tool from the model entirely", () => {
    const reg = registry({ requires_entitlement: "banking" });
    const ctx = ctxWith([{ key: "banking", granted: false, expires_at: null }]);

    // Offering and then withdrawing is worse than never mentioning it.
    assert.equal(reg.offerableTo(ctx).length, 0);
    assert.equal(reg.schemasFor(ctx).length, 0);
  });

  it("offers a granted tool", () => {
    const reg = registry({ requires_entitlement: "banking" });
    const ctx = ctxWith([{ key: "banking", granted: true, expires_at: null }]);
    assert.equal(reg.offerableTo(ctx).length, 1);
  });

  it("treats an expired entitlement as absent", () => {
    const reg = registry({ requires_entitlement: "banking" });
    const ctx = ctxWith([
      { key: "banking", granted: true, expires_at: new Date(Date.now() - 1000).toISOString() },
    ]);
    assert.equal(reg.offerableTo(ctx).length, 0);
  });

  it("withholds gated tools when context is unavailable", () => {
    // Silently offering a capability we cannot verify is worse than offering
    // fewer for a while.
    const reg = registry({ requires_entitlement: "banking" });
    assert.equal(reg.offerableTo(null).length, 0);
  });

  it("still offers ungated tools without context", () => {
    assert.equal(registry().offerableTo(null).length, 1);
  });

  it("refuses execution even if a call slips through", async () => {
    const reg = registry({ requires_entitlement: "banking" });
    const { exec } = executor(reg);
    const r = await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "main" } },
      { language: "hi-IN", jsonContext: ctxWith([]) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, "not_entitled");
  });
});

describe("argument validation", () => {
  const tool = registry().get("get_balance")!;

  it("accepts valid args", () => {
    assert.equal(validateArgs(tool, { account: "main" }).ok, true);
  });

  it("rejects a missing required arg", () => {
    const r = validateArgs(tool, {});
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /account/);
  });

  it("rejects a hallucinated argument name", () => {
    assert.equal(validateArgs(tool, { account: "x", nonsense: 1 }).ok, false);
  });

  it("rejects a wrong type", () => {
    assert.equal(validateArgs(tool, { account: 42 }).ok, false);
  });

  it("enforces enums", () => {
    const reg = new ToolRegistry().register({
      name: "set_mode",
      description: "d",
      parameters: { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } },
      handler: async () => ({}),
    });
    assert.equal(validateArgs(reg.get("set_mode")!, { mode: "c" }).ok, false);
    assert.equal(validateArgs(reg.get("set_mode")!, { mode: "a" }).ok, true);
  });
});

describe("a tool with no parameters tolerates junk arguments", () => {
  /**
   * Measured against a live key, 2026-08-30: sarvam-105b sends a junk argument
   * object for no-argument tools on roughly 40% of calls (2 of 5 goodbyes, and
   * both live sessions). The captured shape is `{"{}": "{}"}` — assembled from
   * the fragments `{`, `"{}": `, `"{}`, `"`, `}`, so the model generated it and
   * the parser reconstructed it faithfully.
   *
   * Rejecting it burned a round trip on nearly every conversation close, against
   * the rate limit that is this system's concurrency ceiling.
   */
  const noParams = new ToolRegistry().register({
    name: "hang_up",
    description: "d",
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => ({ done: true }),
  });

  it("accepts the exact object the model was observed sending", () => {
    assert.equal(validateArgs(noParams.get("hang_up")!, { "{}": "{}" }).ok, true);
  });

  it("still accepts the empty object it should have sent", () => {
    assert.equal(validateArgs(noParams.get("hang_up")!, {}).ok, true);
  });

  it("does NOT loosen a tool that declares parameters", () => {
    // The leniency is scoped to tools with nothing to protect. Everywhere else a
    // stray key is a hallucination and must still fail.
    const withParams = registry().get("get_balance")!;
    assert.equal(validateArgs(withParams, { account: "x", "{}": "{}" }).ok, false);
  });
});

describe("execution and deadlines", () => {
  it("returns data on success and records elapsed time", async () => {
    const { exec } = executor(registry());
    const r = await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "main" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok === true ? r.data : null, { balance: 1200 });
  });

  it("times out a slow tool and speaks a timeout fallback", async () => {
    const reg = registry({
      deadline_ms: 60,
      filler_threshold_ms: 10_000,
      handler: (_a, c) =>
        new Promise((_res, rej) => {
          c.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        }),
    });
    const { exec } = executor(reg);

    const r = await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "main" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error.code, "timeout");
    assert.equal(r.ok === false && r.error.spoken_fallback_key, "tool.timeout");
  });

  it("reports an unknown tool rather than throwing", async () => {
    const { exec } = executor(registry());
    const r = await exec.execute(
      { call_id: "c1", name: "invented_by_the_model", args: {} },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(r.ok === false && r.error.code, "unknown_tool");
  });

  it("converts a thrown handler into a spoken fallback", async () => {
    const reg = registry({
      handler: async () => {
        throw new Error("upstream 503");
      },
    });
    const { exec } = executor(reg);
    const r = await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "main" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(r.ok === false && r.error.code, "upstream_error");
    // The upstream message is for logs, never for the user.
    assert.equal(r.ok === false && r.error.spoken_fallback_key, "tool.unavailable");
  });
});

describe("pending entries are cleared on EVERY path", () => {
  const paths: Array<[string, () => ToolRegistry, Record<string, unknown>, JsonContext | null]> = [
    ["success", () => registry(), { account: "main" }, null],
    ["invalid args", () => registry(), {}, null],
    [
      "thrown handler",
      () =>
        registry({
          handler: async () => {
            throw new Error("x");
          },
        }),
      { account: "m" },
      null,
    ],
    [
      "timeout",
      () =>
        registry({
          deadline_ms: 40,
          filler_threshold_ms: 10_000,
          handler: (_a, c) =>
            new Promise((_r, rej) => c.signal.addEventListener("abort", () => rej(new Error("t")))),
        }),
      { account: "m" },
      null,
    ],
  ];

  for (const [name, makeReg, args, ctx] of paths) {
    it(`clears after ${name}`, async () => {
      const { exec } = executor(makeReg());
      await exec.execute(
        { call_id: "c1", name: "get_balance", args },
        { language: "hi-IN", jsonContext: ctx },
      );
      // A stale entry makes the agent claim it is still working on something
      // it abandoned — worse than the original error.
      assert.equal(exec.pendingCount, 0, `pending leaked after ${name}`);
    });
  }

  it("clears everything in flight on barge-in", async () => {
    const reg = registry({
      deadline_ms: 5000,
      handler: () => new Promise(() => {}),
    });
    const { exec } = executor(reg);
    void exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "hi-IN", jsonContext: null },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(exec.pendingCount, 1);

    await exec.clearAll();
    assert.equal(exec.pendingCount, 0);
  });
});

describe("spoken fillers", () => {
  it("speaks only when a call actually runs slow", async () => {
    const fast = registry({ filler_threshold_ms: 200, handler: async () => ({ ok: 1 }) });
    const { exec, spoken } = executor(fast);
    await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.deepEqual(spoken, [], "a fast tool must not feel slow");
  });

  it("speaks once for a slow call, in the session language", async () => {
    const slow = registry({
      filler_threshold_ms: 20,
      deadline_ms: 2000,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { ok: 1 };
      },
    });
    const { exec, spoken } = executor(slow);
    await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "ta-IN", jsonContext: null },
    );
    assert.deepEqual(spoken, ["ta-IN"], "exactly one filler, in the right language");
  });

  it("hands the tool's own progress key to the caller", async () => {
    const slow = registry({
      filler_threshold_ms: 20,
      deadline_ms: 2000,
      progress_key: "progress.weather",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { ok: 1 };
      },
    });
    const keys: Array<string | undefined> = [];
    const { exec } = executor(slow, { speakFiller: (_l, k) => void keys.push(k) });
    await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.deepEqual(keys, ["progress.weather"]);
  });

  it("fires once PER CALL — which is why the round guard exists", async () => {
    // Calls in a round now run concurrently (session.#runTools), so two slow
    // tools reach their thresholds independently and the executor announces
    // both. Collapsing them into one spoken line is the orchestrator's job:
    // without it the user hears "One moment." "Let me check." back to back,
    // which sounds like a stutter rather than patience.
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { ok: 1 };
    };
    const reg = registry({ filler_threshold_ms: 20, deadline_ms: 2000, handler: slow }).register({
      name: "other_tool",
      description: "second slow tool",
      parameters: { type: "object", properties: {}, required: [] },
      filler_threshold_ms: 20,
      deadline_ms: 2000,
      handler: slow,
    });
    const { exec, spoken } = executor(reg);

    await Promise.all([
      exec.execute(
        { call_id: "c1", name: "get_balance", args: { account: "m" } },
        { language: "hi-IN", jsonContext: null },
      ),
      exec.execute(
        { call_id: "c2", name: "other_tool", args: {} },
        { language: "hi-IN", jsonContext: null },
      ),
    ]);
    assert.equal(spoken.length, 2, "executor announces per call; the session dedupes per round");
  });
});

describe("context invalidation", () => {
  it("invalidates the cache after a mutating tool succeeds", async () => {
    let invalidated = 0;
    const reg = registry({ mutates_context: true });
    const { exec } = executor(reg, { invalidateContext: async () => void invalidated++ });

    const r = await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(r.ok === true && r.context_mutated, true);
    assert.equal(invalidated, 1);
  });

  it("does not invalidate for a read-only tool", async () => {
    let invalidated = 0;
    const { exec } = executor(registry(), { invalidateContext: async () => void invalidated++ });
    await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(invalidated, 0);
  });

  it("survives a store that is failing", async () => {
    // A store outage must not break a tool call that otherwise succeeded.
    const { exec } = executor(registry({ mutates_context: true }), {
      setPending: async () => {
        throw new Error("redis down");
      },
      clearPending: async () => {
        throw new Error("redis down");
      },
      invalidateContext: async () => {
        throw new Error("redis down");
      },
    });
    const r = await exec.execute(
      { call_id: "c1", name: "get_balance", args: { account: "m" } },
      { language: "hi-IN", jsonContext: null },
    );
    assert.equal(r.ok, true);
    assert.equal(exec.pendingCount, 0);
  });
});

describe("filler and fallback copy", () => {
  it("covers every speakable language", () => {
    for (const lang of SPEAKABLE) {
      assert.ok(FILLERS[lang.code], `no filler for ${lang.code}`);
      for (const key of Object.keys(FALLBACKS)) {
        assert.ok(
          FALLBACKS[key as keyof typeof FALLBACKS][lang.code],
          `no ${key} for ${lang.code}`,
        );
      }
    }
  });

  it("never holds copy for an unspeakable language", () => {
    for (const code of Object.keys(FILLERS))
      assert.ok(isSpeakable(code), `filler for unspeakable ${code}`);
  });

  it("rotates fillers so waiting does not sound like a loop", () => {
    const seen = new Set([0, 1, 2].map((i) => resolveFiller("hi-IN", i)));
    assert.ok(seen.size > 1, "a companion repeating one phrase stops sounding like a person");
  });

  it("falls back rather than returning nothing", () => {
    assert.ok(resolveFiller("zz-ZZ", 0).length > 0);
    assert.ok(resolveFallback("tool.timeout", "zz-ZZ").length > 0);
  });

  it("flags placeholder translations for native review", () => {
    const langs = new Set(pendingCopyReview().map((p) => p.language));
    assert.ok(!langs.has("en-IN"));
    assert.ok(!langs.has("hi-IN"));
    assert.ok(langs.size > 0, "the remaining nine are placeholders and must be flagged");
  });

  it("covers every speakable language with progress copy too", () => {
    for (const lang of SPEAKABLE) {
      for (const key of Object.keys(PROGRESS)) {
        assert.ok(PROGRESS[key as keyof typeof PROGRESS][lang.code], `no ${key} for ${lang.code}`);
      }
    }
  });

  it("flags placeholder progress copy for review as well", () => {
    // The scope string is the key, so a reviewer can see WHICH lines are drafts
    // rather than just how many.
    const scopes = new Set(pendingCopyReview().map((p) => p.scope));
    assert.ok(scopes.has("progress.weather"), "draft progress copy must be reported at boot");
  });

  it("rotates progress lines and falls back for an unknown language", () => {
    const seen = new Set([0, 1].map((i) => resolveProgress("progress.weather", "en-IN", i)));
    assert.ok(seen.size > 1, "asking twice in an evening should not sound identical");
    assert.ok(resolveProgress("progress.weather", "zz-ZZ").length > 0);
  });
});
