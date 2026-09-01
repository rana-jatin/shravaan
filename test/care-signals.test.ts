/**
 * Care signals — ADR 0009.
 *
 * THE TESTS THAT MATTER MOST HERE ARE THE REFUSALS. An English-only analyser
 * handed a Hindi transcript returns a number, and the number is about nothing —
 * so "we did not call Deepgram at all" is the assertion with teeth, and it is
 * checked by counting calls rather than by inspecting a result.
 *
 * The second theme is absent-means-absent. A missing score must stay missing all
 * the way to the episode: a fabricated 0.0 is indistinguishable from a genuinely
 * neutral week, and the trend is the whole feature.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CARE_INTENTS,
  analysable,
  countWords,
  isEnglishOnly,
  mapIntents,
  moodTrend,
  toCareSignals,
  userTranscript,
} from "../src/domain/care-signals.ts";
import {
  createCareSignalsAnalyser,
  type SignalsAnalyser,
} from "../src/memory/care-signals-analyser.ts";
import { InMemoryLongTermStore } from "../src/memory/in-memory-long-term-store.ts";
import { HashingEmbedder } from "../src/memory/long-term-store.ts";
import { InMemoryMemWriteStream } from "../src/memory/stream.ts";
import { MemoryWorker } from "../src/memory/worker.ts";
import { MemorySessionStore } from "../src/store/memory-store.ts";
import { DeepgramRead, DeepgramReadError } from "../src/providers/deepgram-read.ts";
import type { ReadRequest, TextAnalyser } from "../src/providers/deepgram-read.ts";
import type { Config } from "../src/config/env.ts";
import type { HttpFetch } from "../src/providers/http.ts";
import type { Episode, MemWriteEvent } from "../src/domain/types.ts";
import { createRecallMood } from "../src/tools/wellbeing.ts";
import { fakeHost, invocation } from "./helpers.ts";

// --- fixtures ----------------------------------------------------------------

const event = (over: Partial<MemWriteEvent> = {}): MemWriteEvent => ({
  event_id: "e1",
  sid: "s1",
  uid: "u1",
  tid: 1,
  at: "2026-08-31T10:00:00Z",
  kind: "turn_completed",
  ...over,
});

/** 60 words, comfortably over MIN_WORDS. */
const longEnough = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

const episode = (over: Partial<Episode> = {}): Episode => ({
  id: "ep1",
  uid: "u1",
  sid: "s1",
  started_at: "2026-08-30T10:00:00Z",
  ended_at: "2026-08-30T10:20:00Z",
  turn_count: 12,
  languages: ["en-IN"],
  summary: "",
  topics: [],
  open_threads: [],
  fact_ids: [],
  ...over,
});

/** A response in the documented shape. */
const deepgramBody = {
  metadata: { request_id: "r1" },
  results: {
    sentiments: {
      segments: [
        { text: "I have not been sleeping.", sentiment: "negative", sentiment_score: -0.62 },
        { text: "The garden is nice though.", sentiment: "positive", sentiment_score: 0.51 },
      ],
      average: { sentiment: "negative", sentiment_score: -0.4123 },
    },
    intents: {
      segments: [
        {
          text: "I have not been sleeping.",
          intents: [{ intent: "reports not sleeping", confidence_score: 0.81 }],
        },
        {
          text: "I have not been sleeping at all really.",
          intents: [
            { intent: "reports not sleeping", confidence_score: 0.44 },
            { intent: "expresses loneliness", confidence_score: 0.66 },
          ],
        },
      ],
    },
  },
};

// --- the gate ----------------------------------------------------------------

