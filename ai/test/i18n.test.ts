/**
 * The copy resolver.
 *
 * There were four of these, copy-pasted, plus a fifth written inline in
 * session.ts that skipped Hindi on the emergency acknowledgement. These tests
 * pin the one ladder, and the two defects that consolidating it fixed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LADDER, interpolate, lookup, reviewPending, t } from "../src/i18n/resolve.ts";
import { draft, ready, type Catalogue } from "../src/i18n/types.ts";
import { REFUSAL_LADDER, SPEAKABLE } from "../src/domain/languages.ts";
import {
  EMERGENCY_ACK,
  EMERGENCY_FAILED,
  resolveEmergencyAck,
  resolveEmergencyFailed,
} from "../src/copy/emergency-intent.ts";
import { resolveFallback, resolveFiller, resolveProgress } from "../src/copy/fillers.ts";
import { resolveCopy } from "../src/copy/refusals.ts";

const catalogue: Catalogue<"greeting" | "only_english"> = {
  greeting: {
    "en-IN": ready("Hello.", "Hi there."),
    "hi-IN": ready("नमस्ते।"),
    "bn-IN": draft("হ্যালো।"),
  },
  only_english: { "en-IN": ready("English only.") },
};

describe("the fallback ladder", () => {
  it("is the one in languages.json, not a fifth copy of it", () => {
    // Two ladders is how the existing ones came to disagree.
    assert.deepEqual([...LADDER], [...REFUSAL_LADDER]);
    assert.deepEqual([...LADDER], ["hi-IN", "en-IN"]);
  });

  it("prefers the requested language", () => {
    assert.equal(t(catalogue, "greeting", "bn-IN"), "হ্যালো।");
  });

  it("falls to Hindi before English", () => {
    // Hindi is on the ladder because it has the widest comprehension across the
    // excluded set. Skipping it was the defect on the emergency path.
    assert.equal(t(catalogue, "greeting", "ta-IN"), "नमस्ते।");
  });

  it("falls to English when Hindi is missing too", () => {
    assert.equal(t(catalogue, "only_english", "ta-IN"), "English only.");
  });

  it("says something rather than nothing when the ladder misses entirely", () => {
    // A missing translation must never become silence — a sentence in the wrong
    // language still tells a person something is happening.
    const odd: Catalogue<"x"> = { x: { "or-IN": ready("ଓଡ଼ିଆ") } };
    assert.equal(t(odd, "x", "ta-IN"), "ଓଡ଼ିଆ");
  });

  it("throws for a key that exists in no language at all", () => {
    // A typo in a call site, caught here rather than by a user hearing nothing.
    assert.throws(() => t({ x: {} }, "x", "en-IN"), /no copy/);
  });

  it("returns null from lookup for an unknown key", () => {
    assert.equal(lookup(catalogue, "nope" as "greeting", "en-IN"), null);
  });
});

describe("variant rotation", () => {
  it("cycles rather than repeating one phrase", () => {
    assert.equal(t(catalogue, "greeting", "en-IN", { rotate: 0 }), "Hello.");
    assert.equal(t(catalogue, "greeting", "en-IN", { rotate: 1 }), "Hi there.");
    assert.equal(t(catalogue, "greeting", "en-IN", { rotate: 2 }), "Hello.");
  });

  it("is stable for the same index, so a test can assert on it", () => {
    assert.equal(
      t(catalogue, "greeting", "en-IN", { rotate: 7 }),
      t(catalogue, "greeting", "en-IN", { rotate: 7 }),
    );
  });
});

describe("interpolation", () => {
  it("fills a placeholder", () => {
    assert.equal(interpolate("I'm telling {names}.", { names: "Harsh" }), "I'm telling Harsh.");
  });

  it("fills EVERY occurrence, not just the first", () => {
    // REGRESSION. `.replace("{names}", …)` with a string pattern substitutes
    // once. A translation using the placeholder twice would have read the second
    // one out as literal braces, to someone who had just asked for help.
    assert.equal(
      interpolate("{names} — I am telling {names} now.", { names: "Aman" }),
      "Aman — I am telling Aman now.",
    );
  });

  it("drops a placeholder nobody filled rather than speaking the braces", () => {
    // Hearing "open brace names close brace" from a device you asked for help is
    // worse than a slightly clipped sentence.
    assert.equal(interpolate("I'm telling {names}."), "I'm telling.");
    assert.ok(!interpolate("{a} and {b}", { a: "x" }).includes("{"));
  });

  it("tidies the space the dropped placeholder left behind", () => {
    assert.equal(interpolate("a  b"), "a b");
    // Danda too — Devanagari and Odia end sentences with it.
    assert.equal(interpolate("मैं {names} को बता रहा हूँ।"), "मैं को बता रहा हूँ।");
  });

  it("leaves text with no placeholders untouched", () => {
    assert.equal(interpolate("Nothing to fill here."), "Nothing to fill here.");
  });
});

describe("the review report", () => {
  it("names only the languages still on placeholder text", () => {
    assert.deepEqual(reviewPending("greetings", catalogue), [
      { scope: "greetings", language: "bn-IN" },
    ]);
  });

  it("can report per key instead of per catalogue", () => {
    assert.deepEqual(reviewPending("unused", catalogue, true), [
      { scope: "greeting", language: "bn-IN" },
    ]);
  });
});

describe("the emergency acknowledgement", () => {
  it("is spoken in the caller's language", () => {
    assert.equal(
      resolveEmergencyAck("hi-IN", "Harsh"),
      EMERGENCY_ACK["hi-IN"]!.replace("{names}", "Harsh"),
    );
  });

  it("falls back to Hindi, not English", () => {
    // REGRESSION. session.ts read `ACK[language] ?? ACK["en-IN"]` inline, past
    // Hindi. Of every sentence in the product, this is the worst one to fall
    // back to the least-understood language on.
    const ack = resolveEmergencyAck("zz-ZZ", "Harsh");
    assert.equal(ack, EMERGENCY_ACK["hi-IN"]!.replace("{names}", "Harsh"));
    assert.notEqual(ack, EMERGENCY_ACK["en-IN"]!.replace("{names}", "Harsh"));
  });

  it("names the contacts, because a person's name is the reassurance", () => {
    assert.match(resolveEmergencyAck("en-IN", "Harsh and Aman"), /Harsh and Aman/);
  });

  it("never leaves a placeholder in what gets spoken", () => {
    for (const { code } of SPEAKABLE) {
      assert.ok(!resolveEmergencyAck(code, "Harsh").includes("{"), `${code} leaked a placeholder`);
      assert.ok(!resolveEmergencyFailed(code).includes("{"), `${code} leaked a placeholder`);
    }
  });

  it("tells the truth when the alert did not go out", () => {
    // A companion that says "I've told them" and has not is worse than one with
    // no alarm at all: it stops the person trying anything else.
    assert.equal(resolveEmergencyFailed("en-IN"), EMERGENCY_FAILED["en-IN"]);
    assert.notEqual(resolveEmergencyFailed("en-IN"), resolveEmergencyAck("en-IN", "Harsh"));
  });
});

describe("the existing resolvers still behave", () => {
  it("rotates fillers", () => {
    assert.notEqual(resolveFiller("en-IN", 0), resolveFiller("en-IN", 1));
    assert.equal(resolveFiller("en-IN", 0), resolveFiller("en-IN", 3));
  });

  it("resolves a tool fallback in every speakable language", () => {
    for (const { code } of SPEAKABLE) {
      assert.ok(resolveFallback("tool.timeout", code).length > 0, code);
    }
  });

  it("resolves a progress line in every speakable language", () => {
    for (const { code } of SPEAKABLE) {
      assert.ok(resolveProgress("progress.weather", code).length > 0, code);
    }
  });

  it("resolves gate copy for an unknown language down the ladder", () => {
    assert.equal(
      resolveCopy("gate.unsupported_language", "zz-ZZ").text,
      resolveCopy("gate.unsupported_language", "hi-IN").text,
    );
  });
});
