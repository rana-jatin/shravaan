/**
 * Speaking without being asked.
 *
 * Two halves. The registry is tested against a fake, because its job is
 * bookkeeping and a fake makes the awkward cases (two devices, a session that
 * died quietly) cheap to set up. `speakProactively` is tested against a REAL
 * `Session` with fake providers, because its job is to be safe inside a machine
 * that was built entirely around answering — and a fake session would be
 * asserting against my own idea of that machine rather than the machine.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SessionRegistry,
  type LiveSession,
  type ProactiveResult,
  type ProactiveSpeech,
} from "../src/orchestrator/session-registry.ts";
import type { SessionState } from "@sp-i/shared/domain/types.ts";
import { callsTool, makeSession, says, settle } from "./helpers.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const REMINDER: ProactiveSpeech = {
  reason: "medication_due",
  text: (language) =>
    language === "hi-IN" ? "दवा लेने का समय हो गया है।" : "Time for your tablet.",
};

/** A LiveSession that records rather than speaks. */
function fakeLive(over: Partial<LiveSession> & { sid: string; uid: string }): LiveSession {
  const heard: ProactiveSpeech[] = [];
  const session: LiveSession = {
    phase: "listening",
    closed: false,
    state: { last_activity_at: "2026-09-06T02:00:00.000Z" } as unknown as SessionState,
    speakProactively: async (u): Promise<ProactiveResult> => {
      heard.push(u);
      return { spoken: true, language: "hi-IN", text: u.text("hi-IN") };
    },
    ...over,
  };
  return session;
}

describe("the session registry", () => {
  it("finds a live session for the person a reminder is about", async () => {
    const registry = new SessionRegistry();
    registry.add(fakeLive({ sid: "s1", uid: "u-anand" }));

    const reached = registry.reach("u-anand");
    assert.ok(reached);
    assert.equal((await reached.speakProactively(REMINDER)).spoken, true);
  });

  it("says nobody is reachable rather than inventing somebody", () => {
    // The honest answer when a device is unplugged. A caller that gets null can
    // fall back to a family member; one handed a dead session cannot.
    const registry = new SessionRegistry();
    assert.equal(registry.reach("u-nobody"), null);
    assert.deepEqual(registry.forUser("u-nobody"), []);
  });

  it("keeps one person's sessions away from another's", () => {
    const registry = new SessionRegistry();
    registry.add(fakeLive({ sid: "s1", uid: "u-anand" }));
    registry.add(fakeLive({ sid: "s2", uid: "u-meera" }));

    assert.deepEqual(
      registry.forUser("u-anand").map((s) => s.sid),
      ["s1"],
    );
  });

  it("puts the most recently active device first when there are two", async () => {
    // Two devices, or a reconnect briefly overlapping the session it replaces.
    // The one somebody is sitting next to is the one that spoke most recently.
    const registry = new SessionRegistry();
    registry.add(
      fakeLive({
        sid: "kitchen",
        uid: "u-anand",
        state: { last_activity_at: "2026-09-06T02:00:00.000Z" } as unknown as SessionState,
      }),
    );
    registry.add(
      fakeLive({
        sid: "bedroom",
        uid: "u-anand",
        state: { last_activity_at: "2026-09-06T07:30:00.000Z" } as unknown as SessionState,
      }),
    );

    assert.deepEqual(
      registry.forUser("u-anand").map((s) => s.sid),
      ["bedroom", "kitchen"],
    );
    assert.equal(registry.reach("u-anand")?.sid, "bedroom");
  });

  it("forgets a session that ended without anybody telling it", () => {
    // `end_conversation`, a terminate, a dependency failure: the session closes
    // and the socket close may follow later or not at all. Handing that out
    // would report a reminder as delivered into silence.
    const registry = new SessionRegistry();
    registry.add(fakeLive({ sid: "s1", uid: "u-anand", closed: true }));
    registry.add(fakeLive({ sid: "s2", uid: "u-anand" }));

    assert.deepEqual(
      registry.forUser("u-anand").map((s) => s.sid),
      ["s2"],
    );
    assert.equal(registry.size, 1);
  });

  it("drops a session on request, and does not mind being asked twice", () => {
    const registry = new SessionRegistry();
    registry.add(fakeLive({ sid: "s1", uid: "u-anand" }));

    registry.remove("s1");
    registry.remove("s1");
    registry.remove("never-existed");
    assert.equal(registry.size, 0);
  });

  it("replaces a session that reconnected under the same sid", () => {
    // Resume-within-the-idle-window: the device comes back with its old sid.
    const registry = new SessionRegistry();
    registry.add(fakeLive({ sid: "s1", uid: "u-anand" }));
    registry.add(fakeLive({ sid: "s1", uid: "u-anand" }));
    assert.equal(registry.size, 1);
  });
});

