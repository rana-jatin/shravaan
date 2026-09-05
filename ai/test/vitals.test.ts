/**
 * Vitals — the parse, the seam, and the sentence the device must never say.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MOST OF THIS FILE IS ABOUT ABSENCE, which is unusual for a test suite and is
 * the point of this capability. The risky version of "vitals logging" is not
 * one that fails to store a number; it is one that stores it and then has an
 * opinion about it. So the assertions that matter are that a tool result
 * carries no judgement, that a log line carries no value, and that a reading
 * nobody could have is refused with a reason rather than filed.
 *
 * THE FAHRENHEIT CASE IS NOT AN EDGE CASE. Household thermometers in India are
 * overwhelmingly Fahrenheit, so "ninety-eight point six" is the likeliest
 * temperature this product will ever hear — and as Celsius it is out of range.
 * Without the conversion the commonest reading would be the one that fails.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expandStored,
  parseReading,
  toWirePayload,
  VITALS,
  type StoredVital,
} from "../src/domain/vitals.ts";
import { ElderguardClient } from "../src/providers/elderguard.ts";
import { createLogVital, createRecentVitals } from "../src/tools/vitals.ts";
import { vitalsCapability } from "../src/capabilities/vitals.ts";
import { registerCapabilities } from "../src/capabilities/register.ts";
import { invocation, testConfig } from "./helpers.ts";
import type { HttpFetch } from "@sp-i/shared/providers/http.ts";

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

describe("reading what somebody said", () => {
  it("takes an ordinary pulse", () => {
    const result = parseReading({ kind: "heart_rate", value: 72 });
    assert.deepEqual(result, { ok: true, reading: { kind: "heart_rate", value: 72 } });
  });

  it("takes a number the model passed as a string", () => {
    // Sarvam has handed back `"72"` for a number-typed parameter. The tool must
    // not turn that into "I couldn't understand that".
    const result = parseReading({ kind: "heart_rate", value: "72" });
    assert.equal(result.ok && result.reading.value, 72);
  });

  it("converts a Fahrenheit temperature", () => {
    const result = parseReading({ kind: "temperature", value: 98.6, unit: "f" });
    assert.ok(result.ok);
    assert.equal(result.reading.value, 37);
  });

  it("refuses 98.6 read as Celsius, rather than storing a fever nobody has", () => {
    const result = parseReading({ kind: "temperature", value: 98.6 });
    assert.deepEqual(result, { ok: false, reason: "implausible", kind: "temperature" });
  });

  it("needs both halves of a blood pressure", () => {
    const result = parseReading({ kind: "blood_pressure", value: 140 });
    assert.deepEqual(result, {
      ok: false,
      reason: "needs_both_pressures",
      kind: "blood_pressure",
    });
  });

  it("names a blood pressure said the wrong way round instead of swapping it", () => {
    // Swapping would store a reading nobody said. Naming it lets the device ask.
    const result = parseReading({ kind: "blood_pressure", value: 80, second: 140 });
    assert.deepEqual(result, {
      ok: false,
      reason: "pressures_inverted",
      kind: "blood_pressure",
    });
  });

  it("refuses a metric it does not know", () => {
    assert.deepEqual(parseReading({ kind: "cholesterol", value: 200 }), {
      ok: false,
      reason: "unknown_kind",
    });
  });

  it("refuses something that is not a number at all", () => {
    assert.deepEqual(parseReading({ kind: "glucose", value: "a bit high" }), {
      ok: false,
      reason: "not_a_number",
      kind: "glucose",
    });
  });

  it("refuses a glucose reading in the wrong unit", () => {
    // 7.2 mmol/L is an ordinary reading and a nonsensical mg/dL one. Refusing
    // is right: storing 7.2 mg/dL would look like a medical emergency.
    assert.equal(parseReading({ kind: "glucose", value: 7.2 }).ok, false);
  });

  it("keeps the bounds and the safety service's ingest limits in agreement", () => {
    // Not a tautology: these numbers are duplicated across a language boundary
    // on purpose, so that a value which would bounce off the API is refused
    // here with a reason the device can SAY. If they drift, the failure is a
    // round trip that ends in an apology.
    assert.deepEqual(VITALS.heart_rate, { unit: "bpm", min: 20, max: 250 });
    assert.deepEqual(VITALS.spo2, { unit: "%", min: 50, max: 100 });
    assert.equal(VITALS.temperature.min, 25);
    assert.equal(VITALS.temperature.max, 45);
    assert.equal(VITALS.glucose.min, 20);
    assert.equal(VITALS.glucose.max, 700);
  });

  it("carries the glucose context as a token", () => {
    const result = parseReading({ kind: "glucose", value: 126, context: "fasting" });
    assert.equal(result.ok && result.reading.context, "fasting");
    assert.deepEqual(toWirePayload({ kind: "glucose", value: 126, context: "fasting" }), {
      glucose_mgdl: 126,
      glucose_context: "fasting",
    });
  });

  it("treats anything else said about a sugar reading as unspecified", () => {
    const result = parseReading({
      kind: "glucose",
      value: 126,
      context: "after her second cup of tea",
    });
    assert.equal(result.ok && result.reading.context, "unspecified");
  });
});

describe("reading back what is on file", () => {
  const row = (over: Partial<StoredVital>): StoredVital => ({
    recorded_at: "2026-09-01T09:00:00Z",
    heart_rate_bpm: null,
    spo2_percent: null,
    temperature_c: null,
    systolic_mmhg: null,
    diastolic_mmhg: null,
    glucose_mgdl: null,
    source: "device",
    ...over,
  });

  it("expands one row into every reading it holds", () => {
    // A band reports a pulse and an oxygen level in the same frame, and asking
    // for a blood pressure should not return the row it shared space with.
    const readings = expandStored([row({ heart_rate_bpm: 72, spo2_percent: 97 })]);
    assert.deepEqual(
      readings.map((r) => r.kind),
      ["heart_rate", "spo2"],
    );
  });

  it("keeps a blood pressure as one reading with two numbers", () => {
    const readings = expandStored([row({ systolic_mmhg: 138, diastolic_mmhg: 84 })]);
    assert.equal(readings.length, 1);
    assert.deepEqual(
      { v: readings[0]!.value, s: readings[0]!.second, u: readings[0]!.unit },
      { v: 138, s: 84, u: "mmHg" },
    );
  });

  it("carries how the reading got there", () => {
    // "You told me" and "your band measured" are not the same sentence to say.
    const readings = expandStored([row({ glucose_mgdl: 126, source: "self_reported" })]);
    assert.equal(readings[0]!.source, "self_reported");
  });
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

type Call = { url: string; init: Parameters<HttpFetch>[1] };

function fakeService(responses: Array<{ status: number; body?: unknown }>): {
  fetch: HttpFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
    };
  };
  return { fetch, calls };
}

function client(fetch: HttpFetch): ElderguardClient {
  return new ElderguardClient({
    apiBase: "http://safety.local/api/v1/",
    apiKey: "k",
    fetch,
  });
}

describe("the safety service client", () => {
  it("presents the key and trims the trailing slash off the base", async () => {
    const { fetch, calls } = fakeService([{ status: 201, body: { stored: true, alerted: false } }]);
    await client(fetch).record("u1", { kind: "heart_rate", value: 72 });

    assert.equal(calls[0]!.url, "http://safety.local/api/v1/companion/vitals/u1");
    assert.equal(calls[0]!.init?.headers?.["x-companion-key"], "k");
    assert.equal(calls[0]!.init?.method, "POST");
  });

  it("reports a person with no paired device as data, not as a failure", async () => {
    // A domain outcome: the device says it cannot keep the number, which is a
    // poor answer and an honest one. `ok: false` on the tool would cost a
    // spoken_fallback_key and eleven translations to say the same thing worse.
    const { fetch } = fakeService([{ status: 409, body: { detail: "no device" } }]);
    assert.deepEqual(await client(fetch).record("u1", { kind: "glucose", value: 126 }), {
      ok: false,
      reason: "not_paired",
    });
  });

  it("reports a uid the service has never heard of as data", async () => {
    const { fetch } = fakeService([{ status: 404, body: { detail: "no such user" } }]);
    assert.deepEqual(await client(fetch).record("u1", { kind: "glucose", value: 126 }), {
      ok: false,
      reason: "unknown_user",
    });
  });

  it("throws on a genuine server failure", async () => {
    // The one thing that IS infrastructure. It reaches the executor as
    // upstream_error and is spoken as the reviewed tool.unavailable copy.
    const { fetch } = fakeService([{ status: 503 }]);
    await assert.rejects(
      () => client(fetch).record("u1", { kind: "glucose", value: 126 }),
      /HTTP 503/,
    );
  });

  it("reads back nothing for an unknown person rather than throwing", async () => {
    const { fetch } = fakeService([{ status: 404, body: { detail: "no such user" } }]);
    assert.deepEqual(await client(fetch).recent("u1", 5), []);
  });

  it("returns null context rather than failing a session that cannot reach it", async () => {
    // Context is an enrichment. Somebody whose safety service is down should
    // still be able to have a conversation.
    const { fetch } = fakeService([{ status: 500 }]);
    assert.equal(await client(fetch).context("u1"), null);
  });

  it("maps context onto the shape the session expects", async () => {
    const { fetch } = fakeService([
      {
        status: 200,
        body: {
          uid: "u1",
          fetched_at: "2026-09-01T09:00:00Z",
          identity: { display_name: "Kamala", timezone: "Asia/Kolkata" },
          entitlements: [],
        },
      },
    ]);
    const ctx = await client(fetch).context("u1");
    assert.equal(ctx?.identity.display_name, "Kamala");
    assert.equal(ctx?.identity.timezone, "Asia/Kolkata");
  });

  it("swallows a 404 when settling an alert somebody else already dealt with", async () => {
    const { fetch } = fakeService([{ status: 404, body: { detail: "gone" } }]);
    await client(fetch).settle("u1", "a1", "acknowledged");
  });
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

describe("log_vital", () => {
  it("stores a reading and reports only the number back", async () => {
    const recorded: unknown[] = [];
    const tool = createLogVital({
      sink: {
        record: async (_uid, reading) => {
          recorded.push(reading);
          return { ok: true, alerted: false };
        },
        recent: async () => [],
      },
    });

    const result = await tool.handler(
      { kind: "blood_pressure", value: 138, second: 84 },
      invocation(),
    );

    assert.deepEqual(recorded, [{ kind: "blood_pressure", value: 138, second: 84 }]);
    assert.deepEqual(result, { logged: true, kind: "blood_pressure", value: 138, second: 84 });
  });

  it("says nothing about whether a reading is high, low or normal", async () => {
    // THE ASSERTION THIS WHOLE CAPABILITY EXISTS TO PROTECT. Anything in a tool
    // result is handed to a language model and spoken aloud to an elderly
    // person within the same turn, so a field called `high` or `severity` or
    // `note` is medical advice with extra steps.
    const tool = createLogVital({
      sink: { record: async () => ({ ok: true, alerted: true }), recent: async () => [] },
    });

    const result = await tool.handler({ kind: "heart_rate", value: 195 }, invocation());

    assert.deepEqual(Object.keys(result).sort(), ["kind", "logged", "value"]);
    const rendered = JSON.stringify(result).toLowerCase();
    for (const word of ["high", "low", "normal", "alert", "concern", "abnormal", "danger"]) {
      assert.ok(!rendered.includes(word), `tool result mentioned "${word}"`);
    }
  });

  it("tells the capability it alerted without telling the model", async () => {
    const alerted: string[] = [];
    const tool = createLogVital({
      sink: { record: async () => ({ ok: true, alerted: true }), recent: async () => [] },
      onAlerted: (uid) => alerted.push(uid),
    });

    const result = await tool.handler({ kind: "heart_rate", value: 195 }, invocation());

    assert.deepEqual(alerted, ["u1"]);
    assert.equal("alerted" in result, false);
  });

  it("never puts the value in a log line", async () => {
    // The metric is operational; the number is the whole of what makes this a
    // health record. Same rule the medication label follows.
    const lines: Array<Record<string, unknown> | undefined> = [];
    const tool = createLogVital({
      sink: { record: async () => ({ ok: true, alerted: false }), recent: async () => [] },
      log: (_level, _msg, extra) => lines.push(extra),
    });

    await tool.handler({ kind: "glucose", value: 126 }, invocation());

    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { uid: "u1", kind: "glucose" });
    assert.ok(!JSON.stringify(lines).includes("126"));
  });

  it("refuses an implausible reading before it reaches the network", async () => {
    let called = false;
    const tool = createLogVital({
      sink: {
        record: async () => {
          called = true;
          return { ok: true, alerted: false };
        },
        recent: async () => [],
      },
    });

    const result = await tool.handler({ kind: "heart_rate", value: 900 }, invocation());

    assert.deepEqual(result, { logged: false, reason: "implausible", kind: "heart_rate" });
    assert.equal(called, false);
  });

  it("reports an unstorable reading as data rather than throwing", async () => {
    const tool = createLogVital({
      sink: {
        record: async () => ({ ok: false as const, reason: "not_paired" as const }),
        recent: async () => [],
      },
    });

    const result = await tool.handler({ kind: "glucose", value: 126 }, invocation());
    assert.deepEqual(result, { logged: false, reason: "not_paired", kind: "glucose" });
  });
});

describe("recent_vitals", () => {
  const rows: StoredVital[] = [
    {
      recorded_at: "2026-09-02T09:00:00Z",
      heart_rate_bpm: 74,
      spo2_percent: 97,
      temperature_c: null,
      systolic_mmhg: null,
      diastolic_mmhg: null,
      glucose_mgdl: null,
      source: "device",
    },
    {
      recorded_at: "2026-09-01T09:00:00Z",
      heart_rate_bpm: null,
      spo2_percent: null,
      temperature_c: null,
      systolic_mmhg: 138,
      diastolic_mmhg: 84,
      glucose_mgdl: null,
      source: "self_reported",
    },
  ];

  it("narrows to one kind across rows that hold several", async () => {
    const tool = createRecentVitals({
      sink: { record: async () => ({ ok: true, alerted: false }), recent: async () => rows },
    });

    const result = await tool.handler({ kind: "blood_pressure" }, invocation());
    assert.equal(result["found"], 1);
    assert.deepEqual(result["readings"], [
      {
        kind: "blood_pressure",
        value: 138,
        second: 84,
        unit: "mmHg",
        at: "2026-09-01T09:00:00Z",
        source: "self_reported",
      },
    ]);
  });

  it("over-fetches so a filter cannot starve the answer", async () => {
    // One row can hold several metrics. Asking the service for exactly `limit`
    // rows and then filtering would return two blood pressures out of five.
    const asked: number[] = [];
    const tool = createRecentVitals({
      sink: {
        record: async () => ({ ok: true, alerted: false }),
        recent: async (_uid, limit) => {
          asked.push(limit);
          return rows;
        },
      },
    });

    await tool.handler({ kind: "blood_pressure", limit: 5 }, invocation());
    assert.deepEqual(asked, [20]);
  });

  it("answers an empty history rather than failing", async () => {
    const tool = createRecentVitals({
      sink: { record: async () => ({ ok: true, alerted: false }), recent: async () => [] },
    });

    const result = await tool.handler({}, invocation());
    assert.deepEqual(result, { found: 0, readings: [] });
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("the vitals capability", () => {
  it("is off unless both the base and the key are set", () => {
    assert.equal(vitalsCapability.isConfigured(testConfig()), false);
    assert.equal(
      vitalsCapability.isConfigured(
        testConfig({ vitals: { apiBase: "http://safety.local/api/v1" } }),
      ),
      false,
    );
    assert.equal(vitalsCapability.isConfigured(testConfig({ vitals: { apiKey: "k" } })), false);
    assert.equal(
      vitalsCapability.isConfigured(
        testConfig({ vitals: { apiBase: "http://safety.local/api/v1", apiKey: "k" } }),
      ),
      true,
    );
  });

  it("registers nothing at all when unconfigured", () => {
    const wiring = registerCapabilities(testConfig(), () => {}, {
      capabilities: [vitalsCapability],
    });
    assert.deepEqual(wiring.tools.all(), []);
    assert.deepEqual(wiring.unconfigured, ["vitals"]);
  });

  it("registers both tools when configured", () => {
    const wiring = registerCapabilities(
      testConfig({ vitals: { apiBase: "http://safety.local/api/v1", apiKey: "k" } }),
      () => {},
      { capabilities: [vitalsCapability] },
    );
    assert.deepEqual(
      wiring.tools.all().map((t) => t.name),
      ["log_vital", "recent_vitals"],
    );
  });

  it("refuses a base URL that is not http, and says so at ERROR", () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const wiring = registerCapabilities(
      testConfig({ vitals: { apiBase: "safety.local:8000", apiKey: "k" } }),
      (level, msg) => lines.push({ level, msg }),
      { capabilities: [vitalsCapability] },
    );

    assert.deepEqual(wiring.tools.all(), []);
    assert.equal(lines[0]!.level, "error");
    assert.match(lines[0]!.msg, /VITALS_API_BASE/);
  });

  it("never logs the key, even redacted", () => {
    const lines: unknown[] = [];
    registerCapabilities(
      testConfig({ vitals: { apiBase: "http://safety.local/api/v1", apiKey: "s3cret" } }),
      (_level, _msg, extra) => lines.push(extra),
      { capabilities: [vitalsCapability] },
    );
    assert.ok(!JSON.stringify(lines).includes("s3cret"));
  });
});