describe("care signals: the language gate", () => {
  it("accepts English in any region form", () => {
    assert.equal(isEnglishOnly(["en-IN"]), true);
    assert.equal(isEnglishOnly(["en-IN", "en-US", "en"]), true);
  });

  it("refuses a code-mixed session outright, not by majority", () => {
    // Hinglish is first-class in this product. Half a transcript in Devanagari
    // scored by an English model is the confident-wrong-answer case.
    assert.equal(isEnglishOnly(["en-IN", "hi-IN"]), false);
    assert.equal(isEnglishOnly(["hi-IN"]), false);
  });

  it("refuses a session with no observed language at all", () => {
    assert.equal(isEnglishOnly([]), false);
  });

  it("reports why it refused, so the log can tell a skip from a failure", () => {
    assert.deepEqual(analysable(["hi-IN"], longEnough), { ok: false, reason: "not_english" });
    assert.deepEqual(analysable(["en-IN"], "too short"), { ok: false, reason: "too_short" });
    assert.deepEqual(analysable(["en-IN"], "   "), { ok: false, reason: "empty" });
    assert.equal(analysable(["en-IN"], longEnough).ok, true);
  });

  it("counts words the way the floor assumes", () => {
    assert.equal(countWords("  one   two\nthree "), 3);
    assert.equal(countWords(""), 0);
  });
});

describe("care signals: the transcript", () => {
  it("sends the user's words and never the companion's", () => {
    const text = userTranscript([
      event({ user_text: "I slept badly", agent_text: "That sounds hard, I'm sorry." }),
      event({ agent_text: "What a lovely day it is!" }),
    ]);
    // The companion is written to be warm; averaging its lines in would drag
    // every session upward and hide the weeks this exists to notice.
    assert.equal(text, "I slept badly");
  });

  it("keeps the END when it has to truncate", () => {
    const text = userTranscript(
      [event({ user_text: "old news" }), event({ user_text: "recent" })],
      6,
    );
    assert.equal(text, "recent");
  });
});

// --- mapping -----------------------------------------------------------------

describe("care signals: mapping Deepgram's response", () => {
  const opts = { intentConfidence: 0.5, analysedAt: "2026-08-31T11:00:00Z" };

  it("carries the average, the segment series and the flagged intents", () => {
    const signals = toCareSignals(deepgramBody, opts);
    assert.ok(signals);
    assert.deepEqual(signals.sentiment, { label: "negative", score: -0.41 });
    assert.deepEqual(signals.sentiment_segments, [-0.62, 0.51]);
    assert.equal(signals.provider, "deepgram");
    assert.equal(signals.analysed_at, "2026-08-31T11:00:00Z");
  });

  it("uses Deepgram's own banding, not a guess at one", () => {
    // ±0.333333333 is their break point. 0.33 is still neutral.
    const near = toCareSignals(
      { results: { sentiments: { average: { sentiment_score: 0.33 } } } },
      opts,
    );
    assert.equal(near?.sentiment?.label, "neutral");
    const over = toCareSignals(
      { results: { sentiments: { average: { sentiment_score: 0.34 } } } },
      opts,
    );
    assert.equal(over?.sentiment?.label, "positive");
  });

  it("returns null rather than an empty shell when there is nothing usable", () => {
    // The distinction that matters downstream: "analysed, found nothing" must
    // not be storable as a signal at all, or it becomes indistinguishable from
    // "never analysed".
    assert.equal(toCareSignals({}, opts), null);
    assert.equal(toCareSignals(null, opts), null);
    assert.equal(toCareSignals("not json at all", opts), null);
    assert.equal(toCareSignals({ results: { sentiments: { segments: [] } } }, opts), null);
  });

  it("never invents a score for a field the provider omitted", () => {
    const signals = toCareSignals(
      {
        results: {
          sentiments: { average: {} },
          intents: {
            segments: [
              { text: "ow", intents: [{ intent: "reports pain", confidence_score: 0.9 }] },
            ],
          },
        },
      },
      opts,
    );
    assert.ok(signals);
    assert.equal(signals.sentiment, undefined);
    assert.equal(signals.sentiment_segments, undefined);
    assert.equal(signals.flagged_intents?.length, 1);
  });

  it("treats NaN and Infinity as missing, not as numbers", () => {
    const nan = toCareSignals(
      { results: { sentiments: { average: { sentiment_score: NaN } } } },
      opts,
    );
    assert.equal(nan, null);
  });
});

