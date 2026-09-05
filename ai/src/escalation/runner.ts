/**
 * The sweep that walks open reminders up the ladder.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SECOND LOOP AND NOT PART OF THE TICKER. They look alike — both
 * wake up, look at the clock, and do something — but they are opposite machines.
 *
 * The ticker has NO persistent state, so it is careful never to say a thing
 * twice: half-open windows, a monotonic watermark, no catch-up after a restart.
 * This has nothing BUT persistent state, so it is idempotent by construction:
 * read the record, see which rung it is on, act, write it back. A restart mid-
 * ladder loses nothing, and a doubled sweep does nothing twice.
 *
 * Merging them would mean one loop with two sets of rules and a reader having
 * to work out which applied where.
 *
 * ACT, THEN RECORD — and the order matters in both directions:
 *
 *   Speaking is attempted BEFORE anything is written, because a record saying
 *   "reminded" that nobody heard is the one state this feature must not reach:
 *   the nudge and the escalation both hang off it, so a lie there is a family
 *   never called. The cost is a crash window in which one prompt could be said
 *   twice, thirty seconds apart. That is a glitch, not a second dose — nobody
 *   acts on a tablet instruction in thirty seconds.
 *
 *   Notifying is likewise attempted first, and here a crash costs a DUPLICATE
 *   message to a family member. Annoying; harmless. The alternative — writing
 *   `escalated` first — buys nothing and risks a record that says somebody was
 *   told when nobody was.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { acknowledgeOpen } from "./acknowledge.ts";
import { reduce } from "./ladder.ts";
import type { Escalation, EscalationStore, Ladder } from "./types.ts";

/** What a capability does when one of its reminders needs saying or escalating. */
export type EscalationHandler = {
  /** How patient this capability is. See `Ladder`. */
  ladder: Ladder;
  /**
   * Try to say it. `spoken: false` is expected and ordinary — somebody is
   * mid-sentence, the radio is on, the device is unplugged.
   */
  speak(
    escalation: Escalation,
    stage: "reminded" | "nudged",
  ): Promise<{ spoken: boolean; reason?: string }>;
  /** Tell somebody else. */
  notify(escalation: Escalation): Promise<{ delivered: boolean; reason?: string }>;
};

export type RunnerLog = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export type EscalationRunnerOptions = {
  store: EscalationStore;
  /** Keyed by `Escalation.capability`. */
  handlers: ReadonlyMap<string, EscalationHandler>;
  intervalMs?: number;
  now?: () => number;
  log?: RunnerLog;
};

export type SweepSummary = {
  open: number;
  spoken: number;
  notified: number;
  settled: number;
  /** Tried and did not land. Ordinary, not an error. */
  withheld: number;
  /** Open, but this build has no capability to handle them. */
  unhandled: number;
};

const DEFAULT_INTERVAL_MS = 30_000;

export class EscalationRunner {
  readonly #store: EscalationStore;
  readonly #handlers: ReadonlyMap<string, EscalationHandler>;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #log: RunnerLog;

  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight = false;
  readonly #warned = new Set<string>();

