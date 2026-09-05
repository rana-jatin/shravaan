/**
 * The third loop, and the first one that watches something outside this process.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A THIRD LOOP AT ALL. The ticker owns schedules this process
 * wrote; the sweep owns ladders this process opened. Neither can see a reading
 * that arrived at the safety service over MQTT from a band, was checked against
 * its bands there, and raised an alert nobody here knows about. This loop is
 * the ingress for exactly that, and it does one thing: turn an alert somebody
 * else raised into a ladder the sweep already knows how to climb.
 *
 * POLLING RATHER THAN A WEBHOOK, and it is a deliberate trade. A callback from
 * the safety service would be faster and would mean inbound HTTP on a process
 * that is a WebSocket server, a second authentication scheme, a retry policy,
 * and a delivery nobody can see fail. Polling keeps every arrow pointing one
 * way — this process calls out, never in — and degrades to "nothing happens"
 * when the service is unreachable, which is the failure mode that does not
 * leave half a state machine somewhere.
 *
 * The cost is seconds of latency. For a reading that was out of range that is
 * nothing. For an SOS it would matter, which is why an SOS is not handled here
 * at all — see `#interesting`.
 *
 * IT NEVER SPEAKS AND NEVER NOTIFIES. It opens a record and stops. Every
 * utterance in this product that nobody asked for goes through one code path,
 * the sweep, so that there is exactly one place deciding whether a prompt
 * landed and exactly one deciding when a family is called.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { openEscalation } from "../escalation/ladder.ts";
import type { EscalationStore } from "../escalation/types.ts";
import type { AlertFeed, OwnedAlert } from "../providers/elderguard.ts";

export type WatcherLog = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export type AlertWatcherOptions = {
  feed: AlertFeed;
  escalations: EscalationStore;
  /** The capability name the ladders are filed under, so the sweep finds them. */
  capability: string;
  intervalMs?: number;
  now?: () => number;
  log?: WatcherLog;
};

export type PollSummary = {
  /** Alerts the feed returned, before any filtering. */
  seen: number;
  /** Ladders opened by this poll. */
  opened: number;
  /** Already had a ladder. The ordinary case once one is running. */
  known: number;
  /** Not ours to act on — an SOS, which the safety service already emailed. */
  skipped: number;
};

const DEFAULT_INTERVAL_MS = 30_000;

export class AlertWatcher {
  readonly #feed: AlertFeed;
  readonly #escalations: EscalationStore;
  readonly #capability: string;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #log: WatcherLog;

  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight = false;
  #failing = false;

  constructor(opts: AlertWatcherOptions) {
    this.#feed = opts.feed;
    this.#escalations = opts.escalations;
    this.#capability = opts.capability;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.poll(), this.#intervalMs);
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
   * One pass. Returns null when it did not happen — another was in flight, or
   * the service could not be reached.
   *
   * Nothing is lost by a missed pass: the alert stays open on the service and
   * the next poll finds it. That is the whole reason this reads a feed rather
   * than receiving events.
   */
  async poll(): Promise<PollSummary | null> {
    if (this.#inFlight) return null;
    this.#inFlight = true;
    try {
      return await this.#pass();
    } finally {
      this.#inFlight = false;
    }
  }

  async #pass(): Promise<PollSummary | null> {
    let alerts: OwnedAlert[];
    try {
      alerts = await this.#feed.allOpen();
    } catch (err) {
      // ONCE PER OUTAGE, NOT ONCE PER POLL. At one pass every thirty seconds a
      // service that is down overnight would otherwise write two thousand
      // identical error lines, and the one line that matters — that it came
      // back — would be lost among them.
      if (!this.#failing) {
        this.#failing = true;
        this.#log("error", "cannot reach the safety service — alerts are not being seen", {
          err: err instanceof Error ? err.message : String(err),
          effect: "an out-of-range reading raises nothing here until it is back",
        });
      }
      return null;
    }

    if (this.#failing) {
      this.#failing = false;
      this.#log("info", "the safety service is reachable again");
    }

    const summary: PollSummary = { seen: alerts.length, opened: 0, known: 0, skipped: 0 };

    for (const alert of alerts) {
      if (!this.#interesting(alert)) {
        summary.skipped++;
        continue;
      }

      const record = openEscalation(
        {
          uid: alert.uid,
          capability: this.#capability,
          // The alert's own id, so the escalation id is stable: the same alert
          // seen on a later poll resolves to the same record and is recognised
          // rather than started again.
          scheduleId: alert.id,
          dueAt: new Date(alert.created_at),
          payload: {
            alert_id: alert.id,
            alert_type: alert.alert_type,
            // Copied, not looked up later. The alert row is settled the moment
            // this ladder ends, so by the time the family message is written
            // there may be nothing left to read.
            readings: alert.details["readings"] ?? [],
            observed_at: alert.details["observed_at"] ?? alert.created_at,
          },
        },
        // WHEN WE FIRST SAW IT, not when it was raised. After an outage the
        // feed hands over alerts that are hours old, and dating the record from
        // `created_at` would put it straight past the nudge window — telling a
        // family before the device had said one word.
        new Date(this.#now()),
      );

      let existing = null;
      try {
        existing = await this.#escalations.get(record.id);
      } catch (err) {
        // Reading the store failed. Skip rather than open a second ladder for
        // an alert that may already have one — a doubled ladder is two prompts
        // and two family messages about one event.
        this.#log("error", "could not check whether an alert already has a ladder", {
          alert: alert.id,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (existing) {
        summary.known++;
        continue;
      }

      try {
        await this.#escalations.put(record);
        summary.opened++;
      } catch (err) {
        this.#log("error", "could not open a ladder for an alert", {
          alert: alert.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (summary.opened > 0) {
      this.#log("warn", "alerts picked up from the safety service", summary);
    }

    return summary;
  }

  /**
   * Which alerts this loop acts on.
   *
   * AN SOS IS DELIBERATELY NOT ONE OF THEM. The safety service emails the
   * family the moment the button is pressed, and the emergency capability owns
   * what the device says about an alarm — in copy written for exactly that
   * moment. A second, slower path saying something reassuring thirty seconds
   * later, in different words, would be two systems narrating one event to a
   * frightened person.
   *
   * ⚠ WHICH LEAVES A GAP: a hardware SOS reaches the family but the device
   * standing next to the person says nothing. Closing it means routing that
   * alert into the emergency capability's acknowledgement, not into this
   * ladder, and it is open work rather than an oversight.
   */
  #interesting(alert: OwnedAlert): boolean {
    return alert.alert_type === "anomaly" || alert.alert_type === "fall";
  }
}
