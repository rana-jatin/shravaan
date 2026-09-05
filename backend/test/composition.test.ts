/**
 * The boot log's `external` block.
 *
 * Small, but it is what an operator reads to find out what this deployment
 * actually turned on — and it used to be recomputed from config flags, so it
 * could say a capability was on when its validation had dropped it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CapabilityReport } from "@sp-i/ai/capabilities/types.ts";
import { externalSummary } from "../src/composition/tools.ts";

const report = (name: string, detail: Record<string, unknown>): CapabilityReport => ({
  name,
  registered: true,
  tools: [],
  detail,
});

describe("externalSummary", () => {
  it("keeps the same keys in the same order whatever is configured", () => {
    // An operator comparing two boot logs should be diffing values, not hunting
    // for which keys went missing on the quieter deployment.
    const bare = Object.keys(externalSummary([], { weatherEnabled: false }));
    const full = Object.keys(
      externalSummary([report("weather", { weather: true }), report("news", { news: ["top"] })], {
        weatherEnabled: true,
      }),
    );
    assert.deepEqual(bare, full);
    assert.deepEqual(bare, [
      "music",
      "calendars",
      "calendar_writable",
      "emergency",
      "weather",
      "news",
      "residency",
    ]);
  });

  it("reports everything off when nothing registered", () => {
    const summary = externalSummary([], { weatherEnabled: false });
    assert.equal(summary["music"], false);
    assert.equal(summary["emergency"], false);
    assert.equal(summary["weather"], false);
    assert.deepEqual(summary["calendars"], []);
    assert.deepEqual(summary["news"], []);
  });

  it("takes each value from the capability that reported it", () => {
    const summary = externalSummary(
      [
        report("music", { music: "radio+song" }),
        report("calendar", { calendars: ["mine", "hospital"], calendar_writable: true }),
        report("emergency", { emergency: ["Harsh", "Aman"] }),
      ],
      { weatherEnabled: false },
    );

    assert.equal(summary["music"], "radio+song");
    assert.deepEqual(summary["calendars"], ["mine", "hospital"]);
    assert.equal(summary["calendar_writable"], true);
    assert.deepEqual(summary["emergency"], ["Harsh", "Aman"]);
  });

  it("names the residency trade only where the weather is on", () => {
    // The one hop that is not Sarvam and not in India. Said at boot rather than
    // discovered later — see docs/05-open-questions.md Q14.
    assert.match(
      String(externalSummary([], { weatherEnabled: true })["residency"]),
      /leaves India/,
    );
    assert.equal(externalSummary([], { weatherEnabled: false })["residency"], "all in-India");
  });
});
