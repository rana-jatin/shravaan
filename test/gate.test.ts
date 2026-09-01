/**
 * The speakability gate test matrix — docs/06-speakability-gate.md section 8.
 *
 * The Hinglish and low-confidence cases matter most. Every other case fails
 * loudly in testing; those two fail quietly in production, against the core user.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  blocksLlm,
  endsSession,
  gate1PreConnect,
  gate2FirstDetection,
  gate3Switch,
  resolveSeedLanguage,
} from "../src/domain/gate.ts";
import {
  HEARD_NOT_SPEAKABLE,
  SPEAKABLE,
  assertMatrixIntegrity,
  isSpeakable,
  normalizeLanguage,
  resolveRespondIn,
  speakabilityOf,
} from "../src/domain/languages.ts";
import type { SessionState } from "../src/domain/types.ts";

const baseState = (over: Partial<SessionState> = {}) =>
  ({
    language: "hi-IN",
    switch_declined_acknowledged: false,
    pending_switch: undefined,
    ...over,
  }) as Pick<SessionState, "language" | "switch_declined_acknowledged" | "pending_switch">;

describe("matrix integrity", () => {
  it("is well-formed", () => {
    assert.doesNotThrow(() => assertMatrixIntegrity());
  });

  it("has exactly 11 speakable languages (Bulbul's set, not Saaras's)", () => {
    assert.equal(SPEAKABLE.length, 11);
  });

  it("has exactly 12 heard-but-unspeakable languages", () => {
    assert.equal(HEARD_NOT_SPEAKABLE.length, 12);
  });

  it("never overlaps the two sets", () => {
    const speak = new Set(SPEAKABLE.map((l) => l.code));
    for (const l of HEARD_NOT_SPEAKABLE) assert.ok(!speak.has(l.code), `${l.code} in both sets`);
  });
});

describe("normalisation", () => {
  it("accepts region-qualified tags", () => {
    assert.equal(normalizeLanguage("hi-IN"), "hi-IN");
  });
  it("resolves a bare primary subtag to its Indian variant", () => {
    assert.equal(normalizeLanguage("ta"), "ta-IN");
    assert.equal(normalizeLanguage("ur"), "ur-IN");
  });
  it("handles underscores and casing", () => {
    assert.equal(normalizeLanguage("hi_in"), "hi-IN");
    assert.equal(normalizeLanguage("  HI-in "), "hi-IN");
  });
  it("resolves en-US to en-IN rather than rejecting it", () => {
    assert.equal(normalizeLanguage("en-US"), "en-IN");
  });
  it("returns null for empty input", () => {
    assert.equal(normalizeLanguage(""), null);
    assert.equal(normalizeLanguage(null), null);
  });
});

describe("accept: all 11 speakable languages", () => {
  for (const lang of SPEAKABLE) {
    it(`accepts ${lang.code} (${lang.name})`, () => {
      assert.equal(speakabilityOf(lang.code).status, "speakable");
      assert.equal(gate1PreConnect(lang.code).action, "proceed");
      const g2 = gate2FirstDetection({ detected: lang.code, confidence: 0.99, seed: "hi-IN" });
      assert.equal(g2.action, "proceed");
      assert.equal(blocksLlm(g2), false);
    });
  }
});

describe("refuse: all 12 heard-but-unspeakable languages", () => {
  for (const lang of HEARD_NOT_SPEAKABLE) {
    it(`refuses ${lang.code} (${lang.name}) and responds in a speakable language`, () => {
      const v = speakabilityOf(lang.code, 0.95);
      assert.equal(v.status, "heard_not_speakable");

      const g2 = gate2FirstDetection({ detected: lang.code, confidence: 0.95, seed: "hi-IN" });
      assert.equal(g2.action, "refuse_and_close");
      assert.equal(g2.message_key, "gate.unsupported_language");
      // The whole point: never emit a refusal in a language we cannot speak.
      assert.ok(isSpeakable(g2.respond_in), `respond_in ${g2.respond_in} is not speakable`);
      assert.equal(endsSession(g2), true);
    });
  }
});

describe("non-Indic is out of scope", () => {
  for (const code of ["fr-FR", "ko-KR", "ja-JP", "es-ES"]) {
    it(`refuses ${code} as out_of_scope`, () => {
      assert.equal(speakabilityOf(code, 0.99).status, "out_of_scope");
      const g2 = gate2FirstDetection({ detected: code, confidence: 0.99, seed: "hi-IN" });
      assert.equal(g2.action, "refuse_and_close");
      assert.ok(isSpeakable(g2.respond_in));
    });
  }
});

describe("gate 1 — pre-connect", () => {
  it("refuses an unspeakable seed without proceeding", () => {
    const d = gate1PreConnect("ur-IN");
    assert.equal(d.action, "refuse_pre_connect");
    assert.equal(d.gate, 1);
    assert.ok(isSpeakable(d.respond_in));
  });

  it("proceeds on a speakable seed", () => {
    assert.equal(gate1PreConnect("bn-IN").action, "proceed");
  });
});

describe("gate 2 — first detection, before the LLM", () => {
  it("blocks the LLM on an unspeakable detection", () => {
    const d = gate2FirstDetection({ detected: "ur-IN", confidence: 0.99, seed: "hi-IN" });
    assert.equal(blocksLlm(d), true, "an unspeakable turn must never reach the LLM");
  });

  it("falls back to the seed on low confidence rather than refusing", () => {
    const d = gate2FirstDetection({ detected: "ur-IN", confidence: 0.4, seed: "hi-IN" });
    assert.equal(d.verdict.status, "uncertain");
    assert.equal(d.action, "fallback_to_seed");
    assert.notEqual(d.action, "refuse_and_close");
  });

  it("reprompts when uncertain and the seed is also unspeakable", () => {
    const d = gate2FirstDetection({ detected: null, seed: "ur-IN" });
    assert.equal(d.action, "reprompt");
  });

  it("accepts a speakable language even at low confidence", () => {
    // Refusing a language we CAN speak costs a user; accepting it costs nothing.
    const d = gate2FirstDetection({ detected: "ta-IN", confidence: 0.2, seed: "hi-IN" });
    assert.equal(d.action, "proceed");
  });
});

describe("gate 3 — mid-session switch", () => {
  it("never ends the session", () => {
    let state = baseState();
    let r = gate3Switch({ detected: "ur-IN", confidence: 0.99, state });
    state = baseState({ pending_switch: r.pending_switch });
    r = gate3Switch({ detected: "ur-IN", confidence: 0.99, state });

    assert.equal(r.decision.action, "decline_switch");
    assert.equal(endsSession(r.decision), false, "gate 3 must never terminate a session");
  });

  it("requires two consecutive turns before declining", () => {
    const first = gate3Switch({ detected: "ur-IN", confidence: 0.99, state: baseState() });
    assert.notEqual(first.decision.action, "decline_switch");
    assert.equal(first.pending_switch?.consecutive, 1);

    const second = gate3Switch({
      detected: "ur-IN",
      confidence: 0.99,
      state: baseState({ pending_switch: first.pending_switch }),
    });
    assert.equal(second.decision.action, "decline_switch");
  });

  it("ignores a single off-set detection artefact", () => {
    const artefact = gate3Switch({ detected: "ur-IN", confidence: 0.99, state: baseState() });
    // Next turn is Hindi again — the pending switch must clear.
    const back = gate3Switch({
      detected: "hi-IN",
      confidence: 0.99,
      state: baseState({ pending_switch: artefact.pending_switch }),
    });
    assert.equal(back.decision.action, "proceed");
    assert.equal(back.pending_switch, undefined);
  });

  it("acknowledges only once per session", () => {
    const one = gate3Switch({ detected: "ur-IN", confidence: 0.99, state: baseState() });
    const two = gate3Switch({
      detected: "ur-IN",
      confidence: 0.99,
      state: baseState({ pending_switch: one.pending_switch }),
    });
    assert.equal(two.acknowledge, true);
    assert.equal(two.decision.message_key, "gate.switch_declined");

    const three = gate3Switch({
      detected: "ur-IN",
      confidence: 0.99,
      state: baseState({
        pending_switch: two.pending_switch,
        switch_declined_acknowledged: true,
      }),
    });
    assert.equal(three.acknowledge, false, "must not repeat the apology");
    assert.equal(three.decision.message_key, undefined);
  });

  it("allows switching between two speakable languages", () => {
    const r = gate3Switch({ detected: "ta-IN", confidence: 0.99, state: baseState() });
    assert.equal(r.decision.action, "proceed");
  });
});

describe("Hinglish — the case that fails quietly in production", () => {
  it("never refuses Hindi<->English movement at gate 2", () => {
    for (const code of ["hi-IN", "en-IN", "hi", "en"]) {
      const d = gate2FirstDetection({ detected: code, confidence: 0.55, seed: "hi-IN" });
      assert.equal(d.action, "proceed", `${code} must not be refused`);
    }
  });

  it("never declines Hindi<->English movement at gate 3", () => {
    let state = baseState({ language: "hi-IN" });
    for (const code of ["en-IN", "hi-IN", "en-IN", "hi-IN", "en-IN"]) {
      const r = gate3Switch({ detected: code, confidence: 0.6, state });
      assert.equal(r.decision.action, "proceed", `${code} must not be declined`);
      state = baseState({ language: code, pending_switch: r.pending_switch });
    }
  });

  it("never refuses on a low-confidence read of anything", () => {
    for (const code of [...HEARD_NOT_SPEAKABLE.map((l) => l.code), "fr-FR", "xx-XX"]) {
      const d = gate2FirstDetection({ detected: code, confidence: 0.3, seed: "hi-IN" });
      assert.notEqual(d.action, "refuse_and_close", `${code} at 0.3 confidence must not refuse`);
    }
  });
});

describe("refusal language selection", () => {
  it("falls back to hi-IN with no signal", () => {
    assert.equal(resolveRespondIn({}), "hi-IN");
  });
  it("prefers a speakable profile language", () => {
    assert.equal(resolveRespondIn({ preferred: "ta-IN" }), "ta-IN");
  });
  it("skips an unspeakable profile language", () => {
    assert.equal(resolveRespondIn({ preferred: "ur-IN", previous: "bn-IN" }), "bn-IN");
  });
  it("never returns an unspeakable code", () => {
    for (const l of HEARD_NOT_SPEAKABLE) {
      assert.ok(isSpeakable(resolveRespondIn({ preferred: l.code, previous: l.code })));
    }
  });
});

describe("seed resolution order", () => {
  it("prefers profile over locale hint", () => {
    const r = resolveSeedLanguage({
      profileLanguage: "ta-IN",
      localeHint: "bn-IN",
      fallback: "hi-IN",
    });
    assert.deepEqual(r, { code: "ta-IN", source: "profile" });
  });
  it("uses locale hint when no profile", () => {
    const r = resolveSeedLanguage({ localeHint: "mr-IN", fallback: "hi-IN" });
    assert.deepEqual(r, { code: "mr-IN", source: "context" });
  });
  it("falls back to the default for a cold user", () => {
    const r = resolveSeedLanguage({ fallback: "hi-IN" });
    assert.deepEqual(r, { code: "hi-IN", source: "default" });
  });
});
