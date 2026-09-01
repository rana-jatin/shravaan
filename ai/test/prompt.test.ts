/**
 * What the model is actually told.
 *
 * These assertions were impossible to write until buildMessages and
 * profileBlock came out of Session as free functions: reaching them meant
 * constructing a whole session, which meant opening sockets. They are the
 * highest-leverage strings in the product and they now have a test.
 *
 * The cache-prefix property below is the one most likely to be broken by an
 * innocent-looking edit, and the one with a bill attached.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMessages, profileBlock } from "../src/orchestrator/prompt.ts";
import { SYSTEM_PROMPT } from "../src/orchestrator/session-deps.ts";
import type { Profile, Turn } from "@sp-i/shared/domain/types.ts";

const at = "2026-09-01T10:00:00.000Z";

function turn(tid: number, role: "user" | "agent", text: string): Turn {
  return { tid, role, text, language: "hi-IN", at };
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    uid: "u1",
    distilled_at: at,
    preferred_language: "hi-IN",
    facts: [],
    recent_episodes: [],
    open_threads: [],
    ...over,
  };
}

describe("buildMessages", () => {
  it("puts the system prompt first and the history oldest-first", () => {
    // #turns is newest-first, mirroring the Redis list.
    const turns = [turn(3, "user", "and now?"), turn(2, "agent", "hello"), turn(1, "user", "hi")];

    const msgs = buildMessages(turns, null, "and now?");

    assert.equal(msgs[0]!.role, "system");
    assert.deepEqual(
      msgs.slice(1).map((m) => m.content),
      ["hi", "hello", "and now?"],
    );
  });

  it("does not repeat the current turn, which is already the last entry", () => {
    const turns = [turn(1, "user", "what time is it")];

    const msgs = buildMessages(turns, null, "what time is it");

    assert.equal(msgs.filter((m) => m.content === "what time is it").length, 1);
  });

  it("appends the current turn when the window does not already hold it", () => {
    const turns = [turn(1, "agent", "hello there")];

    const msgs = buildMessages(turns, null, "what time is it");

    assert.equal(msgs.at(-1)!.role, "user");
    assert.equal(msgs.at(-1)!.content, "what time is it");
  });

  it("drops empty turns — an interrupted reply must not become a blank message", () => {
    const turns = [turn(2, "agent", "   "), turn(1, "user", "hi")];

    const msgs = buildMessages(turns, null, "next");

    assert.ok(msgs.every((m) => m.content.trim() !== ""));
  });

  it("maps agent turns to the assistant role", () => {
    const msgs = buildMessages([turn(1, "agent", "hello")], null, "hi");

    assert.equal(msgs[1]!.role, "assistant");
  });

  it("keeps the cached prefix byte-identical when there is no profile", () => {
    // Sarvam prices cached input at roughly a third of fresh input, and that is
    // only reachable while the prefix does not churn between turns.
    const a = buildMessages([turn(1, "user", "hi")], null, "hi");
    const b = buildMessages([turn(9, "user", "much later")], null, "much later");

    assert.equal(a[0]!.content, b[0]!.content);
    assert.equal(a[0]!.content, SYSTEM_PROMPT);
  });

  it("appends the profile as a SUFFIX, leaving the prefix untouched", () => {
    const msgs = buildMessages(
      [turn(1, "user", "hi")],
      profile({ facts: [{ id: "f1", text: "They live in Pune", salience: 1 }] }),
      "hi",
    );

    assert.ok(
      msgs[0]!.content.startsWith(SYSTEM_PROMPT),
      "the profile must never be spliced into the middle of the cached prefix",
    );
  });
});

describe("profileBlock", () => {
  it("renders nothing without a profile", () => {
    assert.equal(profileBlock(null), "");
  });

  it("renders nothing for a profile that knows nothing", () => {
    assert.equal(profileBlock(profile()), "");
  });

  it("renders facts, open threads and episodes under their own headings", () => {
    const out = profileBlock(
      profile({
        facts: [{ id: "f1", text: "Their sister is Meera", salience: 1 }],
        open_threads: [{ id: "t1", text: "the hospital appointment", last_touched: at }],
        recent_episodes: [{ id: "e1", summary: "talked about the garden", at }],
      }),
    );

    assert.match(out, /What you know about them:\n- Their sister is Meera/);
    assert.match(out, /Left unfinished last time:\n- the hospital appointment/);
    assert.match(out, /Recently:\n- talked about the garden/);
  });

  it("caps episodes at three so an old fortnight cannot crowd out the prompt", () => {
    const out = profileBlock(
      profile({
        recent_episodes: [1, 2, 3, 4, 5].map((n) => ({ id: `e${n}`, summary: `ep${n}`, at })),
      }),
    );

    assert.ok(out.includes("ep3"));
    assert.ok(!out.includes("ep4"), "only the three most recent episodes belong on the turn path");
  });

  it("tells the model not to recite what it remembers", () => {
    // Opening with a list of remembered facts reads as unsettling rather than
    // warm — the instruction is the guard against it.
    const out = profileBlock(profile({ facts: [{ id: "f1", text: "x", salience: 1 }] }));

    assert.match(out, /do not recite it/i);
    assert.match(out, /do not open by listing what you remember/i);
  });
});