describe("care signals: intents", () => {
  it("keeps the strongest hit per intent, not one row per occurrence", () => {
    const flagged = mapIntents(deepgramBody.results.intents.segments, 0.5);
    assert.deepEqual(
      flagged.map((f) => [f.intent, f.confidence]),
      [
        ["reports not sleeping", 0.81],
        ["expresses loneliness", 0.66],
      ],
    );
  });

  it("drops anything under the floor", () => {
    assert.equal(mapIntents(deepgramBody.results.intents.segments, 0.9).length, 0);
  });

  it("truncates the quoted span so an episode does not become a transcript", () => {
    const long = "x".repeat(400);
    const [hit] = mapIntents(
      [{ text: long, intents: [{ intent: "reports pain", confidence_score: 0.9 }] }],
      0.5,
    );
    assert.equal(hit!.text.length, 160);
    assert.ok(hit!.text.endsWith("..."));
  });

  it("survives a response shaped nothing like the documented one", () => {
    assert.deepEqual(mapIntents([null, 42, { intents: "nope" }, { intents: [{}] }], 0.5), []);
  });
});

// --- the trend ---------------------------------------------------------------

const withScore = (score: number, flagged: string[] = []): Episode =>
  episode({
    signals: {
      provider: "deepgram",
      analysed_at: "2026-08-31T11:00:00Z",
      sentiment: { label: "neutral", score },
      ...(flagged.length > 0
        ? { flagged_intents: flagged.map((intent) => ({ intent, confidence: 0.7, text: "" })) }
        : {}),
    },
  });

describe("care signals: reading the trend back", () => {
  it("is null when nothing has been analysed", () => {
    assert.equal(moodTrend([]), null);
    assert.equal(moodTrend([episode(), episode()]), null);
  });

  it("counts only analysed sessions, so a Hindi week is not padded with neutrals", () => {
    // Ten sessions, one of them English. The honest answer is "one", and the
    // tool tells the model to say so.
    const eps = [withScore(-0.5), ...Array.from({ length: 9 }, () => episode())];
    const trend = moodTrend(eps);
    assert.equal(trend?.sessions, 1);
    assert.equal(trend?.average, -0.5);
    assert.equal(trend?.label, "negative");
  });

  it("will not call a direction on too few sessions", () => {
    assert.equal(
      moodTrend([withScore(0.8), withScore(-0.8), withScore(-0.8)])?.direction,
      "unknown",
    );
  });

  it("reads the recent half against the earlier half — episodes arrive newest first", () => {
    const lower = moodTrend([withScore(-0.6), withScore(-0.5), withScore(0.5), withScore(0.6)]);
    assert.equal(lower?.direction, "lower");

    const brighter = moodTrend([withScore(0.6), withScore(0.5), withScore(-0.5), withScore(-0.6)]);
    assert.equal(brighter?.direction, "brighter");
  });

  it("holds its tongue about a wobble inside the band", () => {
    // Scores move for reasons that have nothing to do with how someone is.
    // Announcing every dip reads as anxious rather than attentive.
    const trend = moodTrend([withScore(0.2), withScore(0.15), withScore(0.1), withScore(0.15)]);
    assert.equal(trend?.direction, "steady");
  });

  it("gathers distinct flagged intents across the window", () => {
    const trend = moodTrend([
      withScore(-0.4, ["reports pain", "asks for help"]),
      withScore(-0.2, ["reports pain"]),
    ]);
    assert.deepEqual(trend?.flagged, ["reports pain", "asks for help"]);
  });
});

// --- the analyser: what does and does not reach the network ------------------

