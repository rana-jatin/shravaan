/**
 * The orchestrator, driven end to end against fakes.
 *
 * THE FIRST TESTS `Session` HAS EVER HAD. Until the provider seam landed
 * (`makeAsr` / `makeTts` / `makeLlm` on SessionDeps), constructing one opened
 * live WebSockets to Sarvam, so the turn loop, barge-in, the filler policy and
 * the echo-guard lifecycle were exercised only by hand — which is why four of
 * the eight entries in docs/07-defect-register.md live in this one file.
 *
 * ⚠ SOME ASSERTIONS HERE PIN BEHAVIOUR THAT IS KNOWN TO BE WRONG.
 *
 * They are marked `D2` / `D3` / `D4` after the defect register, and each one
 * states what SHOULD happen next to it. That is deliberate: characterising the
 * bug first means the fix arrives as a diff where the assertion flips, rather
 * than as a change nobody can see. Do not "fix" one of these assertions to match
 * new behaviour without also deleting the note and closing the defect.
 *
 * No network, no credentials, no real clocks on the retry path.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCopy } from "../src/copy/refusals.ts";
import { resolveFiller } from "../src/copy/fillers.ts";
import { resolveRespondIn } from "../src/domain/languages.ts";
import { SYSTEM_PROMPT } from "../src/orchestrator/session.ts";
import { RateLimitError } from "../src/providers/llm-client.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import {
  callsTool,
  makeSession,
  manualClock,
  says,
  settle,
  testConfig,
  waitFor,
} from "./helpers.ts";

/** Open a session and let `start()` finish. */
async function opened(over: Parameters<typeof makeSession>[0] = {}) {
  const h = makeSession(over);
  await h.session.start();
  return h;
}

describe("session — opening", () => {
  it("opens a voice and an ear", async () => {
    const h = await opened();

    assert.equal(h.ttss.length, 1);
    assert.equal(h.asrs.length, 1);
    assert.equal(h.tts().connects, 1);
    assert.equal(h.asr().connects, 1);
  });

  it("asks the default ASR to auto-detect rather than pinning the seed", async () => {
    const h = await opened();
    const spec = h.asr().spec;

    // The whole product is built on free per-turn language switching, which only
    // works while the socket is not pinned to one language.
    assert.ok(spec.provider === "sarvam");
    assert.equal(spec.opts.languageCode, "auto");
    assert.equal(spec.opts.mode, "codemix");
  });

  it("seeds the language from the locale hint over the configured default", async () => {
    const h = await opened({ localeHint: "ta-IN" });

    assert.equal(h.session.state.language, "ta-IN");
    assert.equal(h.session.state.language_source, "context");
    assert.equal(h.tts().opts.languageCode, "ta-IN");
  });

  it("prefers a remembered language over the locale hint", async () => {
    const h = await opened({
      localeHint: "ta-IN",
      profile: {
        uid: "u1",
        distilled_at: new Date().toISOString(),
        facts: [],
        open_threads: [],
        recent_episodes: [],
        preferred_language: "bn-IN",
      },
    });

    assert.equal(h.session.state.language, "bn-IN");
    assert.equal(h.session.state.language_source, "profile");
  });

  it("falls back to the configured seed when nothing is known", async () => {
    const h = await opened();

    assert.equal(h.session.state.language, "hi-IN");
    assert.equal(h.session.state.language_source, "default");
    assert.equal(h.session.resumed, false);
  });

  it("says nothing to the device until there is something to say", async () => {
    const h = await opened();

    assert.deepEqual(h.device.audio, []);
    assert.deepEqual(h.device.control, []);
  });
});

