/**
 * The three ways this provider fails without saying so.
 *
 * Every case here was observed against a live key on 2026-08-30, not imagined.
 * Measured over 12 identical calls to `sarvam-105b`: seven spoke, three returned
 * a well-formed 200 with no content at all, and two dropped the socket. None
 * returned 429 — which is what made the original retry policy, keyed on
 * `RateLimitError`, unreachable in practice.
 *
 * See docs/adr/0003-llm.md (addendum) and src/domain/think-filter.ts.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  EmptyCompletionError,
  RateLimitError,
  SarvamLlm,
  isRetryableTransport,
  type StreamChunk,
} from "../src/providers/sarvam-llm.ts";
import { ThinkFilter } from "../src/domain/think-filter.ts";
import { LLM_RETRY, withBackoff } from "../src/domain/backoff.ts";
import { testConfig } from "./helpers.ts";

/**
 * A REAL Config, not a hand-built stand-in.
 *
 * This was `{ sarvam: {...} } as unknown as Config`, and that cast is exactly
 * as dangerous as it looks: it turns off the checking that a config rename
 * depends on. When Config was nested, tsc reported this file clean while all
 * thirteen tests in it threw `Cannot read properties of undefined`. The suite
 * caught what the typechecker had been told to ignore.
 *
 * testConfig() starts from loadConfig() with the environment swapped out, so
 * the shape is the real one by construction and a rename breaks the build here
 * the way it breaks it everywhere else.
 */
const CFG = testConfig({
  sarvam: { apiBase: "https://sarvam.test", apiKey: "test-key", llmModel: "test-model" },
});

// --- SSE plumbing -----------------------------------------------------------

const content = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });
const reasoning = (text: string) =>
  JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] });
const finish = (reason: string) =>
  JSON.stringify({ choices: [{ finish_reason: reason, delta: {} }] });
const toolCall = (name: string, args: string) =>
  JSON.stringify({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] } },
    ],
  });

const realFetch = globalThis.fetch;

