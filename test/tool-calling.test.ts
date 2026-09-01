/**
 * OpenAI-style function calling on sarvam-105b.
 *
 * The wire-format tests here are not hypotheticals. Every input in "argument
 * accumulation" was captured from a live socket by `npm run verify:tools`, which
 * is what turned ADR 0003's open question into a settled one. The `{}{}` case in
 * particular is a regression test for a divergence that failed SILENTLY: the
 * parser threw, the catch swallowed it, and the tool ran with empty arguments.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accumulateArgs,
  firstJsonValue,
  parseToolArgs,
} from "../src/providers/sarvam-llm.ts";
import { ToolRegistry, toSchema, validateArgs } from "../src/tools/registry.ts";
import {
  BUILTIN_TOOLS,
  endConversation,
  forgetThis,
  getTime,
  recall,
  rememberThis,
  repeatThat,
  setLanguage,
  setSpeakingPace,
} from "../src/tools/builtin.ts";
import { SPEAKABLE } from "../src/domain/languages.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { fakeHost, invocation } from "./helpers.ts";

/** Register through the registry so defaults are applied, as in production. */
function defined(spec: (typeof BUILTIN_TOOLS)[number]): ToolDefinition {
  return new ToolRegistry().register(spec).get(spec.name)!;
}

describe("argument accumulation — the observed Sarvam divergence", () => {
  it("drops a repeated complete value instead of concatenating it", () => {
    // Captured live. Sarvam sends a short argument object whole, then again:
    //   frame 55 {"arguments":""}   frame 56 {"arguments":"{}"}   frame 57 {"arguments":"{}"}
    // Concatenating gives `{}{}`, which is not JSON.
    let acc = "";
    for (const fragment of ["", "{}", "{}"]) acc = accumulateArgs(acc, fragment);
    assert.equal(acc, "{}");
    assert.deepEqual(parseToolArgs(acc, "get_time"), {});
  });

  it("still concatenates a genuinely fragmented stream", () => {
    // Also captured live: long arguments DO arrive token by token, exactly as
    // OpenAI streams them. Deduplication must not break this.
    const fragments = ['{"text": "', "my", " mother", '", ', '"kind": ', '"biographical"', "}"];
    let acc = "";
    for (const f of fragments) acc = accumulateArgs(acc, f);
    assert.deepEqual(parseToolArgs(acc, "remember_this"), {
      text: "my mother",
      kind: "biographical",
    });
  });

  it("does not mistake a repeated fragment for a repeated value mid-stream", () => {
    // "a" arriving twice inside an incomplete object is content, not a retransmit
    // — dedupe only applies once what we hold is already valid JSON.
    let acc = "";
    for (const f of ['{"x": "a', "a", '"}']) acc = accumulateArgs(acc, f);
    assert.deepEqual(parseToolArgs(acc, "t"), { x: "aa" });
  });

  it("recovers the first value if a duplicate slips through anyway", () => {
    assert.deepEqual(parseToolArgs('{"city": "Pune"}{"city": "Pune"}', "get_weather"), {
      city: "Pune",
    });
  });

  it("reports rather than hides arguments it cannot parse", () => {
    const warnings: string[] = [];
    const args = parseToolArgs('{"city": "Pu', "get_weather", (m) => warnings.push(m));
    // Empty args, so the executor's validation speaks "I didn't catch the
    // details" — but the operator gets told, which is what was missing before.
    assert.deepEqual(args, {});
    assert.equal(warnings.length, 1);
  });

  it("treats absent arguments as an empty object, not a failure", () => {
    assert.deepEqual(parseToolArgs("", "get_time"), {});
    assert.deepEqual(parseToolArgs("   ", "get_time"), {});
  });
});

describe("firstJsonValue", () => {
  it("is not fooled by braces inside strings", () => {
    const found = firstJsonValue('{"text": "a } b"}{"text": "a } b"}');
    assert.equal(found?.value, '{"text": "a } b"}');
  });

  it("respects escapes inside strings", () => {
    const found = firstJsonValue('{"t": "say \\"hi\\" }"}trailing');
    assert.equal(found?.value, '{"t": "say \\"hi\\" }"}');
    assert.equal(found?.rest, "trailing");
  });

  it("returns null while the value is still incomplete", () => {
    assert.equal(firstJsonValue('{"a": 1'), null);
  });
});