describe("session — gate 1", () => {
  it("refuses an unspeakable seed before any ear is opened", async () => {
    const h = await opened({ localeHint: "fr-FR" });

    // The point of gate 1: refusing here costs nothing and saves a socket
    // against a 20-connection ceiling.
    assert.equal(h.asrs.length, 0, "no ASR socket should be opened for a refusal");
    assert.equal(h.ttss.length, 1, "a voice is opened purely to apologise");
  });

  it("speaks the refusal rather than closing in silence", async () => {
    const h = await opened({ localeHint: "fr-FR" });

    // Nothing is known about this user, so the refusal is spoken in the head of
    // the configured ladder — which is guaranteed speakable at load.
    const spokenIn = resolveRespondIn({});
    assert.equal(h.tts().opts.languageCode, spokenIn);
    assert.deepEqual(h.tts().spoken, [resolveCopy("gate.unsupported_language", spokenIn).text]);
    assert.equal(h.tts().flushes, 1, "a refusal that is never flushed is silence");
  });
});

describe("session — a turn", () => {
  it("runs a transcript through the model and speaks the answer", async () => {
    const h = await opened();
    h.llm.script.push(says("Main theek hoon."));

    h.asr().final("Aap kaise ho?");
    await waitFor(() => h.tts().spoken.length > 0, "a reply");

    assert.deepEqual(h.tts().spoken, ["Main theek hoon."]);
    assert.equal(h.tts().flushes, 1);
  });

  it("opens the window with the shipped system prompt", async () => {
    const h = await opened();
    h.asr().final("Namaste");
    await waitFor(() => h.llm.rounds > 0, "an LLM call");

    const first = h.llm.calls[0]!.messages[0]!;
    assert.equal(first.role, "system");
    assert.ok(
      first.content.startsWith(SYSTEM_PROMPT),
      "the system message must lead with the prompt byte-identically, or Sarvam's cached-input tier never applies",
    );
  });

  it("records both halves of the exchange", async () => {
    const h = await opened();
    h.llm.script.push(says("Bahut achha."));

    h.asr().final("Sab theek hai.");
    await waitFor(() => h.session.turns.length >= 2, "both turns recorded");

    // Newest first, as stored.
    assert.equal(h.session.turns[0]!.role, "agent");
    assert.equal(h.session.turns[0]!.text, "Bahut achha.");
    assert.equal(h.session.turns[1]!.role, "user");
    assert.equal(h.session.turns[1]!.text, "Sab theek hai.");
    assert.equal(h.session.state.turn_no, 1);
  });

  it("ignores an empty final rather than spending a request on it", async () => {
    const h = await opened();

    h.asr().final("   ");
    await settle();

    assert.equal(h.llm.rounds, 0);
    assert.equal(h.session.state.turn_no, 0);
  });

  it("forwards device audio to the ear", async () => {
    const h = await opened();
    h.session.pushAudio(Buffer.alloc(320, 7));

    assert.equal(h.asr().sent.length, 1);
    assert.equal(h.asr().sent[0]!.length, 320);
  });
});

describe("session — the echo guard lifecycle", () => {
  it("arms suppression when sound leaves for the device, not when the model finishes", async () => {
    const h = await opened();
    h.llm.script.push(says("Ek minute."));

    h.asr().utterance("Suno");
    await waitFor(() => h.tts().spoken.length > 0, "a reply");

    // Text has been handed to Bulbul, but nothing has been heard yet.
    assert.deepEqual(h.device.audio, []);
    assert.equal(h.session.state.agent_speaking, true);

    h.tts().emitAudio();
    assert.equal(h.device.audio.length, 1, "audio must reach the device");
  });

  it("disarms when synthesis reports the utterance complete", async () => {
    const h = await opened();
    h.llm.script.push(says("Theek hai."));

    h.asr().utterance("Suno");
    await waitFor(() => h.tts().spoken.length > 0, "a reply");
    h.tts().emitAudio();
    h.tts().emitDone();

    assert.equal(h.session.state.agent_speaking, false);
    // Back to listening, not idle: the session is still very much open.
    assert.equal(h.session.phase, "listening");
  });
});

