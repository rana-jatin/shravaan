/**
 * Running the capability list.
 *
 * Mechanism, not policy — which is why it lives here rather than in
 * `backend/composition/`. What a deployment chooses is the LIST it passes
 * (defaulting to `CAPABILITIES`); how that list is walked, what happens when
 * one of them throws, and who owns the timers afterwards is the same everywhere.
 *
 * Keeping it here also means it is testable with `testConfig()` next door,
 * instead of needing a booted server — the composition root had two tests
 * covering a WebSocket handshake and nothing covering which tools a given
 * configuration actually produces.
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { MemoryScheduleStore } from "../scheduler/memory-schedule-store.ts";
import type { ScheduleStore } from "../scheduler/types.ts";
import type { OccurrenceHandler } from "../scheduler/ticker.ts";
import { CAPABILITIES } from "./catalogue.ts";
import type { Capability, CapabilityLog, CapabilityReport, SessionContributions } from "./types.ts";

export type CapabilityWiring = {
  tools: ToolRegistry;
  /** One per capability that was configured, in registration order. */
  reports: CapabilityReport[];
  /** What the capabilities give every Session, beyond tools. */
  contributions: SessionContributions;
  /** Capabilities skipped because this deployment did not configure them. */
  unconfigured: string[];
  /**
   * Who to hand a due schedule to, keyed by capability name.
   *
   * EMPTY IS MEANINGFUL: no capability schedules anything yet, and composition
   * reads this to decide whether to start a ticker at all. A timer polling a
   * store for work nobody produces is the kind of wiring that is still running
   * three years later with no one able to say what it does.
   */
  handlers: Map<string, OccurrenceHandler>;
  /** Release every capability's timers. Called from the server's shutdown. */
  dispose(): void;
};

const noop: CapabilityLog = () => {};

export function registerCapabilities(
  cfg: Config,
  log: CapabilityLog = noop,
  capabilities: readonly Capability[] = CAPABILITIES,
  // Defaulted so a test can call this with a config and nothing else, and so
  // every call gets its own store rather than sharing a module-level one.
  // Composition passes the real one; see backend/src/composition/scheduler.ts.
  schedules: ScheduleStore = new MemoryScheduleStore(),
): CapabilityWiring {
  const tools = new ToolRegistry();
  const contributions: SessionContributions = {};
  const reports: CapabilityReport[] = [];
  const unconfigured: string[] = [];
  const disposers: Array<() => void> = [];
  const handlers = new Map<string, OccurrenceHandler>();

  for (const capability of capabilities) {
    if (!capability.isConfigured(cfg)) {
      unconfigured.push(capability.name);
      // Most capabilities go quiet here. Emergency alerting does not — see
      // `unconfiguredNotice` in ./types.ts.
      const notice = capability.unconfiguredNotice?.(cfg);
      if (notice) log(notice.level, notice.msg, notice.extra);
      continue;
    }

    // A capability that throws while wiring itself must not take the server
    // with it. A companion that starts without the weather is a companion; one
    // that will not start is not. The alternative — letting it propagate — means
    // a malformed calendar URL costs somebody their emergency alerting too.
    try {
      const report = capability.register(tools, { cfg, log, schedules }, contributions);
      reports.push(report);
      if (report.dispose) disposers.push(report.dispose);
      if (report.onOccurrence) handlers.set(report.name, report.onOccurrence);
    } catch (err) {
      log("error", "capability failed to register — continuing without it", {
        capability: capability.name,
        err: err instanceof Error ? err.message : String(err),
      });
      reports.push({ name: capability.name, registered: false, tools: [], detail: {} });
    }
  }

  return {
    tools,
    reports,
    contributions,
    unconfigured,
    handlers,
    dispose() {
      for (const stop of disposers) {
        try {
          stop();
        } catch {
          // Shutdown is not a place to throw. A timer that will not clear is
          // not a reason to leave the rest of them running.
        }
      }
    },
  };
}