/** Counts calls, so "we never called Deepgram" is assertable. */
function spyAnalyser(impl: (req: ReadRequest) => Promise<unknown>) {
  const calls: ReadRequest[] = [];
  const analyser: TextAnalyser = {
    analyse: (req) => {
      calls.push(req);
      return impl(req);
    },
  };
  return { analyser, calls };
}

describe("care signals analyser: the refusals never reach the network", () => {
  const opts = { deadlineMs: 100, intentConfidence: 0.5 };

  it("does not call the provider for a non-English session", async () => {
    const { analyser, calls } = spyAnalyser(async () => deepgramBody);
    const run = createCareSignalsAnalyser(analyser, opts);

    const out = await run({
      events: [event({ user_text: longEnough })],
      languages: ["hi-IN"],
    });

    assert.equal(out, null);
    assert.equal(calls.length, 0);
  });

  it("does not call the provider for a session too short to read", async () => {
    const { analyser, calls } = spyAnalyser(async () => deepgramBody);
    const run = createCareSignalsAnalyser(analyser, opts);

    const out = await run({ events: [event({ user_text: "hello" })], languages: ["en-IN"] });

    assert.equal(out, null);
    assert.equal(calls.length, 0);
  });

  it("sends the reviewed watch-list in strict mode, and asks for both features", async () => {
    const { analyser, calls } = spyAnalyser(async () => deepgramBody);
    const run = createCareSignalsAnalyser(analyser, opts);

    await run({ events: [event({ user_text: longEnough })], languages: ["en-IN"] });

    assert.equal(calls.length, 1);
    const [req] = calls;
    assert.equal(req!.sentiment, true);
    assert.equal(req!.intents, true);
    assert.equal(req!.customIntentMode, "strict");
    assert.deepEqual(req!.customIntents, [...CARE_INTENTS]);
    assert.equal(req!.text, longEnough);
  });

  it("resolves to null when the provider fails, rather than throwing at the worker", async () => {
    const { analyser } = spyAnalyser(async () => {
      throw new DeepgramReadError(429, "rate limited");
    });
    const run = createCareSignalsAnalyser(analyser, opts);

    const out = await run({ events: [event({ user_text: longEnough })], languages: ["en-IN"] });
    assert.equal(out, null);
  });

  it("gives up at the deadline instead of holding the worker open", async () => {
    const { analyser } = spyAnalyser(
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const run = createCareSignalsAnalyser(analyser, { ...opts, deadlineMs: 20 });

    const out = await run({ events: [event({ user_text: longEnough })], languages: ["en-IN"] });
    assert.equal(out, null);
  });
});

// --- the provider ------------------------------------------------------------

/** Config without touching the developer's environment. See testConfig in helpers. */
const cfg = (over: Partial<Config> = {}): Config =>
  ({
    deepgramApiKey: "dg-test-key",
    deepgramReadBase: "https://api.deepgram.com",
    ...over,
  }) as unknown as Config;

function recordingFetch(res: { ok?: boolean; status?: number; body?: string }) {
  const seen: Array<{ url: string; init: NonNullable<Parameters<HttpFetch>[1]> }> = [];
  const fetcher: HttpFetch = async (url, init) => {
    seen.push({ url, init: init ?? {} });
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      text: async () => res.body ?? JSON.stringify(deepgramBody),
    };
  };
  return { fetcher, seen };
}