describe("session — barge-in", () => {
  /** Drive a reply to the point where the user cuts in between two clauses. */
  async function speaking() {
    const h = await opened();
    h.llm.script.push([
      { type: "text", text: "Pehli baat yeh hai. " },
      { type: "text", text: "Doosri baat yeh hai." },
    ]);

    h.llm.beforeChunk = (i) => {
      if (i !== 1) return;
      // Audio is already flowing by the time the interruption lands, which is
      // what arms the guard — a bare VAD trigger while silent is not a barge-in.
      h.tts().emitAudio();
      h.asr().partial("nahi nahi ruko");
    };

    h.asr().utterance("Batao");
    await waitFor(() => h.device.control.length > 0, "a barge-in");
    return h;
  }

  it("tells the device to drop what it is holding", async () => {
    const h = await speaking();

    assert.deepEqual(h.device.control, [{ type: "clear_audio" }]);
  });

  it("abandons the rest of the reply", async () => {
    const h = await speaking();
    await settle();

    assert.deepEqual(
      h.tts().spoken,
      ["Pehli baat yeh hai."],
      "the second clause was interrupted and must never be synthesised",
    );
  });

  it("records what the user actually heard, marked interrupted", async () => {
    const h = await speaking();
    await waitFor(() => h.session.turns.length >= 2, "the interrupted turn");

    const agent = h.session.turns[0]!;
    assert.equal(agent.role, "agent");
    assert.equal(agent.interrupted, true);
  });

  it("D2: audio from the abandoned turn still reaches the device", async () => {
    const h = await speaking();
    const before = h.device.audio.length;

    // Bulbul keeps synthesising text it was already handed, and there is no
    // documented cancel on that socket. Today every frame is forwarded
    // unconditionally, so the device clears its buffer and then receives the
    // tail of the sentence the user just interrupted.
    h.tts().emitAudio();

    assert.equal(
      h.device.audio.length,
      before + 1,
      "D2 is live: this assertion is the defect, not the intent",
    );
    assert.equal(h.tts().cleared, 0, "clearQueue() is still called from nowhere");

    // The stray frame also RE-ARMS the echo guard, which is the half that
    // actually costs the user something. The guard is private, so prove it from
    // the outside: with suppression re-armed against a now-EMPTY correlation
    // buffer, the next thing the user says is re-evaluated as a possible
    // interruption and commits a second barge-in.
    h.asr().partial("main keh raha tha");
    assert.equal(
      h.device.control.length,
      2,
      "a second clear_audio proves the abandoned tail put the guard back on",
    );

    // WHEN D2 IS FIXED: a turn epoch captured when the turn starts speaking and
    // compared on every frame. The frame is dropped, so the device count stays
    // put, the guard stays disarmed (one clear_audio, not two), and
    // #commitBargeIn calls clearQueue(). See docs/07-defect-register.md D2.
  });

  it("does not interrupt itself when its own voice comes back", async () => {
    const h = await opened();
    h.llm.script.push([
      { type: "text", text: "Aapki dawai saade aath baje hai. " },
      { type: "text", text: "Yaad rakhiyega." },
    ]);

    h.llm.beforeChunk = (i) => {
      if (i !== 1) return;
      h.tts().emitAudio();
      // Our own words, leaking back through an open-air mic. This is the signal
      // no energy-based method has access to.
      h.asr().partial("aapki dawai saade aath baje hai");
    };

    h.asr().utterance("Dawai kab hai?");
    await waitFor(() => h.tts().flushes > 0, "the full reply");

    assert.deepEqual(h.device.control, [], "self-echo must never clear playback");
    assert.equal(h.tts().spoken.length, 2, "the reply must run to completion");
  });
});