  constructor(opts: EscalationRunnerOptions) {
    this.#store = opts.store;
    this.#handlers = opts.handlers;
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), this.#intervalMs);
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
   * The person answered. Delegates, because a capability has to be able to do
   * this without holding the runner — see escalation/acknowledge.ts.
   */
  async acknowledge(uid: string, opts: { capability?: string } = {}): Promise<Escalation[]> {
    return acknowledgeOpen({ store: this.#store, log: this.#log, now: this.#now }, uid, opts);
  }

  /**
   * One pass over every open reminder.
   *
   * Returns null when the pass did not happen: another was running, or the
   * store could not be read. Nothing is lost either way — every record carries
   * its own clock, so the next sweep picks up exactly where this one would have.
   */
  async sweep(): Promise<SweepSummary | null> {
    if (this.#inFlight) return null;
    this.#inFlight = true;
    try {
      return await this.#pass();
    } finally {
      this.#inFlight = false;
    }
  }

  async #pass(): Promise<SweepSummary | null> {
    let open: Escalation[];
    try {
      open = await this.#store.open();
    } catch (err) {
      this.#log("error", "escalation sweep could not read the store", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const summary: SweepSummary = {
      open: open.length,
      spoken: 0,
      notified: 0,
      settled: 0,
      withheld: 0,
      unhandled: 0,
    };

    for (const escalation of open) {
      const handler = this.#handlers.get(escalation.capability);
      if (!handler) {
        summary.unhandled++;
        if (!this.#warned.has(escalation.capability)) {
          this.#warned.add(escalation.capability);
          this.#log("warn", "an open reminder belongs to a capability this build does not run", {
            capability: escalation.capability,
            id: escalation.id,
          });
        }
        continue;
      }

      await this.#advance(escalation, handler, summary);
    }

    if (summary.spoken + summary.notified + summary.settled + summary.unhandled > 0) {
      this.#log("info", "escalation sweep", summary);
    }

    return summary;
  }

  async #advance(
    escalation: Escalation,
    handler: EscalationHandler,
    summary: SweepSummary,
  ): Promise<void> {
    const at = new Date(this.#now());
    let step = reduce(escalation, { type: "elapsed" }, at, handler.ladder);

    if (step.action.kind === "speak") {
      const stage = step.action.stage;
      const outcome = await attempt(() => handler.speak(escalation, stage));
      step = reduce(
        escalation,
        outcome.ok && outcome.value.spoken
          ? { type: "spoken" }
          : { type: "not_spoken", reason: refusalOf(outcome, (v) => v.reason) },
        at,
        handler.ladder,
      );
      if (outcome.ok && outcome.value.spoken) summary.spoken++;
      else summary.withheld++;
    } else if (step.action.kind === "notify") {
      const outcome = await attempt(() => handler.notify(escalation));
      step = reduce(
        escalation,
        outcome.ok && outcome.value.delivered
          ? { type: "notified" }
          : { type: "not_notified", reason: refusalOf(outcome, (v) => v.reason) },
        at,
        handler.ladder,
      );
      if (outcome.ok && outcome.value.delivered) summary.notified++;
      else summary.withheld++;
    }

    if (step.action.kind === "settle") {
      await this.#forget(step.escalation);
      summary.settled++;
      return;
    }

    if (step.escalation.stage !== escalation.stage) {
      // Only on a rung change. At one sweep every thirty seconds, logging every
      // withheld attempt would bury the four lines that matter in a hundred.
      this.#log(step.escalation.stage === "escalated" ? "warn" : "info", "reminder advanced", {
        id: escalation.id,
        capability: escalation.capability,
        from: escalation.stage,
        to: step.escalation.stage,
        attempts: step.escalation.attempts,
      });
    }

    if (step.changed) {
      try {
        await this.#store.put(step.escalation);
      } catch (err) {
        // The record stays where it was. The rung is re-attempted next sweep,
        // which for `speak` means one more prompt and for `notify` one more
        // message — both survivable, and both louder than losing the ladder.
        this.#log("error", "could not save a reminder's progress", {
          id: escalation.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async #forget(escalation: Escalation): Promise<void> {
    this.#log(escalation.stage === "abandoned" ? "warn" : "info", "reminder settled", {
      id: escalation.id,
      capability: escalation.capability,
      stage: escalation.stage,
      reason: escalation.reason,
      attempts: escalation.attempts,
    });
    try {
      await this.#store.remove(escalation.id);
    } catch (err) {
      this.#log("error", "could not remove a settled reminder", {
        id: escalation.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; err: string };

/** A handler that throws is a handler that failed. It is not the sweep failing. */
async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

function refusalOf<T>(outcome: Attempt<T>, reason: (value: T) => string | undefined): string {
  if (!outcome.ok) return outcome.err;
  return reason(outcome.value) ?? "unknown";
}
