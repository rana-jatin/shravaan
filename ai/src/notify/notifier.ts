/**
 * Getting a notification onto whatever channels can carry it.
 *
 * EVERY CHANNEL IS TRIED, not the first that works. For an emergency that is
 * the point: a phone on silent and an unread inbox fail in uncorrelated ways,
 * and belt-and-braces is the correct trade when the alternative is nobody
 * finding out. With a single channel configured — which is every deployment
 * today — this behaves exactly as the one-transport code it replaces.
 *
 * NEVER THROWS. It is called from the middle of the session's speech path, and
 * an exception there would take down the turn that is trying to tell the user
 * help is coming. Failure comes back as data and the session speaks it.
 */

import type { DeliveryResult, Notification, NotificationChannel, Recipient } from "./types.ts";

export type NotifierDeps = {
  channels: NotificationChannel[];
  /**
   * Attempts per channel, including the first.
   *
   * Two, and no more. A transient TCP failure to a relay is common and cheap to
   * retry; a rejected password fails identically twice and the second attempt
   * costs a second. Past that the user needs to be told rather than kept
   * waiting — see the acknowledgement copy in copy/emergency-intent.ts.
   */
  attempts?: number;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

export type NotifyOutcome = {
  /** At least one channel reached at least one person. */
  delivered: boolean;
  /** Everyone reached, by name, deduplicated across channels. */
  reached: string[];
  results: DeliveryResult[];
};

export class Notifier {
  readonly #d: NotifierDeps;
  readonly #attempts: number;

  constructor(deps: NotifierDeps) {
    this.#d = deps;
    this.#attempts = Math.max(1, deps.attempts ?? 2);
  }

  get channels(): readonly NotificationChannel[] {
    return this.#d.channels;
  }

  async send(notification: Notification): Promise<NotifyOutcome> {
    const results: DeliveryResult[] = [];
    const reached = new Set<string>();

    for (const channel of this.#d.channels) {
      const to = notification.to.filter((r: Recipient) => channel.canReach(r));
      if (to.length === 0) {
        // Not a failure. A contact with only an email address is simply not
        // reachable by SMS, and saying so is more useful than an error.
        results.push({ kind: channel.kind, delivered: [] });
        continue;
      }

      let lastError: unknown = null;
      let ok = false;
      for (let attempt = 1; attempt <= this.#attempts && !ok; attempt++) {
        try {
          await channel.send({ ...notification, to });
          ok = true;
        } catch (err) {
          lastError = err;
          this.#d.log?.("error", "notification channel failed", {
            channel: channel.kind,
            attempt,
            error: String(err instanceof Error ? err.message : err),
          });
        }
      }

      if (ok) {
        for (const r of to) reached.add(r.name);
        results.push({ kind: channel.kind, delivered: to.map((r) => r.name) });
      } else {
        results.push({
          kind: channel.kind,
          delivered: [],
          error: String(lastError instanceof Error ? lastError.message : lastError),
        });
      }
    }

    return { delivered: reached.size > 0, reached: [...reached], results };
  }

  /** The first error any channel reported, for a result the user is told about. */
  static firstError(outcome: NotifyOutcome): string | undefined {
    return outcome.results.find((r) => r.error)?.error;
  }
}