/** Serve one canned SSE stream to the next fetch. */
function serve(frames: string[]): void {
  const body = frames.map((f) => `data: ${f}\n`).join("");
  globalThis.fetch = async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

async function collect(
  frames: string[],
  onWarn?: (msg: string, extra: Record<string, unknown>) => void,
): Promise<StreamChunk[]> {
  serve(frames);
  const out: StreamChunk[] = [];
  for await (const chunk of new SarvamLlm(CFG).stream([{ role: "user", content: "hi" }], {
    ...(onWarn ? { onWarn } : {}),
  })) {
    out.push(chunk);
  }
  return out;
}

const spoken = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- Empty completions ------------------------------------------------------

describe("a completion that says nothing is a failure, not a quiet success", () => {
  it("throws when the stream closes without a single content delta", async () => {
    await assert.rejects(() => collect([finish("stop"), "[DONE]"]), EmptyCompletionError);
  });

  it("throws when the stream is truncated before [DONE]", async () => {
    // No terminator at all: the body just ends. Same accounting.
    await assert.rejects(() => collect([finish("stop")]), EmptyCompletionError);
  });

  it("names the token budget when reasoning consumed it", async () => {
    // sarvam-105b with max_tokens=700: 2,713 chars of reasoning, zero content,
    // finish_reason "length". A well-formed 200 that mutes the agent.
    await assert.rejects(
      () => collect([reasoning("thinking ".repeat(200)), finish("length"), "[DONE]"]),
      (err: unknown) => {
        assert.ok(err instanceof EmptyCompletionError);
        assert.equal(err.finishReason, "length");
        assert.ok(err.reasoningChars > 0);
        assert.match(err.message, /max_tokens counts reasoning tokens/);
        return true;
      },
    );
  });

  it("distinguishes load-shedding from a token cap", async () => {
    // finish_reason "stop" with no content is the load-shedding shape, and it
    // must not blame max_tokens — that would send the next reader the wrong way.
    await assert.rejects(
      () => collect([finish("stop"), "[DONE]"]),
      (err: unknown) => {
        assert.ok(err instanceof EmptyCompletionError);
        assert.equal(err.finishReason, "stop");
        assert.doesNotMatch(err.message, /max_tokens/);
        return true;
      },
    );
  });

  it("does NOT throw when the turn produced only tool calls", async () => {
    // A silent tool round is legitimate: the model acts, then speaks next round.
    const chunks = await collect([toolCall("get_time", "{}"), "[DONE]"]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.type, "tool_call");
  });

  it("does NOT throw when the model spoke, however briefly", async () => {
    const chunks = await collect([content("Hello."), finish("stop"), "[DONE]"]);
    assert.equal(spoken(chunks), "Hello.");
  });
});

// --- Reasoning must never be spoken -----------------------------------------

describe("reasoning stays out of the speech path", () => {
  it("never yields reasoning_content as text", async () => {
    const chunks = await collect([
      reasoning("The user wants a greeting. I should be warm but brief."),
      content("Hello there."),
      finish("stop"),
      "[DONE]",
    ]);
    assert.equal(spoken(chunks), "Hello there.");
  });

  it("warns once per stream, not once per frame", async () => {
    const warnings: string[] = [];
    await collect(
      [reasoning("a"), reasoning("b"), reasoning("c"), content("Hi."), finish("stop"), "[DONE]"],
      (msg) => warnings.push(msg),
    );
    assert.equal(warnings.filter((w) => w.includes("reasoning tokens")).length, 1);
  });

  it("strips a well-formed think span from content", async () => {
    const chunks = await collect([
      content("<think>I should check the time first.</think>Let me look."),
      finish("stop"),
      "[DONE]",
    ]);
    assert.equal(spoken(chunks), "Let me look.");
  });

  it("suppresses a bare closing tag and warns that reasoning was already spoken", async () => {
    // The observed shape: monologue, then </think>, then the real answer. We
    // cannot unsay the monologue — but the tag itself must not be pronounced.
    const warnings: string[] = [];
    const chunks = await collect(
      [content("Wait, I should be brief.</think>It is nine o'clock."), finish("stop"), "[DONE]"],
      (msg) => warnings.push(msg),
    );
    assert.doesNotMatch(spoken(chunks), /think/);
    assert.ok(warnings.some((w) => w.includes("reasoning reached the speech path")));
  });
});

// --- The filter itself ------------------------------------------------------

describe("ThinkFilter", () => {
  const run = (chunks: string[], events = {}): string => {
    const f = new ThinkFilter(events);
    return chunks.map((c) => f.push(c)).join("") + f.flush();
  };

  it("passes ordinary prose through untouched", () => {
    assert.equal(run(["It is ", "nine o'clock."]), "It is nine o'clock.");
  });

  it("holds back a tag split across deltas instead of speaking the halves", () => {
    // The reason this is stateful at all: a per-chunk regex speaks "</thi".
    assert.equal(run(["Before<", "think>hidden</th", "ink>After"]), "BeforeAfter");
  });

  it("holds a lone angle bracket only until the next delta disproves it", () => {
    assert.equal(run(["2 < 3 is true"]), "2 < 3 is true");
    assert.equal(run(["a <", "b"]), "a <b");
  });

  it("releases a trailing partial tag on flush", () => {
    // Stream ended mid-"<thi" — it was never a tag, so it is ordinary text.
    assert.equal(run(["done <thi"]), "done <thi");
  });

  it("drops an unterminated think span rather than speaking it", () => {
    // An opener with no closer means it was still thinking when the stream died.
    assert.equal(run(["Fine.<think>now let me reconsider everything"]), "Fine.");
  });

  it("handles several spans in one stream", () => {
    assert.equal(run(["<think>a</think>One. <think>b</think>Two."]), "One. Two.");
  });

  it("reports a stray close exactly once per occurrence", () => {
    let strays = 0;
    run(["reasoning</think>answer"], { onStrayClose: () => strays++ });
    assert.equal(strays, 1);
  });
});

// --- What is worth retrying -------------------------------------------------

describe("transport failures that actually occur", () => {
  it("retries undici's dropped-socket shapes", () => {
    // Two of twelve loaded calls arrived exactly like this.
    const dropped = new TypeError("fetch failed");
    (dropped as { cause?: unknown }).cause = { code: "ECONNRESET" };
    assert.ok(isRetryableTransport(dropped));

    for (const code of ["UND_ERR_SOCKET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN"]) {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code };
      assert.ok(isRetryableTransport(err), code);
    }
  });

  it("retries a bare `fetch failed` with no cause to inspect", () => {
    assert.ok(isRetryableTransport(new TypeError("fetch failed")));
  });

  it("never retries an abort — the user interrupted", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    assert.equal(isRetryableTransport(abort), false);
  });

  it("does not retry a programming error or a 4xx", () => {
    assert.equal(isRetryableTransport(new Error("LLM request failed: 400 bad request")), false);
    assert.equal(isRetryableTransport(new TypeError("x.map is not a function")), false);
    assert.equal(isRetryableTransport("not an error"), false);
  });

  it("keeps rate limits and empty completions retryable, as the session asks", () => {
    // The session's predicate is the union of these three; this pins the two
    // that isRetryableTransport deliberately does not claim.
    assert.ok(new RateLimitError("429") instanceof RateLimitError);
    assert.ok(new EmptyCompletionError("stop", 0) instanceof EmptyCompletionError);
    assert.equal(isRetryableTransport(new EmptyCompletionError("stop", 0)), false);
  });
});

