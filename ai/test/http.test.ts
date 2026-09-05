/**
 * The two bounds every outbound request now carries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A TIMEOUT HAD TO EXIST AT ALL. `fetch` has none. A host that accepts the
 * connection and then says nothing hangs until the socket dies, which on a
 * mobile link is minutes — and the caching work removed the one bound these
 * calls used to have, the turn's abort signal, because a load one conversation
 * starts is now awaited by others and must not die when the first person hangs
 * up. So the bound moved from the turn onto the request.
 *
 * WHY THE RETRY IS GATED ON THE METHOD. Retrying a GET is free. Retrying the
 * POST that stores somebody's blood pressure is a second row in their health
 * record. The gate is the method rather than the caller's diligence, because
 * the caller who forgets is the one adding a new POST in six months.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIMEOUT_MS,
  getJson,
  getText,
  UpstreamError,
  type HttpFetch,
} from "@sp-i/shared/providers/http.ts";

/** A fetcher scripted per attempt, recording the init it was handed. */
function scripted(
  answers: Array<{ status?: number; body?: string; throws?: Error }>,
): HttpFetch & { calls: Array<Parameters<HttpFetch>[1]> } {
  const calls: Array<Parameters<HttpFetch>[1]> = [];
  const fn = (async (_url: string, init?: Parameters<HttpFetch>[1]) => {
    calls.push(init);
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (next.throws) throw next.throws;
    const status = next.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => next.body ?? "" };
  }) as HttpFetch & { calls: Array<Parameters<HttpFetch>[1]> };
  fn.calls = calls;
  return fn;
}

describe("the timeout", () => {
  it("attaches one even when the caller passes no signal", async () => {
    const fetch = scripted([{ body: "ok" }]);
    await getText(fetch, "https://x.test", "thing");
    assert.ok(fetch.calls[0]?.signal, "no signal reached the fetcher");
  });

  it("keeps the caller's signal alongside it", async () => {
    // A barge-in and a timeout are different reasons to stop and both have to
    // be able to fire, so the caller's signal is combined rather than replaced.
    const controller = new AbortController();
    const fetch = scripted([{ body: "ok" }]);
    await getText(fetch, "https://x.test", "thing", { signal: controller.signal });

    const passed = fetch.calls[0]!.signal!;
    assert.equal(passed.aborted, false);
    controller.abort();
    assert.equal(passed.aborted, true, "aborting the caller's signal did not reach the request");
  });

  it("names the service and the bound it crossed", async () => {
    // Left alone this is "The operation was aborted due to timeout", which
    // tells an operator nothing about which of four upstreams stalled.
    const fetch: HttpFetch = async (_url, init) => {
      await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve));
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    };

    await assert.rejects(
      () => getText(fetch, "https://x.test", "news feed", { timeoutMs: 5 }),
      /news feed did not respond within 5ms/,
    );
  });

  it("does not report a caller's own abort as a timeout", async () => {
    // A barge-in is not an upstream problem, and logging it as one would put
    // "the news feed timed out" in the log every time somebody interrupted.
    const controller = new AbortController();
    const fetch: HttpFetch = async (_url, init) => {
      await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve));
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const pending = getText(fetch, "https://x.test", "news feed", {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(() => pending, /aborted/);
    await assert.rejects(
      () => pending,
      (err: Error) => !/did not respond/.test(err.message),
    );
  });

  it("can be turned off", async () => {
    const fetch = scripted([{ body: "ok" }]);
    await getText(fetch, "https://x.test", "thing", { timeoutMs: 0 });
    assert.equal(fetch.calls[0]?.signal, undefined);
  });

  it("is longer than the tool deadline, on purpose", () => {
    // Two different bounds. NETWORK_MS (6s) is how long a person waits before
    // being told something went wrong; this is how long a socket may stay open.
    // A request that outlives its turn still fills the cache for the next
    // caller, so it is better finished than killed a moment early.
    assert.ok(DEFAULT_TIMEOUT_MS > 6000);
  });
});

