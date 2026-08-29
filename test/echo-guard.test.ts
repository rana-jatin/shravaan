/**
 * Echo guard — slice 2.
 *
 * The acceptance criterion from docs/04-milestones.md is TEN CONSECUTIVE TURNS
 * with zero self-interruptions, because echo leakage is intermittent and a
 * single clean run proves nothing. That scenario is at the bottom of this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EchoGuard, normalizeForComparison, selfEchoRatio } from "../src/domain/echo-guard.ts";

describe("self-echo correlation", () => {
  it("normalises across scripts and punctuation", () => {
    assert.equal(normalizeForComparison("Namaste!  Aap kaise hain?"), "namaste aap kaise hain");
    assert.equal(normalizeForComparison("मैं ठीक हूँ। आप?"), "मैं ठीक हूँ आप");
  });

  it("scores our own words coming back as a near-perfect match", () => {
    const spoken = "Namaste! Aap kaise hain? Main aapki madad kar sakta hoon.";
    assert.ok(selfEchoRatio("aap kaise hain", spoken) > 0.9);
  });

  it("scores genuinely different speech near zero", () => {
    const spoken = "Namaste! Aap kaise hain?";
    assert.ok(selfEchoRatio("mujhe kal ka reminder cancel karna hai", spoken) < 0.3);
  });

  it("handles Devanagari echo", () => {
    const spoken = "मैं ठीक हूँ। आप कैसे हैं?";
    assert.ok(selfEchoRatio("मैं ठीक हूँ", spoken) > 0.9);
  });

  it("returns zero when nothing has been spoken", () => {
    assert.equal(selfEchoRatio("anything", ""), 0);
  });
});

describe("suppression window", () => {
  it("accepts speech freely when not speaking", () => {
    const g = new EchoGuard();
    assert.equal(g.onSpeechStart().accept, true);
  });

  it("suppresses a trigger immediately after playback starts", () => {
    const g = new EchoGuard({ suppressionWindowMs: 400 });
    const t0 = 1_000_000;
    g.onPlaybackStart(t0);
    const d = g.onSpeechStart(t0 + 50);
    assert.equal(d.accept, false);
    assert.equal(d.reason, "suppression_window");
  });

  it("stops suppressing once the window has passed", () => {
    const g = new EchoGuard({ suppressionWindowMs: 400, requireTranscript: false });
    const t0 = 1_000_000;
    g.onPlaybackStart(t0);
    assert.equal(g.onSpeechStart(t0 + 500).accept, true);
  });
});

describe("transcript confirmation", () => {
  it("defers a bare VAD trigger while speaking", () => {
    const g = new EchoGuard({ suppressionWindowMs: 0, requireTranscript: true });
    g.onPlaybackStart(1000);
    const d = g.onSpeechStart(2000);
    assert.equal(d.accept, false);
    assert.equal(d.reason, "awaiting_transcript", "a bare VAD trigger must not flush playback");
  });

  it("confirms on a non-empty, non-matching partial", () => {
    const g = new EchoGuard({ suppressionWindowMs: 0 });
    g.onPlaybackStart(1000);
    g.onSpeakText("Namaste, aap kaise hain");
    g.onSpeechStart(2000);
    assert.equal(g.onPartial("ruko zara", 2100).accept, true);
  });

  it("ignores an empty partial", () => {
    const g = new EchoGuard({ suppressionWindowMs: 0 });
    g.onPlaybackStart(1000);
    assert.equal(g.onPartial("   ", 2000).accept, false);
  });
});

describe("the self-interruption loop", () => {
  it("rejects our own words echoing back", () => {
    const g = new EchoGuard({ suppressionWindowMs: 0 });
    g.onPlaybackStart(1000);
    g.onSpeakText("Aapka appointment kal shaam chhe baje confirm ho gaya hai");
    g.onSpeechStart(2000);

    // The mic hears the speaker. The ASR faithfully transcribes US.
    const d = g.onPartial("appointment kal shaam chhe baje", 2100);
    assert.equal(d.accept, false);
    assert.equal(d.reason, "self_echo");
    assert.equal(g.stats.selfEcho, 1);
  });

  it("still lets a real interruption through mid-reply", () => {
    const g = new EchoGuard({ suppressionWindowMs: 0 });
    g.onPlaybackStart(1000);
    g.onSpeakText("Aapka appointment kal shaam chhe baje confirm ho gaya hai");
    g.onSpeechStart(2000);
    assert.equal(g.onPartial("nahi nahi ruko", 2100).accept, true);
  });

  it("does not mistake a user repeating one word for echo", () => {
    const g = new EchoGuard({ suppressionWindowMs: 0, selfEchoThreshold: 0.6 });
    g.onPlaybackStart(1000);
    g.onSpeakText("aapka appointment confirm ho gaya hai");
    g.onSpeechStart(2000);
    // "appointment" overlaps, the rest does not — below threshold, so accepted.
    assert.equal(g.onPartial("appointment badalna hai mujhe", 2100).accept, true);
  });
});

describe("half-duplex fallback (ADR 0007 emergency path)", () => {
  it("mutes barge-in entirely while speaking", () => {
    const g = new EchoGuard({ halfDuplex: true, suppressionWindowMs: 0 });
    g.onPlaybackStart(1000);
    assert.equal(g.onSpeechStart(9999).reason, "half_duplex");
    assert.equal(g.onPartial("ruko", 9999).reason, "half_duplex");
  });

  it("still listens normally when not speaking", () => {
    const g = new EchoGuard({ halfDuplex: true });
    assert.equal(g.onSpeechStart().accept, true);
  });
});

describe("slice 2 acceptance: ten consecutive turns, zero self-interruptions", () => {
  const REPLIES = [
    "Namaste! Main aapki kya madad kar sakta hoon?",
    "Aapka appointment kal shaam chhe baje hai.",
    "मैं समझ गया, मैं इसे बदल देता हूँ।",
    "Theek hai, maine yeh note kar liya hai.",
    "Aapke paas do pending reminders hain.",
    "आपका काम हो गया है।",
    "Main aapko kal yaad dila doonga.",
    "Kya aap kuch aur poochhna chahenge?",
    "यह जानकारी मैंने सेव कर दी है।",
    "Bilkul, main abhi check karta hoon.",
  ];

  it("survives ten turns of leaked echo without a single false barge-in", () => {
    const g = new EchoGuard({ suppressionWindowMs: 400 });
    let clock = 1_000_000;

    for (const reply of REPLIES) {
      g.onPlaybackStart(clock);
      g.onSpeakText(reply);

      // Leak 1: VAD fires inside the suppression window.
      assert.equal(g.onSpeechStart(clock + 100).accept, false);

      // Leak 2: VAD fires after the window, then the ASR transcribes US.
      g.onSpeechStart(clock + 600);
      const echoed = reply.split(" ").slice(0, 5).join(" ");
      const d = g.onPartial(echoed, clock + 700);
      assert.equal(d.accept, false, `self-interrupted on: "${echoed}"`);

      g.onPlaybackEnd();
      clock += 5000;
    }

    assert.equal(g.stats.accepted, 0, "zero self-interruptions across ten turns");
    assert.equal(g.stats.suppressed, 10);
    assert.equal(g.stats.selfEcho, 10);
  });

  it("accepts a genuine interruption on every one of those ten turns", () => {
    const g = new EchoGuard({ suppressionWindowMs: 400 });
    let clock = 1_000_000;
    let accepted = 0;

    for (const reply of REPLIES) {
      g.onPlaybackStart(clock);
      g.onSpeakText(reply);
      g.onSpeechStart(clock + 600);
      if (g.onPartial("ek minute ruko", clock + 700).accept) accepted++;
      g.onPlaybackEnd();
      clock += 5000;
    }

    assert.equal(accepted, 10, "the guard must not deafen the bot to real interruptions");
  });
});