// --- The retry, wired as the session wires it -------------------------------

describe("an empty completion reaches the failure path instead of the ledger", () => {
  /**
   * `Session` constructs its own `SarvamLlm` (session.ts:228), so there is no
   * seam to drive a whole turn from here. What this pins is the mechanism the
   * fix rests on: the same predicate the session passes to `withBackoff`, over
   * the same policy, against the failure that was previously invisible.
   *
   * Before the fix an empty stream was not an error at all — it returned
   * cleanly, the orchestrator scored the turn as healthy, reset the failure
   * counter and filed a recovery, and the user heard nothing. What matters is
   * that it now THROWS, because throwing is what routes it to `#onTurnFailed`.
   */
  const sessionPredicate = (err: unknown) =>
    err instanceof RateLimitError ||
    err instanceof EmptyCompletionError ||
    isRetryableTransport(err);

  it("is retried, and surfaces as an error once the budget is spent", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        withBackoff(
          async () => {
            attempts++;
            serve([finish("stop"), "[DONE]"]);
            const it = new SarvamLlm(CFG).stream([{ role: "user", content: "hi" }]);
            return await it.next();
          },
          {
            policy: LLM_RETRY,
            retryable: sessionPredicate,
            sleep: async () => {},
            rand: () => 0.5,
          },
        ),
      EmptyCompletionError,
    );
    assert.equal(attempts, LLM_RETRY.maxAttempts, "should have used the full retry budget");
  });

  it("stops retrying as soon as the model actually speaks", async () => {
    let attempts = 0;
    const opened = await withBackoff(
      async () => {
        attempts++;
        serve(attempts === 1 ? [finish("stop"), "[DONE]"] : [content("Hello."), "[DONE]"]);
        const it = new SarvamLlm(CFG).stream([{ role: "user", content: "hi" }]);
        return await it.next();
      },
      { policy: LLM_RETRY, retryable: sessionPredicate, sleep: async () => {}, rand: () => 0.5 },
    );
    assert.equal(attempts, 2);
    assert.equal((opened.value as { text: string }).text, "Hello.");
  });

  it("abandons a SLOW empty completion rather than retrying into more silence", async () => {
    // The budget counts elapsed time, not sleep time (backoff.ts). An empty
    // completion that took 20 s — as they did on sarvam-105b — has already spent
    // the user's patience, so the honest move is to stop and speak.
    let attempts = 0;
    let clock = 0;
    await assert.rejects(
      () =>
        withBackoff(
          async () => {
            attempts++;
            clock += 20_000;
            serve([finish("stop"), "[DONE]"]);
            const it = new SarvamLlm(CFG).stream([{ role: "user", content: "hi" }]);
            return await it.next();
          },
          {
            policy: LLM_RETRY,
            retryable: sessionPredicate,
            sleep: async () => {},
            rand: () => 0.5,
            now: () => clock,
          },
        ),
      EmptyCompletionError,
    );
    assert.equal(attempts, 1, "a 20s failure must not be retried");
  });
});
