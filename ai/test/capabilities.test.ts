/**
 * The capability layer.
 *
 * This is the code that decides which tools a given configuration produces, and
 * until now nothing tested it: the composition root's only coverage was a
 * WebSocket handshake. Every assertion here is about the rule the whole layer
 * exists to hold — unconfigured means unregistered means never described to the
 * user.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { registerCapabilities } from "../src/capabilities/register.ts";
import { CAPABILITIES } from "../src/capabilities/catalogue.ts";
import type { Capability, CapabilityReport } from "../src/capabilities/types.ts";
import { testConfig } from "./helpers.ts";

/** A capability that records what it was asked to do. */
function fakeCapability(
  name: string,
  over: Partial<Capability> & { toolName?: string } = {},
): Capability {
  return {
    name,
    isConfigured: over.isConfigured ?? (() => true),
    register:
      over.register ??
      ((registry): CapabilityReport => {
        const toolName = over.toolName ?? `${name}_tool`;
        registry.register({
          name: toolName,
          description: "a test tool",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
          handler: async () => ({ ok: true }),
        });
        return { name, registered: true, tools: [toolName], detail: {} };
      }),
    ...(over.unconfiguredNotice ? { unconfiguredNotice: over.unconfiguredNotice } : {}),
  };
}

describe("capability registration", () => {
  it("skips a capability this deployment has not configured", () => {
    const wiring = registerCapabilities(testConfig(), undefined, [
      fakeCapability("on"),
      fakeCapability("off", { isConfigured: () => false }),
    ]);

    assert.deepEqual(wiring.unconfigured, ["off"]);
    assert.deepEqual(
      wiring.reports.map((r) => r.name),
      ["on"],
    );
    assert.equal(wiring.tools.get("off_tool"), undefined);
  });

  it("never calls register on an unconfigured capability", () => {
    // The rule is about OFFERING, so a capability that cannot be served must not
    // even get the chance to construct a client or open a socket.
    let called = false;
    registerCapabilities(testConfig(), undefined, [
      fakeCapability("off", {
        isConfigured: () => false,
        register: () => {
          called = true;
          return { name: "off", registered: false, tools: [], detail: {} };
        },
      }),
    ]);
    assert.equal(called, false);
  });

  it("keeps going when one capability throws while wiring itself", () => {
    // A malformed calendar URL must not cost somebody their emergency alerting.
    const logged: string[] = [];
    const wiring = registerCapabilities(
      testConfig(),
      (level, msg) => {
        if (level === "error") logged.push(msg);
      },
      [
        fakeCapability("before"),
        fakeCapability("broken", {
          register: () => {
            throw new Error("credential unusable");
          },
        }),
        fakeCapability("after"),
      ],
    );

    assert.ok(wiring.tools.get("before_tool"), "capabilities before the failure survive");
    assert.ok(wiring.tools.get("after_tool"), "capabilities after the failure still register");
    assert.equal(wiring.reports.find((r) => r.name === "broken")?.registered, false);
    assert.ok(logged.some((m) => m.includes("failed to register")));
  });

  it("registers tools in capability order, so the model sees a stable list", () => {
    const wiring = registerCapabilities(testConfig(), undefined, [
      fakeCapability("a"),
      fakeCapability("b"),
      fakeCapability("c"),
    ]);
    assert.deepEqual(
      wiring.tools.all().map((t) => t.name),
      ["a_tool", "b_tool", "c_tool"],
    );
  });

  it("collects contributions a capability makes to every session", () => {
    const wiring = registerCapabilities(testConfig(), undefined, [
      fakeCapability("emergency-ish", {
        register: (_registry, _ctx, contributions): CapabilityReport => {
          // The alerter is the only contribution today; any object proves the
          // channel, and the emergency suite covers the real one.
          contributions.alerter = { contacts: [], names: "" } as never;
          return { name: "emergency-ish", registered: true, tools: [], detail: {} };
        },
      }),
    ]);
    assert.ok(wiring.contributions.alerter, "the contribution reached the wiring");
  });

  it("disposes every capability's timers, even when one disposer throws", () => {
    const stopped: string[] = [];
    const wiring = registerCapabilities(testConfig(), undefined, [
      fakeCapability("first", {
        register: () => ({
          name: "first",
          registered: true,
          tools: [],
          detail: {},
          dispose: () => stopped.push("first"),
        }),
      }),
      fakeCapability("bad", {
        register: () => ({
          name: "bad",
          registered: true,
          tools: [],
          detail: {},
          dispose: () => {
            throw new Error("will not clear");
          },
        }),
      }),
      fakeCapability("last", {
        register: () => ({
          name: "last",
          registered: true,
          tools: [],
          detail: {},
          dispose: () => stopped.push("last"),
        }),
      }),
    ]);

    wiring.dispose();
    // Shutdown is not a place to throw, and one stuck timer is not a reason to
    // leave the rest running.
    assert.deepEqual(stopped, ["first", "last"]);
  });

  it("lets an unconfigured capability still say so", () => {
    const lines: Array<{ level: string; msg: string }> = [];
    registerCapabilities(testConfig(), (level, msg) => lines.push({ level, msg }), [
      fakeCapability("quiet", { isConfigured: () => false }),
      fakeCapability("loud", {
        isConfigured: () => false,
        unconfiguredNotice: () => ({ level: "warn", msg: "loud is off" }),
      }),
    ]);

    assert.deepEqual(lines, [{ level: "warn", msg: "loud is off" }]);
  });
});