describe("speaking into a live session", () => {
  /** A session that has started and is sitting in `listening`. */
  async function listening() {
    const h = makeSession();
    await h.session.start();
    return h;
  }

  it("says the prepared line and hands it to the voice", async () => {
    const h = await listening();
    const result = await h.session.speakProactively(REMINDER);

    assert.equal(result.spoken, true);
    assert.equal(h.tts().said(), "दवा लेने का समय हो गया है।");
    assert.equal(h.tts().flushes, 1);
  });

  it("says it in the language the conversation is in, not the caller's guess", async () => {
    // The caller cannot know this: a session picks its language from a profile,
    // a locale hint or a mid-conversation switch, and never announces it. The
    // resolver is handed the session's answer at the moment of speaking.
    const english = makeSession({ localeHint: "en-IN" });
    await english.session.start();

    const result = await english.session.speakProactively(REMINDER);
    assert.equal(result.spoken && result.language, "en-IN");
    assert.equal(english.tts().said(), "Time for your tablet.");
  });

  it("puts the utterance in the turn window, so the agent knows what it said", async () => {
    // Without this, "what?" or "say that again" meets an agent with no idea.
    const h = await listening();
    await h.session.speakProactively(REMINDER);

    const latest = h.session.turns[0]!;
    assert.equal(latest.role, "agent");
    assert.equal(latest.text, "दवा लेने का समय हो गया है।");
  });

  it("goes back to listening once the voice has drained", async () => {
    // The answer has to arrive by the ordinary path, or nobody hears "I took it".
    const h = await listening();
    await h.session.speakProactively(REMINDER);
    assert.equal(h.session.phase, "speaking");

    h.tts().emitDone();
    assert.equal(h.session.phase, "listening");
  });

  it("can be interrupted, like any other thing the agent says", async () => {
    // Talking over a reminder you have already acted on is the correct thing to
    // do, and the echo guard's rules apply unchanged.
    const h = await listening();
    await h.session.speakProactively(REMINDER);

    h.tts().emitAudio();
    h.asr().partial("haan haan le liya");

    assert.equal(h.session.phase, "interrupted");
    assert.ok(h.device.control.some((m) => m["type"] === "clear_audio"));
  });

  it("refuses while the user is talking, rather than talking over them", async () => {
    const h = await listening();
    h.asr().speechStart();
    assert.equal(h.session.phase, "user_speaking");

    const result = await h.session.speakProactively(REMINDER);
    assert.equal(result.spoken, false);
    assert.equal(!result.spoken && result.reason, "busy");
    assert.equal(h.tts().said(), "");
  });

  it("refuses while the agent is mid-reply", async () => {
    const h = await listening();
    h.llm.script.push(says("Aaj mausam saaf hai."));
    h.asr().utterance("mausam kaisa hai");
    // Deliberately not settled: the turn is still running.
    const result = await h.session.speakProactively(REMINDER);

    assert.equal(!result.spoken && result.reason, "busy");
    await settle();
  });

  it("refuses while the radio is playing, rather than speaking over it", async () => {
    // Two sounds in one room, and the session is deaf while media plays —
    // `#onFinal` returns early — so the answer would not be heard either.
    // Whether a reminder is worth stopping the music for is the caller's call.
    const tools = new ToolRegistry();
    tools.register({
      name: "play_test_media",
      description: "starts something playing, for this test only",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      handler: async (_args, ctx) => {
        ctx.host.playMedia({
          source: "radio",
          title: "Vividh Bharati",
          language: "hi-IN",
          urls: ["https://example.invalid/stream"],
        });
        return { ok: true };
      },
    });

    const h = makeSession({ tools });
    await h.session.start();
    h.llm.script.push(callsTool("play_test_media"), says("Chaliye."));
    h.asr().utterance("gaana bajao");
    await settle();
    assert.equal(h.session.mediaPlaying, true);

    // Back to a gap: the turn finished, so only the music is in the way.
    h.tts().emitDone();
    const result = await h.session.speakProactively(REMINDER);

    assert.equal(!result.spoken && result.reason, "media");
  });

  it("refuses once the session has closed", async () => {
    const h = await listening();
    h.session.close("device_disconnected");

    const result = await h.session.speakProactively(REMINDER);
    assert.equal(!result.spoken && result.reason, "closed");
  });

  it("reports missing copy instead of saying nothing and claiming it spoke", async () => {
    // Nine of eleven languages still carry placeholder copy. A reminder whose
    // translation is absent must be visible as a failure, not as a silent success.
    const h = await listening();
    const result = await h.session.speakProactively({ reason: "medication_due", text: () => "  " });

    assert.equal(!result.spoken && result.reason, "no_copy");
    assert.equal(h.tts().said(), "");
    assert.ok(h.logs.some((l) => l.level === "error" && l.msg.includes("copy is missing")));
  });

  it("does not fire twice when two reminders land in the same gap", async () => {
    // The second finds the phase already claimed, because #apply is synchronous
    // and the claim happens in the same step as the test for it.
    const h = await listening();
    const [first, second] = await Promise.all([
      h.session.speakProactively(REMINDER),
      h.session.speakProactively(REMINDER),
    ]);

    assert.equal(first.spoken, true);
    assert.equal(!second.spoken && second.reason, "busy");
    assert.equal(h.tts().spoken.length, 1);
  });

  it("logs what it said and why", async () => {
    const h = await listening();
    await h.session.speakProactively(REMINDER);

    const line = h.logs.find((l) => l.msg === "proactive speech")!;
    assert.equal(line.extra["reason"], "medication_due");
    assert.equal(line.extra["language"], "hi-IN");
  });
});