describe("deepgram /v1/read client", () => {
  it("posts the text and pins language=en", async () => {
    const { fetcher, seen } = recordingFetch({});
    await new DeepgramRead(cfg(), fetcher).analyse({ text: "hello there", sentiment: true });

    const url = new URL(seen[0]!.url);
    assert.equal(url.pathname, "/v1/read");
    // Not advisory: every feature on this endpoint is English-only, and the
    // parameter is what stops a silent wrong-language result.
    assert.equal(url.searchParams.get("language"), "en");
    assert.equal(url.searchParams.get("sentiment"), "true");
    assert.equal(seen[0]!.init["method"], "POST");
    assert.deepEqual(JSON.parse(String(seen[0]!.init["body"])), { text: "hello there" });
  });

  it("authenticates with Deepgram's Token scheme", async () => {
    const { fetcher, seen } = recordingFetch({});
    await new DeepgramRead(cfg(), fetcher).analyse({ text: "hello" });

    const headers = seen[0]!.init["headers"] as Record<string, string>;
    assert.equal(headers["Authorization"], "Token dg-test-key");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("repeats custom_intent once per intent rather than joining them", async () => {
    const { fetcher, seen } = recordingFetch({});
    await new DeepgramRead(cfg(), fetcher).analyse({
      text: "hello",
      intents: true,
      customIntents: ["reports pain", "asks for help"],
      customIntentMode: "strict",
    });

    const url = new URL(seen[0]!.url);
    assert.deepEqual(url.searchParams.getAll("custom_intent"), ["reports pain", "asks for help"]);
    assert.equal(url.searchParams.get("custom_intent_mode"), "strict");
  });

  it("caps custom intents at Deepgram's documented 100", async () => {
    const { fetcher, seen } = recordingFetch({});
    await new DeepgramRead(cfg(), fetcher).analyse({
      text: "hello",
      customIntents: Array.from({ length: 150 }, (_, i) => `intent ${i}`),
    });

    assert.equal(new URL(seen[0]!.url).searchParams.getAll("custom_intent").length, 100);
  });

  it("omits every feature flag that was not asked for", async () => {
    const { fetcher, seen } = recordingFetch({});
    await new DeepgramRead(cfg(), fetcher).analyse({ text: "hello" });

    const url = new URL(seen[0]!.url);
    assert.equal(url.searchParams.get("sentiment"), null);
    assert.equal(url.searchParams.get("intents"), null);
  });

  it("surfaces err_msg, because 'HTTP 400' does not say what was wrong", async () => {
    const { fetcher } = recordingFetch({
      ok: false,
      status: 400,
      body: JSON.stringify({ err_code: "Bad Request", err_msg: "unsupported language" }),
    });

    await assert.rejects(
      () => new DeepgramRead(cfg(), fetcher).analyse({ text: "hello" }),
      (err: unknown) => {
        assert.ok(err instanceof DeepgramReadError);
        assert.equal(err.status, 400);
        assert.match(err.message, /unsupported language/);
        return true;
      },
    );
  });

  it("does not pretend a proxy's HTML is JSON", async () => {
    const { fetcher } = recordingFetch({ body: "<html>502</html>" });
    await assert.rejects(
      () => new DeepgramRead(cfg(), fetcher).analyse({ text: "hello" }),
      /unparseable JSON/,
    );
  });

  it("refuses to call at all without a key", async () => {
    const { fetcher, seen } = recordingFetch({});
    await assert.rejects(
      () => new DeepgramRead(cfg({ deepgramApiKey: null }), fetcher).analyse({ text: "hi" }),
      /DEEPGRAM_API_KEY/,
    );
    assert.equal(seen.length, 0);
  });
});

// --- the worker --------------------------------------------------------------

describe("memory worker: signals ride on the episode, or the episode goes without", () => {
  const distiller = {
    distil: async () => ({
      facts: [],
      summary: "Talked about the garden.",
      topics: [],
      open_threads: [],
    }),
  };

  function makeWorker(signals?: SignalsAnalyser) {
    const stream = new InMemoryMemWriteStream();
    const longTerm = new InMemoryLongTermStore(new HashingEmbedder());
    const worker = new MemoryWorker({
      stream,
      longTerm,
      sessions: new MemorySessionStore(),
      distiller,
      ...(signals ? { signals } : {}),
      options: { blockMs: 0 },
    });
    return { stream, longTerm, worker };
  }

  const closing = [
    event({ event_id: "a", user_text: longEnough, language: "en-IN" }),
    event({ event_id: "b", kind: "session_closed", language: "en-IN", turn_count: 4 }),
  ];

  it("attaches what the analyser returned", async () => {
    const { stream, longTerm, worker } = makeWorker(async () => ({
      provider: "deepgram" as const,
      analysed_at: "2026-08-31T11:00:00Z",
      sentiment: { label: "negative" as const, score: -0.41 },
    }));

    for (const e of closing) await stream.append(e);
    await worker.runOnce();

    const [ep] = await longTerm.listEpisodes("u1", 5);
    assert.equal(ep?.signals?.sentiment?.score, -0.41);
    // The distiller's own read stays the primary one — it is available in all
    // eleven languages and this is not.
    assert.equal(ep?.summary, "Talked about the garden.");
  });

  it("writes the episode unchanged when there is no analyser at all", async () => {
    const { stream, longTerm, worker } = makeWorker();

    for (const e of closing) await stream.append(e);
    await worker.runOnce();

    const [ep] = await longTerm.listEpisodes("u1", 5);
    assert.ok(ep);
    assert.equal(ep.signals, undefined);
  });

  it("writes the episode when the analysis found nothing", async () => {
    // The common case: any non-English session, forever.
    const { stream, longTerm, worker } = makeWorker(async () => null);

    for (const e of closing) await stream.append(e);
    await worker.runOnce();

    const [ep] = await longTerm.listEpisodes("u1", 5);
    assert.ok(ep, "a failed analysis must never cost us the episode");
    assert.equal(ep.signals, undefined);
  });

  it("hands the analyser every language the session was in", async () => {
    let seen: readonly string[] = [];
    const { stream, longTerm, worker } = makeWorker(async ({ languages }) => {
      seen = languages;
      return null;
    });

    await stream.append(event({ event_id: "c", user_text: "hi there", language: "en-IN" }));
    await stream.append(event({ event_id: "d", user_text: "namaste", language: "hi-IN" }));
    await stream.append(event({ event_id: "e", kind: "session_closed", language: "hi-IN" }));
    await worker.runOnce();

    // Both, so the gate can refuse the code-mixed session rather than scoring
    // half of it.
    assert.deepEqual([...seen].sort(), ["en-IN", "hi-IN"]);
    assert.equal((await longTerm.listEpisodes("u1", 5)).length, 1);
  });
});

// --- the tool ----------------------------------------------------------------

describe("recall_mood", () => {
  const tool = createRecallMood();

  it("never leaves the process — it reads what the worker already wrote", async () => {
    let asked = 0;
    const host = fakeHost({
      recentMood: async (sessions) => {
        asked = sessions;
        return {
          sessions: 6,
          average: -0.4,
          label: "negative",
          direction: "lower",
          flagged: ["reports pain"],
        };
      },
    });

    const out = await tool.handler({}, invocation({ host }));

    assert.equal(asked, 14);
    assert.equal(out["analysed"], 6);
    assert.equal(out["direction"], "lower");
    assert.deepEqual(out["flagged"], ["reports pain"]);
  });

  it("treats 'nothing recorded' as data, not an error", async () => {
    // The normal state of a new device, and the permanent state of every
    // non-English deployment. An error here would cost eleven translations to
    // say something that is not a failure.
    const out = await tool.handler(
      {},
      invocation({ host: fakeHost({ recentMood: async () => null }) }),
    );
    assert.deepEqual(out, { analysed: 0, reason: "nothing_recorded" });
  });

  it("takes no arguments, so the model cannot ask for a window we did not size", () => {
    assert.deepEqual(tool.parameters.properties, {});
    assert.equal(tool.parameters.additionalProperties, false);
  });

  it("tells the model not to quote the numbers", () => {
    // The scores are a third party's read of English words. Speaking them aloud
    // to the person they are about is the failure this description prevents.
    assert.match(tool.description, /never quote the numbers/);
    assert.match(tool.description, /never diagnose/);
  });
});
