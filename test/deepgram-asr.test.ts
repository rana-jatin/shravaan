/**
 * Frame parsing for the Deepgram Flux standby.
 *
 * WHY THIS FILE EXISTS: until 2026-09-01 nothing in 566 tests ever handed
 * `DeepgramAsr` a frame. The client switched on `msg.type` looking for `Update`
 * and `EndOfTurn`, Flux actually sends `{"type":"TurnInfo","event":"Update"}`,
 * and so every transcript fell into the default arm and was discarded. The
 * socket opened, audio streamed, Deepgram billed, and the standby emitted
 * nothing — for anyone who ever needed it. See D11 in docs/07-defect-register.md.
 *
 * A unit test with invented frames could not have caught that, because the
 * invention would have repeated the same misreading of the docs. So THE FRAMES
 * BELOW ARE COPIED VERBATIM off a live socket (request_id
 * 01a059ba-1583-7360-917e-c766366a6787, flux-general-multi, 2026-09-01), only
 * trimmed in `words` length. Do not tidy them into what you expect them to say.
 *
 * The client is driven through a real local WebSocket rather than by reaching
 * past `connect()`, so the binary/JSON split and the auth header travel the same
 * path they do in production. `npm run verify:asr` is the live counterpart —
 * this file keeps the shape from regressing without a key.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { DeepgramAsr } from "../src/providers/deepgram-asr.ts";
import type { AsrTranscript } from "../src/providers/asr-client.ts";
import { testConfig } from "./helpers.ts";

const PORT = 18101;
const RID = "01a059ba-1583-7360-917e-c766366a6787";

/** Captured. `words` truncated to two entries; every other field is untouched. */
const CONNECTED = { type: "Connected", request_id: RID, sequence_id: 0 };

const START_OF_TURN = {
  type: "TurnInfo",
  request_id: RID,
  event: "StartOfTurn",
  turn_index: 0,
  audio_window_start: 0.0,
  audio_window_end: 0.24,
  transcript: "",
  words: [],
  languages: [],
  languages_hinted: ["en"],
  end_of_turn_confidence: 0.0038,
  sequence_id: 1,
};

const UPDATE = {
  type: "TurnInfo",
  request_id: RID,
  event: "Update",
  turn_index: 0,
  audio_window_start: 0.0,
  audio_window_end: 0.72,
  transcript: "I am losing my",
  words: [
    { word: "I am", confidence: 0.9985, start: 0.0, end: 0.08 },
    { word: "losing", confidence: 0.9995, start: 0.08, end: 0.48 },
  ],
  languages: ["en"],
  languages_hinted: ["en"],
  end_of_turn_confidence: 0.0023,
  sequence_id: 3,
};

const END_OF_TURN = {
  type: "TurnInfo",
  request_id: RID,
  event: "EndOfTurn",
  turn_index: 0,
  audio_window_start: 0.0,
  audio_window_end: 4.24,
  transcript: "I am losing my voice.",
  words: [
    { word: "I am", confidence: 0.999, start: 0.0, end: 0.08 },
    { word: "voice.", confidence: 1.0, start: 0.64, end: 0.88 },
  ],
  languages: ["en"],
  languages_hinted: ["en"],
  sequence_id: 20,
};

type Capture = {
  asr: DeepgramAsr;
  partials: AsrTranscript[];
  finals: AsrTranscript[];
  errors: Error[];
  events: string[];
  socket: WsSocket;
};

let wss: WebSocketServer;
/**
 * Resolves with the server-side socket AND the upgrade request for the next
 * client to connect. The request is how the auth header and query string are
 * asserted — `ws` hands both to the `connection` listener, so nothing here has
 * to reach into a private field to see what the client actually sent.
 */
let nextConn: Promise<{ socket: WsSocket; req: IncomingMessage }>;

