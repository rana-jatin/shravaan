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
import { MemoryEscalationStore } from "../escalation/memory-escalation-store.ts";
import type { EscalationStore } from "../escalation/types.ts";
import type { EscalationHandler } from "../escalation/runner.ts";
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
   * EMPTY IS MEANINGFUL: composition reads this to decide whether to start a
   * ticker at all. A timer polling a store for work nobody produces is the kind
   * of wiring that is still running three years later with no one able to say
   * what it does.
   */
  occurrenceHandlers: Map<string, OccurrenceHandler>;
  /**
   * Who climbs the ladder for a reminder nobody answered. Same rule: empty
   * means composition starts no sweep.
   */
  escalationHandlers: Map<string, EscalationHandler>;
  /** Release every capability's timers. Called from the server's shutdown. */
  dispose(): void;
};

const noop: CapabilityLog = () => {};

/**
 * What a deployment chooses, and what it hands the capabilities.
 *
 * AN OPTIONS OBJECT rather than more positional arguments, from the third one
 * onward: `registerCapabilities(cfg, log, CAPABILITIES, schedules, escalations)`
 * is a signature where transposing two stores typechecks and fails at runtime,
 * and there are more seams coming.
 */
export type RegisterOptions = {
  /** Which capabilities this build runs. Defaults to the whole catalogue. */
  capabilities?: readonly Capability[];
  /** Where reminders are written. Defaults to a fresh in-process store. */
  schedules?: ScheduleStore;
  /** Where unanswered reminders live mid-ladder. Same default. */
  escalations?: EscalationStore;
};

export function registerCapabilities(
  cfg: Config,
  log: CapabilityLog = noop,
  opts: RegisterOptions = {},
): CapabilityWiring {
  const capabilities = opts.capabilities ?? CAPABILITIES;
  // Defaulted so a test can call this with a config and nothing else, and so
  // every call gets its OWN stores rather than sharing module-level ones — two
  // servers in one process (backend/test/server.test.ts starts them) must not
  // find each other's reminders. Composition passes the real ones.
  const schedules = opts.schedules ?? new MemoryScheduleStore();
  const escalations = opts.escalations ?? new MemoryEscalationStore();

  const tools = new ToolRegistry();
  const contributions: SessionContributions = {};
  const reports: CapabilityReport[] = [];
  const unconfigured: string[] = [];
  const disposers: Array<() => void> = [];
  const occurrenceHandlers = new Map<string, OccurrenceHandler>();
  const escalationHandlers = new Map<string, EscalationHandler>();

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
      const report = capability.register(
        tools,
        { cfg, log, schedules, escalations },
        contributions,
      );
      reports.push(report);
      if (report.dispose) disposers.push(report.dispose);
      if (report.onOccurrence) occurrenceHandlers.set(report.name, report.onOccurrence);
      if (report.escalation) escalationHandlers.set(report.name, report.escalation);
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
    occurrenceHandlers,
    escalationHandlers,
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