describe("retrying an idempotent GET", () => {
  it("tries again after a 503 and returns the second answer", async () => {
    const fetch = scripted([{ status: 503 }, { status: 200, body: "second time" }]);
    assert.equal(await getText(fetch, "https://x.test", "feed"), "second time");
    assert.equal(fetch.calls.length, 2);
  });

  it("tries again after a dropped connection", async () => {
    // A TypeError is what `fetch` throws for DNS failure, a refused connection
    // and a dropped socket — the case this retry actually exists for.
    const fetch = scripted([{ throws: new TypeError("fetch failed") }, { body: "recovered" }]);
    assert.equal(await getText(fetch, "https://x.test", "feed"), "recovered");
  });

  it("tries again after a 429", async () => {
    const fetch = scripted([{ status: 429 }, { body: "ok" }]);
    assert.equal(await getText(fetch, "https://x.test", "feed"), "ok");
  });

  it("does not retry a 4xx", async () => {
    // Ours, not theirs: a malformed query or a revoked key. The second attempt
    // fails identically and the log then says "gave up after 2", which hides
    // the actual problem behind a retry count.
    const fetch = scripted([{ status: 404 }]);
    await assert.rejects(() => getText(fetch, "https://x.test", "feed"), /HTTP 404/);
    assert.equal(fetch.calls.length, 1);
  });

  it("does not retry a timeout", async () => {
    // It has already spent eight seconds against a six-second tool deadline. A
    // second attempt cannot finish in time to be spoken.
    const fetch: HttpFetch = async (_url, init) => {
      await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve));
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    };
    let calls = 0;
    const counted: HttpFetch = (url, init) => {
      calls++;
      return fetch(url, init);
    };

    await assert.rejects(() => getText(counted, "https://x.test", "feed", { timeoutMs: 5 }));
    assert.equal(calls, 1);
  });

  it("NEVER retries a POST, whatever the caller asked for", async () => {
    // THE ASSERTION THAT MATTERS IN THIS FILE. One telemetry reading must not
    // become two rows in somebody's health record because a load balancer
    // closed a connection after accepting the write.
    const fetch = scripted([{ status: 503 }, { body: "never reached" }]);
    await assert.rejects(
      () => getText(fetch, "https://x.test", "vitals", { method: "POST", body: "{}", retry: true }),
      /HTTP 503/,
    );
    assert.equal(fetch.calls.length, 1);
  });

  it("can be turned off for a GET", async () => {
    const fetch = scripted([{ status: 503 }]);
    await assert.rejects(() => getText(fetch, "https://x.test", "feed", { retry: false }));
    assert.equal(fetch.calls.length, 1);
  });

  it("gives up and reports the last failure", async () => {
    const fetch = scripted([{ status: 502 }]);
    await assert.rejects(() => getText(fetch, "https://x.test", "feed"), /feed returned HTTP 502/);
    assert.equal(fetch.calls.length, 2);
  });

  it("carries the status, so the policy can read it rather than parse a string", async () => {
    const fetch = scripted([{ status: 404 }]);
    await assert.rejects(
      () => getText(fetch, "https://x.test", "feed"),
      (err: unknown) => err instanceof UpstreamError && err.status === 404,
    );
  });
});

describe("getJson", () => {
  it("retries and parses the attempt that worked", async () => {
    const fetch = scripted([{ status: 503 }, { body: JSON.stringify({ ok: true }) }]);
    assert.deepEqual(await getJson(fetch, "https://x.test", "api"), { ok: true });
  });

  it("still names the service when a 200 is not JSON", async () => {
    // A captive portal or a rate-limit interstitial answers 200 with HTML. It
    // is not retryable and the message has to say who did it.
    const fetch = scripted([{ body: "<html>gateway</html>" }]);
    await assert.rejects(
      () => getJson(fetch, "https://x.test", "geocoding"),
      /geocoding returned unparseable JSON/,
    );
    assert.equal(fetch.calls.length, 1);
  });
});
