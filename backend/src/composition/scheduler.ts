/**
 * Where reminders are kept, and whether anything is watching the clock.
 *
 * TWO FUNCTIONS BECAUSE THE BOOT ORDER NEEDS TWO. A capability writes schedules,
 * so the store has to exist before `registerCapabilities` runs; the ticker
 * dispatches to capabilities, so it cannot start until after. Splitting them is
 * what keeps that a straight line in server.ts instead of a lazy getter.
 *
 * THE TICKER DOES NOT START UNLESS SOMETHING WOULD ANSWER IT. No capability
 * registers an occurrence handler yet — medication reminders and daily
 * check-ins are the first two — so today this builds a store nobody has written
 * to and starts nothing. That is the same rule the tools follow: unconfigured
 * means unregistered means never announced. A timer polling for work nobody
 * produces would still be running three years from now with no one able to say
 * what it was for, and the boot log would claim a scheduler this build does not
 * really have.
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import { MemoryScheduleStore } from "@sp-i/ai/scheduler/memory-schedule-store.ts";
import { RedisScheduleStore } from "@sp-i/ai/scheduler/redis-schedule-store.ts";
import { Ticker, type OccurrenceHandler } from "@sp-i/ai/scheduler/ticker.ts";
import type { ScheduleStore } from "@sp-i/ai/scheduler/types.ts";
import type { Log } from "./types.ts";

export type SchedulerHandle = {
  /** Null when nothing in this build schedules anything. */
  ticker: Ticker | null;
  stop(): Promise<void>;
};

/**
 * The store, chosen the same way the session store is.
 *
 * NOTE THE ASYMMETRY WITH `buildMemory`, which wraps its store in a circuit
 * breaker. This one is not wrapped, and the reason is that the degraded answers
 * differ: an empty turn window makes the companion shallow, while an empty
 * schedule list makes it silent about a medication. Failing loudly and retrying
 * the same window on the next tick — what Ticker does with a store error — is
 * the better trade here than a breaker that returns "no reminders" quickly.
 */
export function buildScheduleStore(cfg: Config): ScheduleStore {
  // Constructed unconditionally and costing nothing when unused: the Redis
  // client is lazy, so no socket opens until something reads or writes.
  return cfg.redisUrl ? new RedisScheduleStore(cfg.redisUrl) : new MemoryScheduleStore();
}

export function startScheduler(
  cfg: Config,
  log: Log,
  store: ScheduleStore,
  handlers: ReadonlyMap<string, OccurrenceHandler>,
): SchedulerHandle {
  if (handlers.size === 0) {
    return {
      ticker: null,
      async stop() {
        await store.close?.();
      },
    };
  }

  const ticker = new Ticker({ store, handlers, log });
  ticker.start();

  log("info", "scheduler running", {
    capabilities: [...handlers.keys()],
    store: cfg.redisUrl ? "redis" : "memory",
    ...(cfg.redisUrl
      ? {}
      : { warning: "reminders are in-process and are lost on restart — set REDIS_URL" }),
  });

  return {
    ticker,
    async stop() {
      ticker.stop();
      await store.close?.();
    },
  };
}