describe("strict schemas", () => {
  it("claims strict only when the schema actually conforms", () => {
    const conforming = defined({
      name: "a",
      description: "d",
      parameters: {
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
        additionalProperties: false,
      },
      handler: async () => ({}),
    });
    assert.equal(toSchema(conforming).function.strict, true);
  });

  it("withholds strict when a property is optional", () => {
    // OpenAI rejects this combination outright. Sarvam's behaviour is untested,
    // and claiming a guarantee we do not meet is how you earn a 400 on the one
    // turn the user needed the tool.
    const optional = defined({
      name: "b",
      description: "d",
      parameters: {
        type: "object",
        properties: { x: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
      handler: async () => ({}),
    });
    assert.equal(toSchema(optional).function.strict, undefined);
  });

  it("withholds strict when additional properties are allowed", () => {
    const open = defined({
      name: "c",
      description: "d",
      parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      handler: async () => ({}),
    });
    assert.equal(toSchema(open).function.strict, undefined);
  });
});

describe("argument validation", () => {
  const tool = (props: Record<string, never> | ToolDefinition["parameters"]["properties"]) =>
    defined({
      name: "t",
      description: "d",
      parameters: { type: "object", properties: props, required: [] },
      handler: async () => ({}),
    });

  it("rejects a float where an integer was declared", () => {
    // `typeof 1.5 === "number"`, so the previous check passed this through.
    const t = tool({ count: { type: "integer" } });
    assert.equal(validateArgs(t, { count: 1.5 }).ok, false);
    assert.equal(validateArgs(t, { count: 2 }).ok, true);
  });

  it("rejects NaN and Infinity as numbers", () => {
    const t = tool({ amount: { type: "number" } });
    assert.equal(validateArgs(t, { amount: Number.NaN }).ok, false);
    assert.equal(validateArgs(t, { amount: Number.POSITIVE_INFINITY }).ok, false);
  });

  it("checks array element types", () => {
    const t = tool({ names: { type: "array", items: { type: "string" } } });
    assert.equal(validateArgs(t, { names: ["a", "b"] }).ok, true);
    assert.equal(validateArgs(t, { names: ["a", 3] }).ok, false);
  });

  it("still rejects an invented argument name", () => {
    assert.equal(validateArgs(tool({ x: { type: "string" } }), { y: "1" }).ok, false);
  });
});

describe("built-in tools", () => {
  it("registers every built-in with a name the model can call", () => {
    const reg = new ToolRegistry();
    for (const spec of BUILTIN_TOOLS) reg.register(spec);
    assert.equal(reg.all().length, BUILTIN_TOOLS.length);
    // No entitlement on any of them: these need nothing but the session, so
    // gating them behind a backend we may not be able to reach would withhold
    // "say that again" during an outage.
    assert.ok(reg.offerableTo(null).length === BUILTIN_TOOLS.length);
  });

  it("keeps every deadline inside conversational patience", () => {
    // The 8 s default is sized for a network call. These are in-process.
    for (const spec of BUILTIN_TOOLS) {
      const d = defined(spec);
      assert.ok(
        d.deadline_ms <= 2500,
        `${d.name} has a ${d.deadline_ms}ms deadline — too long for a live turn`,
      );
    }
  });

  it("offers only language codes the system can actually speak", () => {
    const codes = setLanguage.parameters.properties["language"]?.enum ?? [];
    assert.deepEqual([...codes].sort(), SPEAKABLE.map((l) => l.code).sort());
  });

  it("keeps enum tokens language-neutral", () => {
    // A model reasoning in Hindi will answer an enum in Hindi unless the tokens
    // are unambiguously English identifiers, and validation would then reject a
    // call the user legitimately made.
    for (const spec of BUILTIN_TOOLS) {
      for (const [key, prop] of Object.entries(spec.parameters.properties)) {
        for (const value of prop.enum ?? []) {
          assert.match(value, /^[a-zA-Z][a-zA-Z0-9_-]*$/, `${spec.name}.${key} = ${value}`);
        }
      }
    }
  });

  it("get_time reports the timezone it actually used", async () => {
    const data = await getTime.handler({}, invocation({ host: fakeHost({ timezone: () => "Asia/Kolkata" }) }));
    assert.equal(data["timezone"], "Asia/Kolkata");
    assert.match(String(data["time_24h"]), /^\d{2}:\d{2}$/);
    assert.ok(String(data["weekday"]).length > 0);
  });

  it("repeat_that returns the previous reply verbatim", async () => {
    const host = fakeHost({ lastAgentReply: () => "आपकी दवाई साढ़े आठ बजे है।" });
    const data = await repeatThat.handler({}, invocation({ host }));
    assert.equal(data["repeated"], true);
    assert.equal(data["text"], "आपकी दवाई साढ़े आठ बजे है।");
  });

  it("repeat_that reports nothing-to-repeat as DATA, not an error", async () => {
    // The whole point: a domain outcome the model narrates in the turn's own
    // language, rather than an error code that would need eleven translations.
    const data = await repeatThat.handler({}, invocation());
    assert.equal(data["repeated"], false);
    assert.equal(data["reason"], "nothing_said_yet");
  });

  it("set_language reports a declined switch as already acknowledged", async () => {
    // The session speaks the reviewed refusal itself. Telling the model it is
    // done stops the user hearing the same apology twice.
    const host = fakeHost({
      requestLanguage: () => ({ switched: false, language: "hi-IN", reason: "not_speakable" }),
    });
    const data = await setLanguage.handler({ language: "ta-IN" }, invocation({ host }));
    assert.equal(data["switched"], false);
    assert.equal(data["already_acknowledged"], true);
  });

  it("set_speaking_pace surfaces the clamp so the model does not over-promise", async () => {
    const host = fakeHost({ pace: () => 0.6, setPace: () => 0.6 });
    const data = await setSpeakingPace.handler({ change: "slower" }, invocation({ host }));
    assert.equal(data["at_limit"], true, "already at the floor — say so rather than agreeing");
  });

  it("remember_this writes through to memory", async () => {
    const written: Array<{ text: string; kind: string }> = [];
    const host = fakeHost({ rememberFact: (text, kind) => void written.push({ text, kind }) });
    const data = await rememberThis.handler(
      { text: "Their mother is called Sharada", kind: "relationship" },
      invocation({ host }),
    );
    assert.equal(data["remembered"], true);
    assert.deepEqual(written, [{ text: "Their mother is called Sharada", kind: "relationship" }]);
  });

  it("forget_this reports what it actually forgot", async () => {
    const host = fakeHost({
      forgetFacts: async () => ({ forgotten: 1, texts: ["They dislike cardamom"] }),
    });
    const data = await forgetThis.handler({ subject: "cardamom" }, invocation({ host }));
    assert.equal(data["forgotten"], 1);
  });

  it("forget_this says plainly when nothing matched", async () => {
    const data = await forgetThis.handler({ subject: "anything" }, invocation());
    assert.equal(data["forgotten"], 0);
    assert.equal(data["reason"], "nothing_matched");
  });

  it("recall returns hits with scores", async () => {
    const host = fakeHost({ recallFacts: async () => [{ text: "They live in Pune", score: 0.8 }] });
    const data = await recall.handler({ query: "where do they live" }, invocation({ host }));
    assert.equal(data["found"], 1);
  });

  it("end_conversation asks, and does not close anything itself", async () => {
    // The farewell has to be spoken first, so the tool only raises the request.
    let asked: string | null = null;
    const host = fakeHost({ requestEnd: (r) => void (asked = r) });
    const data = await endConversation.handler({}, invocation({ host }));
    assert.equal(data["ending"], true);
    assert.equal(asked, "user_said_goodbye");
  });
});
