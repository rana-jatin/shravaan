/**
 * What the composition root decides, and what it says about it.
 *
 * The boot log's `external` block is small, but it is what an operator reads to
 * find out what this deployment actually turned on — and it used to be
 * recomputed from config flags, so it could say a capability was on when its
 * validation had dropped it.
 *
 * The scheduler block below is here for the opposite reason: to pin that this
 * build starts NOTHING, because no capability schedules anything yet.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig, type Config } from "@sp-i/shared/config/env.ts";
import type { CapabilityReport } from "@sp-i/ai/capabilities/types.ts";
import { MemoryScheduleStore } from "@sp-i/ai/scheduler/memory-schedule-store.ts";
import { RedisScheduleStore } from "@sp-i/ai/scheduler/redis-schedule-store.ts";
import type { OccurrenceHandler } from "@sp-i/ai/scheduler/ticker.ts";
import { MemoryEscalationStore } from "@sp-i/ai/escalation/memory-escalation-store.ts";
import { RedisEscalationStore } from "@sp-i/ai/escalation/redis-escalation-store.ts";
import type { EscalationHandler } from "@sp-i/ai/escalation/runner.ts";
import { DEFAULT_LADDER } from "@sp-i/ai/escalation/types.ts";
import { externalSummary } from "../src/composition/tools.ts";
import { buildScheduleStore, startScheduler } from "../src/composition/scheduler.ts";
import { buildEscalationStore, startEscalationRunner } from "../src/composition/escalation.ts";

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

/**
 * A real Config with one field steered, the same way ai/test/helpers.ts does
 * it. Never a cast — a renamed field has to fail here and not at runtime.
 */
function config(redisUrl: string | null): Config {
  const saved = process.env;
  try {
    process.env = { SARVAM_API_KEY: "test-key-never-used-no-sockets-are-opened" };
    return { ...loadConfig(), redisUrl };
  } finally {
    process.env = saved;
  }
}

const lines: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
const log = (level: string, msg: string, extra?: Record<string, unknown>): void => {
  lines.push({ level, msg, ...(extra ? { extra } : {}) });
};

describe("buildScheduleStore", () => {
  it("keeps reminders in process when there is no REDIS_URL", () => {
    assert.ok(buildScheduleStore(config(null)) instanceof MemoryScheduleStore);
  });

  it("uses Redis when there is one, without connecting to find out", async () => {
    // The client is lazy, so building this costs nothing in a deployment where
    // no capability ever writes a schedule. The port below is deliberately not
    // listening: if construction dialled out, this test would hang or throw.
    const store = buildScheduleStore(config("redis://127.0.0.1:6399/0"));
    assert.ok(store instanceof RedisScheduleStore);
    await store.close?.();
  });
});

describe("startScheduler", () => {
  it("starts nothing, and says nothing, when no capability handles occurrences", async () => {
    // Today's real state. A timer polling a store for work nobody produces is
    // the kind of wiring still running three years later with nobody able to
    // say what it does — and a boot line claiming a scheduler this build has
    // not got is worse than no line at all.
    lines.length = 0;
    const store = new MemoryScheduleStore();
    const handle = startScheduler(config(null), log, store, new Map());

    assert.equal(handle.ticker, null);
    assert.deepEqual(lines, []);
    await handle.stop();
  });

  it("starts one as soon as something would answer it", async () => {
    lines.length = 0;
    const handlers = new Map<string, OccurrenceHandler>([["medication", () => {}]]);
    const handle = startScheduler(config(null), log, new MemoryScheduleStore(), handlers);

    assert.equal(handle.ticker?.running, true);
    assert.deepEqual(lines[0]?.extra?.["capabilities"], ["medication"]);

    await handle.stop();
    assert.equal(handle.ticker?.running, false);
  });

  it("warns that in-process reminders do not survive a restart", async () => {
    // A shallow turn window after a restart is a companion with a short memory.
    // A lost medication schedule is a dose nobody is reminded of, so an operator
    // is told which of the two they have chosen.
    lines.length = 0;
    const handlers = new Map<string, OccurrenceHandler>([["medication", () => {}]]);

    const inProcess = startScheduler(config(null), log, new MemoryScheduleStore(), handlers);
    assert.match(String(lines[0]?.extra?.["warning"]), /lost on restart/);
    await inProcess.stop();

    lines.length = 0;
    const durable = startScheduler(
      config("redis://127.0.0.1:6399/0"),
      log,
      new MemoryScheduleStore(),
      handlers,
    );
    assert.equal(lines[0]?.extra?.["warning"], undefined);
    assert.equal(lines[0]?.extra?.["store"], "redis");
    await durable.stop();
  });
});

const ESCALATES: EscalationHandler = {
  ladder: DEFAULT_LADDER,
  speak: async () => ({ spoken: true }),
  notify: async () => ({ delivered: true }),
};

describe("buildEscalationStore", () => {
  it("keeps unanswered reminders in process when there is no REDIS_URL", () => {
    assert.ok(buildEscalationStore(config(null)) instanceof MemoryEscalationStore);
  });

  it("uses Redis when there is one, without connecting to find out", async () => {
    const store = buildEscalationStore(config("redis://127.0.0.1:6399/0"));
    assert.ok(store instanceof RedisEscalationStore);
    await store.close?.();
  });
});

describe("startEscalationRunner", () => {
  it("starts nothing, and says nothing, when no capability escalates", async () => {
    lines.length = 0;
    const handle = startEscalationRunner(config(null), log, new MemoryEscalationStore(), new Map());

    assert.equal(handle.runner, null);
    assert.deepEqual(lines, []);
    await handle.stop();
  });

  it("starts a sweep as soon as something would climb the ladder", async () => {
    lines.length = 0;
    const handle = startEscalationRunner(
      config("redis://127.0.0.1:6399/0"),
      log,
      new MemoryEscalationStore(),
      new Map([["medication", ESCALATES]]),
    );

    assert.equal(handle.runner?.running, true);
    assert.deepEqual(lines[0]?.extra?.["capabilities"], ["medication"]);
    assert.equal(lines[0]?.extra?.["store"], "redis");

    await handle.stop();
    assert.equal(handle.runner?.running, false);
  });

  it("calls losing unanswered reminders an error, not a warning", async () => {
    // Louder than the working-memory warning on purpose, and a different
    // sentence: a lost turn window is a shallow companion for a few minutes; a
    // lost ladder is a family call that never happens and is never reported.
    lines.length = 0;
    const handle = startEscalationRunner(
      config(null),
      log,
      new MemoryEscalationStore(),
      new Map([["medication", ESCALATES]]),
    );

    const warning = lines.find((l) => l.msg.includes("do not survive a restart"))!;
    assert.equal(warning.level, "error");
    assert.match(String(warning.extra?.["effect"]), /never confirmed|missed/);

    await handle.stop();
  });
});