function armNextSocket(): void {
  nextConn = once(wss, "connection").then(([s, r]) => ({
    socket: s as WsSocket,
    req: r as IncomingMessage,
  }));
}

/** Let the client's listeners run. Everything here is local and synchronous. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe("deepgram flux frame parsing", () => {
  before(async () => {
    wss = new WebSocketServer({ port: PORT });
    await once(wss, "listening");
  });

  after(async () => {
    // Terminate before close: `wss.close()` waits on live sockets, and one test
    // deliberately leaves a client open. Without this the file hangs at 100%
    // green, which is a worse failure than a red one.
    for (const c of wss.clients) c.terminate();
    wss.close();
    await once(wss, "close");
  });

  /** Connect a client and collect everything it emits. */
  async function connect(): Promise<Capture> {
    armNextSocket();
    const cfg = testConfig({
      deepgramApiKey: "test-key",
      deepgramWsBase: `ws://127.0.0.1:${PORT}`,
    });
    const asr = new DeepgramAsr(cfg, { languageHint: "en" });
    const cap: Capture = {
      asr,
      partials: [],
      finals: [],
      errors: [],
      events: [],
      socket: null as unknown as WsSocket,
    };
    asr.on("partial", (t) => {
      cap.partials.push(t);
      cap.events.push("partial");
    });
    asr.on("final", (t) => {
      cap.finals.push(t);
      cap.events.push("final");
    });
    asr.on("speech_start", () => cap.events.push("speech_start"));
    asr.on("speech_end", () => cap.events.push("speech_end"));
    asr.on("error", (e) => cap.errors.push(e));

    asr.connect();
    await once(asr, "open");
    cap.socket = (await nextConn).socket;
    return cap;
  }

  /** Push frames at the client and let its listeners run. */
  async function deliver(cap: Capture, ...frames: unknown[]): Promise<void> {
    for (const f of frames) cap.socket.send(JSON.stringify(f));
    await drain();
  }

  it("reads the nested TurnInfo discriminant, not the outer type", async () => {
    const cap = await connect();
    await deliver(cap, CONNECTED, START_OF_TURN, UPDATE, END_OF_TURN);

    // The regression itself. Every one of these frames carries type "TurnInfo";
    // dispatching on `type` yields an empty transcript stream and a green build.
    assert.deepEqual(cap.events, ["speech_start", "partial", "speech_end", "final"]);
    assert.equal(cap.finals[0]?.text, "I am losing my voice.");
    assert.equal(cap.partials[0]?.text, "I am losing my");
    assert.deepEqual(cap.errors, []);
    cap.asr.close();
  });

  it("averages word confidence — the field Sarvam cannot supply", async () => {
    const cap = await connect();
    await deliver(cap, UPDATE);

    // Mean of 0.9985 and 0.9995. The low-confidence reprompt (Q4) reads this and
    // nothing else, so an absent value silently disables the rule.
    assert.ok(cap.partials[0]?.confidence !== undefined, "confidence was dropped");
    assert.equal(cap.partials[0]!.confidence!.toFixed(4), "0.9990");
    cap.asr.close();
  });

  it("reads `languages` (plural, an array) — there is no singular field", async () => {
    const cap = await connect();
    await deliver(cap, UPDATE);
    assert.equal(cap.partials[0]?.language, "en");
    cap.asr.close();
  });

  it("carries word timings through", async () => {
    const cap = await connect();
    await deliver(cap, UPDATE);
    assert.equal(cap.partials[0]?.startS, 0.0);
    assert.equal(cap.partials[0]?.endS, 0.48);
    cap.asr.close();
  });

  it("leaves confidence absent rather than faking 1.0 when no words are scored", async () => {
    const cap = await connect();
    await deliver(cap, START_OF_TURN);
    // StartOfTurn has words: []. A defaulted 1.0 here would read as certainty.
    assert.deepEqual(cap.events, ["speech_start"]);
    assert.equal(cap.partials.length, 0);
    cap.asr.close();
  });

  it("treats EagerEndOfTurn as a partial and never as a dispatch", async () => {
    const cap = await connect();
    await deliver(
      cap,
      { ...UPDATE, event: "EagerEndOfTurn" },
      { ...UPDATE, event: "TurnResumed" },
    );
    // The eager guess is retractable. Acting on it would pay rate limit for a
    // turn that did not happen — on the path that is already degraded.
    assert.deepEqual(cap.events, ["partial"]);
    assert.equal(cap.finals.length, 0);
    cap.asr.close();
  });

  it("suppresses an empty final so a silent turn starts nothing", async () => {
    const cap = await connect();
    await deliver(cap, { ...END_OF_TURN, transcript: "   ", words: [] });
    assert.deepEqual(cap.events, ["speech_end"]);
    cap.asr.close();
  });

  it("surfaces an Error frame with its description", async () => {
    const cap = await connect();
    await deliver(cap, { type: "Error", description: "invalid sample_rate" });
    assert.equal(cap.errors.length, 1);
    assert.match(cap.errors[0]!.message, /invalid sample_rate/);
    cap.asr.close();
  });

  it("ignores unknown frames rather than crashing a degraded session", async () => {
    const cap = await connect();
    await deliver(cap, { type: "Metadata", whatever: true }, { type: "TurnInfo", event: "Invented" });
    assert.deepEqual(cap.errors, []);
    assert.deepEqual(cap.events, []);
    cap.asr.close();
  });

  it("reports a non-JSON frame instead of throwing", async () => {
    const cap = await connect();
    cap.socket.send("<html>502 Bad Gateway</html>");
    await drain();
    assert.equal(cap.errors.length, 1);
    assert.match(cap.errors[0]!.message, /non-JSON/);
    cap.asr.close();
  });

  it("sends the auth header, model and rate Flux needs to answer at all", async () => {
    armNextSocket();
    const cfg = testConfig({
      deepgramApiKey: "test-key",
      deepgramWsBase: `ws://127.0.0.1:${PORT}`,
    });
    const asr = new DeepgramAsr(cfg, { languageHint: "hi" });
    asr.connect();
    await once(asr, "open");
    const { req } = await nextConn;
    const url = new URL(req.url!, "ws://x");

    assert.equal(req.headers["authorization"], "Token test-key");
    assert.equal(url.searchParams.get("model"), cfg.deepgramModel);
    assert.equal(url.searchParams.get("encoding"), "linear16");
    assert.equal(url.searchParams.get("sample_rate"), String(cfg.asrSampleRate));
    assert.equal(url.searchParams.get("language_hint"), "hi");
    asr.close();
  });

  it("sends audio as binary and control as JSON", async () => {
    const cap = await connect();
    const seen: Array<{ binary: boolean; text: string }> = [];
    cap.socket.on("message", (data, isBinary) =>
      seen.push({ binary: isBinary, text: data.toString() }),
    );

    cap.asr.sendAudio(Buffer.alloc(320, 7));
    cap.asr.updateLanguage("hi-IN");
    cap.asr.flush();
    await drain();

    assert.equal(seen[0]?.binary, true, "PCM must not be wrapped in JSON the way Sarvam wraps it");
    assert.deepEqual(JSON.parse(seen[1]!.text), { type: "Configure", language_hint: "hi" });
    assert.deepEqual(JSON.parse(seen[2]!.text), { type: "ForceEndTurn" });
    cap.asr.close();
  });

  it("errors rather than opening a socket with no key", async () => {
    const cfg = testConfig({ deepgramApiKey: null, deepgramWsBase: `ws://127.0.0.1:${PORT}` });
    const asr = new DeepgramAsr(cfg, {});
    const errors: Error[] = [];
    asr.on("error", (e) => errors.push(e));
    asr.connect();
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /DEEPGRAM_API_KEY/);
  });
});