describe("session — tools", () => {
  /** A registry with one deliberately slow tool. */
  function slowRegistry(calls: string[] = []) {
    return new ToolRegistry().register({
      name: "look_up",
      description: "Look something up",
      parameters: { type: "object", properties: {} },
      filler_threshold_ms: 0,
      handler: async () => {
        calls.push("look_up");
        await new Promise((r) => setTimeout(r, 5));
        return { found: true };
      },
    });
  }

  it("runs the call, feeds the result back, and speaks the answer", async () => {
    const called: string[] = [];
    const h = await opened({ tools: slowRegistry(called) });
    h.llm.script.push(callsTool("look_up"), says("Mil gaya."));

    h.asr().final("Dekho zara");
    await waitFor(() => h.tts().spoken.includes("Mil gaya."), "the answer");

    assert.deepEqual(called, ["look_up"]);
    assert.equal(h.llm.rounds, 2, "one round to call, one to answer");

    // The result must come back as a tool message or the model answers blind.
    const toolMsg = h.llm.calls[1]!.messages.at(-1)!;
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.content, JSON.stringify({ found: true }));
  });

  it("offers the tool schemas to the model", async () => {
    const h = await opened({ tools: slowRegistry() });
    h.llm.script.push(says("Haan ji."));

    h.asr().final("Suno");
    await waitFor(() => h.llm.rounds > 0, "an LLM call");

    const opts = h.llm.calls[0]!.opts;
    assert.equal(opts.tools?.length, 1);
    assert.equal(opts.tools?.[0]!.function.name, "look_up");
    assert.equal(opts.toolChoice, "auto");
  });

  it("fills the silence when the model makes us wait", async () => {
    const h = await opened();
    // Two failures, then an answer. Under manualClock the retry schedule is the
    // deterministic worst case — 250 ms, then 500 ms — and the filler is spoken
    // on the second, the first time cumulative silence crosses 600 ms.
    h.llm.script.push(
      new RateLimitError("429"),
      new RateLimitError("429"),
      says("Maaf kijiye, ab bataata hoon."),
    );

    h.asr().final("Kya haal hai?");
    await waitFor(() => h.tts().spoken.length >= 2, "filler then answer");

    assert.equal(h.tts().spoken[0], resolveFiller("hi-IN", 0));
    assert.equal(h.tts().spoken[1], "Maaf kijiye, ab bataata hoon.");
    assert.equal(h.clock.elapsed(), 750, "no wall-clock time was spent waiting");

    // Two retries went through the ledger, and the turn that worked cleared it —
    // recovery is as reportable as failure, or the ledger only ever grows.
    assert.equal(h.logs.filter((l) => l.msg === "llm retry").length, 2);
    assert.ok(h.logs.some((l) => l.msg === "recovered" && l.extra["key"] === "llm_retrying"));
    assert.deepEqual(h.session.degraded, []);
  });

  it("D3: a retry filler and a tool filler still stack", async () => {
    const h = await opened({ tools: slowRegistry() });
    h.llm.script.push(
      new RateLimitError("429"),
      new RateLimitError("429"),
      callsTool("look_up"),
      says("Ho gaya."),
    );

    h.asr().final("Dekho zara");
    await waitFor(() => h.tts().spoken.includes("Ho gaya."), "the answer");

    // The retry filler does not set #roundSpoke, and #roundSpoke is then
    // overwritten from the round's own text before tools run — so the tool
    // filler fires as though nothing had been said. The user hears "One
    // moment." followed by "Let me check.", which reads as a stutter rather
    // than as patience.
    assert.deepEqual(h.tts().spoken.slice(0, 2), [
      resolveFiller("hi-IN", 0),
      resolveFiller("hi-IN", 1),
    ]);
    assert.equal(h.tts().spoken.length, 3, "two fillers and the answer");

    // WHEN D3 IS FIXED: track "anything already spoken this turn" as its own
    // flag that the retry filler also sets, and OR it in rather than assigning.
    // This becomes one filler followed by "Ho gaya."
  });
});

