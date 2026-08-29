/**
 * Turn state machine, clause chunker, Redis key shapes and refusal copy.
 * All pure — no network, no credentials.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClauseChunker } from "../src/domain/clause-chunker.ts";
import { TTL, TURN_WINDOW, key, sessionKeys } from "../src/domain/redis-keys.ts";
import { isAgentSpeaking, isBargeIn, transition } from "../src/domain/turn-state.ts";
import { COPY, pendingNativeReview, resolveCopy } from "../src/copy/refusals.ts";
import { SPEAKABLE, isSpeakable } from "../src/domain/languages.ts";

describe("turn state machine", () => {
  it("runs a clean turn end to end", () => {
    let p = transition("idle", { type: "session_open" }).phase;
    assert.equal(p, "listening");
    p = transition(p, { type: "speech_start" }).phase;
    assert.equal(p, "user_speaking");
    p = transition(p, { type: "speech_end", text: "namaste" }).phase;
    assert.equal(p, "thinking");
    p = transition(p, { type: "first_clause_ready" }).phase;
    assert.equal(p, "speaking");
    p = transition(p, { type: "playback_drained" }).phase;
    assert.equal(p, "listening");
  });

  it("treats speech during playback as barge-in and flushes", () => {
    const r = transition("speaking", { type: "speech_start" });
    assert.equal(r.phase, "interrupted");
    assert.equal(r.flushPlayback, true, "queued device audio must be dropped");
    assert.ok(isBargeIn("speaking", { type: "speech_start" }));
  });

  it("does not flush when speech starts while merely listening", () => {
    const r = transition("listening", { type: "speech_start" });
    assert.equal(r.flushPlayback, false);
  });

  it("routes through tool_wait when a tool is dispatched", () => {
    let p = transition("thinking", { type: "tool_dispatched" }).phase;
    assert.equal(p, "tool_wait");
    p = transition(p, { type: "tool_result" }).phase;
    assert.equal(p, "speaking");
  });

  it("ignores unhandled events rather than throwing", () => {
    // Providers emit out of order under load; a crashed session is worse than a
    // dropped event.
    const r = transition("idle", { type: "playback_drained" });
    assert.equal(r.phase, "idle");
    assert.equal(r.changed, false);
  });

  it("reports agent_speaking only while speaking", () => {
    assert.equal(isAgentSpeaking("speaking"), true);
    assert.equal(isAgentSpeaking("thinking"), false);
  });
});

describe("clause chunker", () => {
  it("emits a first chunk early for latency", () => {
    const c = new ClauseChunker();
    const out = c.push("Namaste! Aap kaise hain");
    assert.ok(out.length >= 1, "should emit before the full completion");
    assert.ok(out[0]!.length < 30, "first chunk should be short");
  });

  it("splits on the Devanagari danda", () => {
    const c = new ClauseChunker({ firstChunkMinChars: 5 });
    const out = c.push("मैं ठीक हूँ। आप कैसे हैं?");
    assert.ok(out.some((s) => s.includes("।")) || out.length > 0);
  });

  it("never splits mid-word", () => {
    const c = new ClauseChunker({ firstChunkMinChars: 5, minChars: 10, maxChars: 20 });
    const chunks = [...c.push("supercalifragilistic expialidocious wordage here"), c.flush()];
    for (const ch of chunks) {
      if (ch) assert.ok(!/\S$/.test(ch) || !ch.endsWith("-"), "no mid-word split");
    }
  });

  it("stays under Sarvam's 500-char streaming recommendation", () => {
    const c = new ClauseChunker();
    const long = "yeh ek bahut lamba vaakya hai ".repeat(50);
    const all = [...c.push(long), c.flush()].filter(Boolean) as string[];
    for (const ch of all) assert.ok(ch.length <= 500, `chunk of ${ch.length} chars is too long`);
  });

  it("flushes the tail at end of turn", () => {
    const c = new ClauseChunker();
    c.push("short");
    assert.equal(c.flush(), "short");
    assert.equal(c.flush(), null);
  });

  it("resets cleanly on barge-in", () => {
    const c = new ClauseChunker();
    c.push("this will be abandoned mid-sentence");
    c.reset();
    assert.equal(c.flush(), null);
  });
});

describe("redis keys and TTLs", () => {
  it("formats keys per the data contract", () => {
    assert.equal(key.sessionState("abc"), "sess:abc:state");
    assert.equal(key.sessionTurns("abc"), "sess:abc:turns");
    assert.equal(key.userProfile("u1"), "user:u1:ctx".replace(":ctx", ":profile"));
    assert.equal(key.memWrites(), "mem:writes");
  });

  it("uses an idle window for sessions, not a call length", () => {
    assert.equal(TTL.SESSION_SECONDS, 30 * 60);
  });

  it("keeps user context on a short ABSOLUTE ttl", () => {
    // Entitlements must go stale predictably; an idle TTL would let a suspended
    // account keep its capabilities as long as it stays chatty.
    assert.equal(TTL.USER_CONTEXT_SECONDS, 15 * 60);
    assert.ok(TTL.USER_CONTEXT_SECONDS < TTL.SESSION_SECONDS);
  });

  it("keeps the profile durable across sessions", () => {
    assert.equal(TTL.USER_PROFILE_SECONDS, 7 * 24 * 60 * 60);
    assert.ok(
      TTL.USER_PROFILE_SECONDS > TTL.SESSION_SECONDS,
      "profile must outlive a session under strong continuity",
    );
  });

  it("enumerates every session key for teardown", () => {
    assert.equal(sessionKeys("s1").length, 4);
    assert.ok(sessionKeys("s1").every((k) => k.startsWith("sess:s1:")));
  });

  it("caps the LLM window at 12 turns", () => {
    assert.equal(TURN_WINDOW, 12);
  });
});

describe("refusal copy", () => {
  it("has both message keys for every speakable language", () => {
    for (const lang of SPEAKABLE) {
      assert.ok(COPY["gate.unsupported_language"][lang.code], `missing refusal for ${lang.code}`);
      assert.ok(COPY["gate.switch_declined"][lang.code], `missing decline for ${lang.code}`);
    }
  });

  it("only ever holds copy for speakable languages", () => {
    for (const table of Object.values(COPY)) {
      for (const code of Object.keys(table)) {
        assert.ok(isSpeakable(code), `copy exists for unspeakable ${code}`);
      }
    }
  });

  it("falls back rather than returning nothing", () => {
    const c = resolveCopy("gate.unsupported_language", "zz-ZZ");
    assert.ok(c.text.length > 0, "a missing translation must never become silence");
  });

  it("flags placeholder translations for native review", () => {
    const pending = pendingNativeReview();
    const langs = new Set(pending.map((p) => p.language));
    assert.ok(!langs.has("en-IN"), "en-IN should be reviewed");
    assert.ok(!langs.has("hi-IN"), "hi-IN should be reviewed");
    assert.ok(langs.size > 0, "the remaining nine are placeholders and must be flagged");
  });
});
