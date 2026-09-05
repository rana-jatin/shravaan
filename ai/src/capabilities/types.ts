/**
 * What a capability is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES. Adding a capability used to mean editing a shared
 * file. `registerTools` in backend/composition/tools.ts held ninety lines of
 * `if (cfg.x.enabled) { ... }` for six unrelated features, plus a refresh timer
 * belonging to one of them; calendars and alerting had escaped into modules of
 * their own but with three different function shapes between them. Nothing was
 * wrong with any single branch. The shape was the problem: six features in one
 * function, and a seventh means a seventh edit to it.
 *
 * Medication reminders, daily check-ins and vitals are three more. So a
 * capability is now a DIRECTORY, and `CAPABILITIES` in ./index.ts is a list.
 * Adding one is adding a file and a line; it is not touching anyone else's.
 *
 * WHY THESE LIVE IN `ai/` AND NOT `backend/composition/`. A capability builds
 * its own providers — a radio catalogue, a Google client, a mail sender — and
 * those all live in `ai/`. `backend/composition/` keeps the job it actually
 * has: choosing WHICH capabilities this deployment runs and handing them the
 * seams (the logger today; a clock and an HttpFetch when they are needed).
 * `orchestrator/` still depends on interfaces and never on a concrete provider,
 * which is the part of the layering rule that carries weight.
 *
 * WHAT HAS NOT CHANGED, AND MUST NOT. Unconfigured means unregistered means
 * never described to the user. `isConfigured` is that rule with a name — an
 * agent that offers the weather and then cannot fetch it is worse than one that
 * never mentioned it. See tools/registry.ts `offerableTo`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { EmergencyAlerter } from "../tools/emergency.ts";
import type { ScheduleStore } from "../scheduler/types.ts";
import type { OccurrenceHandler } from "../scheduler/ticker.ts";
import type { EscalationStore } from "../escalation/types.ts";
import type { EscalationHandler } from "../escalation/runner.ts";

/** Structurally the logger `backend/server.ts` builds and hands down. */
export type CapabilityLog = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export type CapabilityContext = {
  cfg: Config;
  log: CapabilityLog;
  /**
   * Where a capability writes the reminders it wants back later.
   *
   * A SEAM, NOT A DEPENDENCY ON REDIS: composition decides whether this is the
   * in-process store or the durable one, and a capability that schedules a
   * medication is written the same way either side of that choice.
   */
  schedules: ScheduleStore;
  /**
   * Where a reminder waits while nobody has answered it.
   *
   * A capability needs this to CLOSE a ladder — `acknowledgeOpen` takes the
   * store, not the runner, precisely so a tool can say "they confirmed it"
   * without the capability and the runner holding each other.
   */
  escalations: EscalationStore;
};

/**
 * What a capability gives every Session, beyond its tools.
 *
 * Typed and explicit rather than a bag of unknowns. Only emergency uses it
 * today: `Session` takes the alerter directly because the LOCAL phrase matcher
 * runs before any tool round — "help help" must not wait on the model.
 *
 * Medication and check-ins will contribute here too, when they need a way to
 * reach a live conversation. Adding a field is the whole cost of that.
 */
export type SessionContributions = {
  alerter?: EmergencyAlerter;
};

/**
 * What a capability did, for the boot log.
 *
 * `detail` is merged into the log's `external` block verbatim, so a capability
 * decides what an operator is told about it rather than server.ts guessing from
 * six config flags. Empty for the ones with nothing to report.
 */
export type CapabilityReport = {
  name: string;
  /** True where tools were actually registered, not merely where they could be. */
  registered: boolean;
  tools: string[];
  detail: Record<string, unknown>;

  /**
   * Timers and clients to release on shutdown.
   *
   * RETURNED FROM `register`, NOT A METHOD ON THE CAPABILITY, and that is not a
   * style choice. A `Capability` is a module-level singleton in `CAPABILITIES`,
   * so anything it held as its own field would be shared by every registration
   * in the process — and `backend/test/server.test.ts` starts a server, which
   * means two of them can exist at once. Keeping the state in the closure
   * `register` creates means each wiring disposes of its own.
   */
  dispose?: () => void;

  /**
   * Called when one of this capability's schedules comes due.
   *
   * Matched to `Schedule.capability` by name, which is why a schedule stores a
   * name and not a function: it outlives the process that created it. A build
   * that no longer runs the capability simply has no handler, and the ticker
   * says so once rather than dispatching into nothing.
   *
   * ON THE REPORT rather than on the Capability for the same reason `dispose`
   * is: a Capability is a module-level singleton, and a handler closing over
   * one registration's state must not be shared with another registration in
   * the same process.
   */
  onOccurrence?: OccurrenceHandler;

  /**
   * How this capability speaks and escalates a reminder nobody answered.
   *
   * SEPARATE FROM `onOccurrence` because they answer different questions.
   * `onOccurrence` is "a schedule came due, do something about it" and runs
   * once. This is "it is still unanswered, what now" and runs on every sweep
   * until the ladder ends. A capability may want either without the other: a
   * hydration prompt is worth saying and not worth escalating.
   */
  escalation?: EscalationHandler;
};

/**
 * Jobs a capability wants run on a clock.
 *
 * DECLARED NOW, RUN BY NOBODY YET. The scheduler is the next phase of this
 * refactor, and medication reminders, daily check-ins and hydration prompts are
 * all the same machine wearing different copy. Naming the seam here means those
 * capabilities can be written against a contract that already exists instead of
 * inventing three of them.
 *
 * `music` is the closest thing to a live example: it refreshes its catalogue on
 * an interval today, with its own `setInterval` — see the note in its dispose().
 */
export type ScheduledJob = {
  name: string;
  /** Minutes between runs. A cron expression is not needed by anything yet. */
  everyMinutes: number;
  run(): Promise<void>;
};

export type Capability = {
  name: string;

  /**
   * Can this deployment actually serve it?
   *
   * Pure, and takes only config, so the boot log can say what is off and why
   * without anything having been constructed.
   */
  isConfigured(cfg: Config): boolean;

  /**
   * Register tools and build whatever they need.
   *
   * Called ONLY when `isConfigured` returned true. A capability may still find
   * its config unusable at this point — a feed URL that is not http, a
   * credential that will not parse — and report `registered: false` after
   * saying so in the log.
   */
  register(
    registry: ToolRegistry,
    ctx: CapabilityContext,
    contributions: SessionContributions,
  ): CapabilityReport;

  /**
   * What the operator is told when this capability is NOT configured.
   *
   * Most capabilities say nothing — an absent weather tool is not news.
   * Emergency alerting is the exception and is the reason this exists: silence
   * there means nobody learns that a call for help will be treated as an
   * ordinary turn.
   *
   * A capability owns what is said about it when it is off, for the same reason
   * it owns what is said when it is on. Returning null is the default.
   */
  unconfiguredNotice?(cfg: Config): CapabilityNotice | null;
};

export type CapabilityNotice = {
  level: "info" | "warn" | "error";
  msg: string;
  extra?: Record<string, unknown>;
};

/** For a capability that registers nothing when unconfigured. */
export function notRegistered(
  name: string,
  detail: Record<string, unknown> = {},
): CapabilityReport {
  return { name, registered: false, tools: [], detail };
}