describe("the shipped capabilities", () => {
  it("says out loud when emergency alerting is off", () => {
    // REGRESSION. This warning lived in the old registerAlerting's else branch
    // and was lost when capabilities gained an isConfigured gate — an operator
    // who does not see it believes a cry for help will reach somebody.
    const lines: string[] = [];
    registerCapabilities(testConfig(), (_level, msg) => lines.push(msg));
    assert.ok(
      lines.includes("emergency alerting is not configured"),
      `expected the alerting warning, got ${JSON.stringify(lines)}`,
    );
  });

  it("gives a bare configuration the tools that need nothing", () => {
    const wiring = registerCapabilities(testConfig());
    const names = wiring.tools.all().map((t) => t.name);

    // Core and games need no key, no URL and no network, so a fresh clone has a
    // working companion. See tools/builtin.ts.
    assert.ok(names.includes("get_time"));
    assert.ok(names.includes("repeat_that"));
    assert.ok(names.includes("start_game"));
  });

  it("offers nothing external until it is configured", () => {
    const wiring = registerCapabilities(testConfig());
    const names = wiring.tools.all().map((t) => t.name);

    for (const external of [
      "get_weather",
      "get_news",
      "play_music",
      "get_appointments",
      "raise_alarm",
      "recall_mood",
    ]) {
      assert.ok(!names.includes(external), `${external} must not be offered unconfigured`);
    }
    assert.deepEqual(wiring.contributions.alerter, undefined);
  });

  it("registers the weather only where it is enabled", () => {
    const off = registerCapabilities(testConfig());
    assert.equal(off.tools.get("get_weather"), undefined);

    const on = registerCapabilities(testConfig({ weather: { enabled: true } }));
    assert.ok(on.tools.get("get_weather"));
    assert.equal(on.reports.find((r) => r.name === "weather")?.detail["weather"], true);
  });

  it("registers news only for categories with a usable feed", () => {
    const wiring = registerCapabilities(
      testConfig({
        news: {
          feeds: { top: "https://example.invalid/top.rss", sports: "not-a-url" },
        },
      }),
    );

    assert.ok(wiring.tools.get("get_news"));
    // `sports` had a value, but not one that parses as http(s) — it is dropped
    // rather than reaching the model as an enum value it would get nothing from.
    assert.deepEqual(wiring.reports.find((r) => r.name === "news")?.detail["news"], ["top"]);
  });

  it("does not register news when every configured feed is unusable", () => {
    const wiring = registerCapabilities(
      testConfig({ news: { feeds: { top: "file:///etc/passwd" } } }),
    );

    assert.equal(wiring.tools.get("get_news"), undefined);
    assert.equal(wiring.reports.find((r) => r.name === "news")?.registered, false);
  });

  it("refuses emergency alerting that is only half configured", () => {
    // Contacts with no relay would recognise "help" and have nowhere to send it.
    // The companion would say help is coming when nothing is.
    const wiring = registerCapabilities(
      testConfig({ emergency: { contacts: "Harsh=harsh@example.com" } }),
    );

    assert.equal(wiring.tools.get("raise_alarm"), undefined);
    assert.equal(wiring.contributions.alerter, undefined);
    assert.equal(wiring.reports.find((r) => r.name === "emergency")?.registered, false);
  });

  it("arms emergency alerting once both halves are present", () => {
    const wiring = registerCapabilities(
      testConfig({
        emergency: { contacts: "Harsh=harsh@example.com,aman@example.com" },
        mail: {
          transport: "smtp",
          // Every field, because ConfigOverride merges only one level down —
          // `smtp` is replaced wholesale, not merged into.
          smtp: {
            host: "smtp.example.invalid",
            port: 465,
            security: "tls",
            user: null,
            pass: null,
            from: "companion@example.invalid",
          },
        },
      }),
    );

    assert.ok(wiring.tools.get("raise_alarm"));
    assert.ok(wiring.contributions.alerter, "the session needs this for the local phrase matcher");
    assert.deepEqual(wiring.reports.find((r) => r.name === "emergency")?.detail["emergency"], [
      "Harsh",
      "Aman",
    ]);
  });

  it("registers a calendar from an iCal feed with no credential at all", () => {
    const wiring = registerCapabilities(
      testConfig({ calendar: { feeds: { mine: "https://example.invalid/basic.ics" } } }),
    );

    assert.ok(wiring.tools.get("get_appointments"));
    // Read-only: writing needs a Google credential, an id, and a named target.
    assert.equal(wiring.tools.get("add_appointment"), undefined);
    assert.equal(
      wiring.reports.find((r) => r.name === "calendar")?.detail["calendar_writable"],
      false,
    );
  });

  it("stops the music catalogue timer on dispose", () => {
    const wiring = registerCapabilities(
      testConfig({ music: { enabled: true, radioApi: "https://127.0.0.1:9/unreachable" } }),
    );

    assert.ok(wiring.tools.get("play_music"));
    assert.ok(
      wiring.reports.find((r) => r.name === "music")?.dispose,
      "music owns an interval and must hand back a way to clear it",
    );
    wiring.dispose();
  });

  it("every shipped capability has a unique name", () => {
    const names = CAPABILITIES.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `duplicate capability name in ${names}`);
  });

  it("every shipped capability answers isConfigured without constructing anything", () => {
    // It takes only config on purpose: the boot log can say what is off and why
    // before a single client exists.
    const cfg = testConfig();
    for (const capability of CAPABILITIES) {
      assert.equal(typeof capability.isConfigured(cfg), "boolean", capability.name);
    }
  });
});