describe("session — ASR failover", () => {
  /** Failover configured, and a language the standby actually covers. */
  function failoverConfig() {
    return testConfig({
      asrFailover: { enabled: true },
      deepgram: { apiKey: "dg-test-key" },
      echoGuard: {
        suppressionWindowMs: 0,
        requireTranscript: true,
        selfEchoThreshold: 0.6,
        halfDuplex: false,
      },
    });
  }

  /**
   * The reopen between two drops is a real timer, so its jitter is real waiting.
   * `rand: 0` collapses full jitter to zero delay — the ladder's ORDER is what
   * these tests are about, and how long it waits is pinned in asr-reopen.test.ts.
   */
  function failoverSession(over: Parameters<typeof makeSession>[0] = {}) {
    return opened({ cfg: failoverConfig(), clock: manualClock(() => 0), ...over });
  }

  it("reconnects once before relocating a user's audio out of the country", async () => {
    const h = await failoverSession();

    h.asr().dropSocket(4000);
    await waitFor(() => h.asrs.length === 2, "the reopen");

    // One transient close is a network blip, not a compliance decision: a
    // failover moves a user's voice out of India, because Deepgram publishes no
    // India region. We try Sarvam again first.
    assert.equal(h.asr().provider, "sarvam");
    assert.equal(h.session.state.asr_provider, "sarvam");
    assert.equal(h.session.degraded.includes("asr_failover_active"), false);
  });

  it("moves to the standby once Sarvam will not come back", async () => {
    const h = await failoverSession();

    h.asr().dropSocket(4000);
    await waitFor(() => h.asrs.length === 2, "the reopen");
    h.asr().dropSocket(4000);
    await waitFor(() => h.asrs.length === 3, "the failover");

    const spec = h.asr().spec;
    assert.ok(spec.provider === "deepgram");
    assert.equal(spec.opts.languageHint, "hi", "Flux wants a bare primary subtag");
    assert.equal(h.session.state.asr_provider, "deepgram");
    assert.ok(h.session.degraded.includes("asr_failover_active"));
  });

  it("D4: a language switch never reaches the standby", async () => {
    const h = await failoverSession();
    h.llm.script.push(says("Sure."));

    h.asr().dropSocket(4000);
    await waitFor(() => h.asrs.length === 2, "the reopen");
    h.asr().dropSocket(4000);
    await waitFor(() => h.asrs.length === 3, "the failover");

    const standby = h.asr();
    assert.equal(standby.provider, "deepgram");

    // The user switches Hindi -> English. Both are speakable, so the session
    // follows them — and these two are the ONLY languages the standby covers,
    // so this is exactly the scenario it exists for.
    standby.final("What time is it?", "en-IN", 0.99);
    await waitFor(() => h.session.state.language === "en-IN", "the language switch");

    // The voice is told.
    assert.deepEqual(h.tts().reconfigures.at(-1), { languageCode: "en-IN" });

    // The ear is not, so Flux stays pinned to `hi` for the rest of the session.
    assert.deepEqual(standby.languageUpdates, [], "D4 is live: this is the defect");

    // WHEN D4 IS FIXED: #setLanguage calls updateLanguage("en") on the standby
    // ONLY — see the test below for the half that must not change.
  });

  it("leaves the Sarvam socket on auto when the language changes", async () => {
    const h = await opened();
    h.llm.script.push(says("Sure."));

    h.asr().final("What time is it?", "en-IN", 0.99);
    await waitFor(() => h.session.state.language === "en-IN", "the language switch");

    assert.deepEqual(
      h.asr().languageUpdates,
      [],
      "pinning the default provider would disable the per-turn switching the product is built on",
    );
  });
});

describe("session — losing a dependency", () => {
  it("announces the outage once, however many times it is reported", async () => {
    const h = await opened();

    h.tts().emitUnavailable(new Error("bulbul unreachable after 5 attempts"));
    await settle();
    assert.ok(h.session.degraded.includes("tts_unavailable"));

    // A Bulbul outage takes the TTS socket down, which drops the reply path,
    // which looks like a second failure. A naive implementation apologises
    // three times on the way out.
    const after = h.device.control.length;
    h.tts().emitUnavailable(new Error("again"));
    await settle();

    assert.equal(h.device.control.length, after, "the closing message is said once");
  });

  it("stops answering once it is on its way out", async () => {
    const h = await opened();
    h.tts().emitUnavailable();
    await settle();

    h.asr().final("Are you still there?");
    await settle();

    assert.equal(h.llm.rounds, 0, "answering here would talk over our own goodbye");
  });
});

