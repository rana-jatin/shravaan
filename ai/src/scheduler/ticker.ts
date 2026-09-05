/**
 * The loop that turns schedules into occurrences and hands them to a capability.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONLY QUESTION THIS FILE REALLY ANSWERS: what happens when the loop falls
 * behind, and the answer is asymmetric on purpose.
 *
 * Told twice, a person takes a second tablet. Told never, they may take it
 * anyway and nobody is woken at three in the morning. Neither is good; only one
 * of them is a dose. So every rule below breaks toward silence:
 *
 *   • A restart does not replay the downtime. `from` starts at now.
 *   • An occurrence older than the staleness horizon is counted and dropped,
 *     not delivered late. A prompt arriving forty minutes after the dose is
 *     competing with the NEXT dose.
 *   • The watermark only ever moves forward, so a clock stepping backwards
 *     closes the window rather than re-opening one already delivered.
 *
 * THERE IS DELIBERATELY NO DUPLICATE-SUPPRESSION SET HERE. Inside one process
 * it would be unreachable: the window is half-open, the watermark is monotonic,
 * and a pass cannot overlap another. Across processes or restarts a set in
 * memory would not help either — that needs per-occurrence state that outlives
 * the process, which is the escalation record, not this loop. Machinery that
 * cannot fire is worse than none: it reads like a guarantee.
 *
 * NONE OF THAT IS ADHERENCE TRACKING, and it matters not to mistake it for
 * some. This ticker does not know or record whether anybody took anything; a
 * dropped occurrence is not a missed dose here, it is a prompt no longer worth
 * saying. Noticing that the eight o'clock dose was never confirmed belongs to
 * the escalation state machine, which persists per-occurrence state and is the
 * thing that would make cross-restart catch-up safe to switch on later.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Occurrence, ScheduleStore } from "./types.ts";
import { dueBetween } from "./occurrences.ts";

/** What a capability does when one of its schedules comes due. */
export type OccurrenceHandler = (occurrence: Occurrence) => Promise<void> | void;

/** Structurally the logger backend/server.ts builds and hands down. */
export type TickerLog = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export type TickerOptions = {
  store: ScheduleStore;
  /** Keyed by `Schedule.capability`. */
  handlers: ReadonlyMap<string, OccurrenceHandler>;
  /**
   * How often to look. A reminder is a wall-clock minute, so this is the worst
   * case by which one is late; it is not a resolution.
   *
   * A pass costs one `all()` plus a re-expansion of every schedule across the
   * days the window spans — roughly two, whatever the window's length — so
   * halving this roughly doubles the CPU and does not change the arithmetic.
   * Unmeasured, and only worth measuring at a scale this product is not at.
   */
  intervalMs?: number;
  /** Older than this and an occurrence is dropped rather than delivered. */
  staleAfterMs?: number;
  now?: () => number;
  log?: TickerLog;
};

export type TickSummary = {
  from: Date;
  to: Date;
  /** Occurrences the schedules produced in the window, before any filtering. */
  due: number;
  dispatched: number;
  stale: number;
  /** Due, but this build has no capability to hand them to. */
  unhandled: number;
  /** A handler threw. Counted, never retried — see the header. */
  failed: number;
};

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Fifteen minutes.
 *
 * Long enough to survive a GC pause, a slow Redis or a closed laptop lid; short
 * enough that a prompt still lands in the same part of the morning. Nothing was
 * measured for the exact number — it is a judgement about when "take your
 * tablet" stops being helpful, and a deployment can change it.
 */
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

export class Ticker {
  readonly #store: ScheduleStore;
  readonly #handlers: ReadonlyMap<string, OccurrenceHandler>;
  readonly #intervalMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  readonly #log: TickerLog;

  #timer: ReturnType<typeof setInterval> | null = null;
  /** The end of the last window covered. Only ever moves forward. */
  #lastTick: number;
  #inFlight = false;

  /** Capability names already complained about, so the log is not a flood. */
  readonly #warned = new Set<string>();

  constructor(opts: TickerOptions) {
    this.#store = opts.store;
    this.#handlers = opts.handlers;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => {});
    this.#lastTick = this.#now();
  }

  start(): void {
    if (this.#timer) return;
    // Reset here rather than only in the constructor: whatever passed between
    // building this and starting it is not a window anybody was listening to.
    this.#lastTick = this.#now();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    // Unreferenced, so a forgotten ticker can never be the reason a process
    // will not exit — the same rule the radio catalogue refresh follows.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /**
   * One pass. Safe to call directly — the in-flight guard below means a manual
   * call and the timer cannot deliver the same occurrence twice.
   *
   * Returns null when the pass did not happen: another was still running, or
   * the store could not be read. In both cases the watermark is left alone, so
   * the window is covered by the next pass rather than lost.
   */
  async tick(): Promise<TickSummary | null> {
    if (this.#inFlight) return null;
    this.#inFlight = true;
    try {
      return await this.#pass();
    } finally {
      this.#inFlight = false;
    }
  }

  async #pass(): Promise<TickSummary | null> {
    const to = new Date(this.#now());
    const from = new Date(this.#lastTick);

    let schedules;
    try {
      schedules = await this.#store.all();
    } catch (err) {
      // Not advancing is the whole response. A store outage is not a reason to
      // skip a window; it is a reason to look at it again in thirty seconds.
      this.#log("error", "scheduler could not read schedules — window will be retried", {
        err: err instanceof Error ? err.message : String(err),
        from: from.toISOString(),
      });
      return null;
    }

    const occurrences = dueBetween(schedules, from, to);
    const summary: TickSummary = {
      from,
      to,
      due: occurrences.length,
      dispatched: 0,
      stale: 0,
      unhandled: 0,
      failed: 0,
    };

    for (const occurrence of occurrences) {
      const lateBy = to.getTime() - occurrence.at.getTime();
      if (lateBy > this.#staleAfterMs) {
        summary.stale++;
        this.#log("warn", "reminder dropped: too late to be worth saying", {
          capability: occurrence.schedule.capability,
          schedule: occurrence.schedule.id,
          due_at: occurrence.at.toISOString(),
          late_by_minutes: Math.round(lateBy / 60_000),
        });
        continue;
      }

      const handler = this.#handlers.get(occurrence.schedule.capability);
      if (!handler) {
        summary.unhandled++;
        // A schedule outliving the capability that made it is ordinary: Redis
        // keeps it, a deployment turns the feature off. Say it once per name.
        if (!this.#warned.has(occurrence.schedule.capability)) {
          this.#warned.add(occurrence.schedule.capability);
          this.#log("warn", "a schedule is due for a capability this build does not run", {
            capability: occurrence.schedule.capability,
            schedule: occurrence.schedule.id,
          });
        }
        continue;
      }

      // A handler that throws is not retried, here or on the next pass: the
      // window has moved on. Retrying a reminder is the escalation ladder's
      // job, and a blind retry is exactly the duplicate this file avoids.
      try {
        await handler(occurrence);
        summary.dispatched++;
      } catch (err) {
        summary.failed++;
        this.#log("error", "a reminder handler threw — not retried", {
          capability: occurrence.schedule.capability,
          schedule: occurrence.schedule.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Never backwards. A clock stepping back — an NTP correction, a VM resumed
    // from a snapshot — would otherwise re-open a window already delivered.
    this.#lastTick = Math.max(this.#lastTick, to.getTime());

    if (summary.due > 0) {
      this.#log("info", "scheduler tick", {
        dispatched: summary.dispatched,
        stale: summary.stale,
        unhandled: summary.unhandled,
        failed: summary.failed,
        schedules: schedules.length,
      });
    }

    return summary;
  }
}