describe("session — closing", () => {
  it("hangs up both sockets and tells the device why", async () => {
    const h = await opened();
    h.session.close("device_disconnected");

    assert.equal(h.asr().closes, 1);
    assert.equal(h.tts().closes, 1);
    assert.deepEqual(h.device.control.at(-1), {
      type: "session_closed",
      reason: "device_disconnected",
    });
    assert.equal(h.device.closed, "device_disconnected");
  });

  it("is idempotent", async () => {
    const h = await opened();
    h.session.close("first");
    h.session.close("second");

    assert.equal(h.tts().closes, 1);
    assert.equal(h.device.closed, "first");
  });

  it("writes the episode the memory worker summarises from", async () => {
    const written: Array<Record<string, unknown>> = [];
    const h = await opened({
      memStream: {
        append: async (e) => void written.push(e),
        read: async () => [],
        ack: async () => {},
        pendingCount: async () => 0,
        close: async () => {},
      },
    });

    h.session.close("done");
    await settle();

    const closed = written.find((e) => e["kind"] === "session_closed");
    assert.ok(closed, "a session is only summarisable once it has ended");
    assert.equal(closed["language"], "hi-IN");
  });
});

describe("session — the seam itself", () => {
  it("never touches the network", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("a test reached the network");
    };

    try {
      const h = await opened();
      h.llm.script.push(says("Theek hai."));
      h.asr().final("Namaste");
      await waitFor(() => h.tts().spoken.length > 0, "a reply");
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(calls, 0, "a fake that reaches the network is not a fake");
  });
});

describe("session — turn timing", () => {
  /**
   * The instrumentation is only useful if it fires on a real turn, and it fires
   * from the TTS `audio` handler — which FakeTts does not emit on its own,
   * because making it do so would start the echo-suppression window in every
   * other test in this file. So the audio is emitted here explicitly, which is
   * exactly what a real Bulbul socket does once speech has been sent.
   */
  async function turnWithAudio() {
    const h = await opened();
    h.llm.script.push(says("Main theek hoon."));

    h.asr().final("Aap kaise ho?");
    await waitFor(() => h.tts().spoken.length > 0, "a reply");
    h.tts().emit("audio", Buffer.alloc(320));
    await waitFor(() => h.logs.some((l) => l.msg === "turn timing"), "a timing line");

    return h.logs.find((l) => l.msg === "turn timing")!;
  }

  it("reports one line per answered turn, split into the four server stages", async () => {
    const line = await turnWithAudio();

    for (const stage of ["prepare_ms", "llm_ttft_ms", "clause_ms", "tts_ttfa_ms", "gap_ms"]) {
      assert.equal(typeof line.extra[stage], "number", `${stage} must be reported`);
    }
    const ms = (k: string) => {
      const v = line.extra[k];
      assert.equal(typeof v, "number", `${k} must be a number`);
      return v as number;
    };
    assert.equal(
      ms("prepare_ms") + ms("llm_ttft_ms") + ms("clause_ms") + ms("tts_ttfa_ms"),
      ms("gap_ms"),
      "the stages must account for the whole gap",
    );
  });

  it("says the number is server-side only, so nobody reads it as end-to-end", async () => {
    // Device capture and both network hops are ~400ms of the 945ms estimate and
    // are invisible from here. A timing line that did not say so would be read
    // as the user's experience.
    const line = await turnWithAudio();
    assert.match(String(line.extra["note"]), /server-side only/);
  });

  it("stays at info while every stage is inside its allowance", async () => {
    const line = await turnWithAudio();
    assert.equal(line.level, "info");
    assert.equal(line.extra["over_budget"], undefined);
  });

  it("emits nothing for a turn that never reached audio", async () => {
    // A gate refusal is not a slow reply, and reporting one as a turn timing
    // would put a number on silence the user never sat through.
    const h = await opened();
    h.asr().final("   ");
    await waitFor(() => true, "a tick");

    assert.equal(
      h.logs.filter((l) => l.msg === "turn timing").length,
      0,
      "an unanswered turn has no gap to report",
    );
  });

  it("does not report the same turn twice, however much audio arrives", async () => {
    const h = await opened();
    h.llm.script.push(says("Main theek hoon."));
    h.asr().final("Aap kaise ho?");
    await waitFor(() => h.tts().spoken.length > 0, "a reply");

    for (let i = 0; i < 5; i++) h.tts().emit("audio", Buffer.alloc(320));
    await waitFor(() => h.logs.some((l) => l.msg === "turn timing"), "a timing line");

    assert.equal(h.logs.filter((l) => l.msg === "turn timing").length, 1);
  });
});
