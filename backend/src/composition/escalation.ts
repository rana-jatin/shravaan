/**
 * Where unanswered reminders live, and whether anything is climbing them.
 *
 * The same two-function shape as composition/scheduler.ts, and for the same
 * boot-order reason: a capability closes a ladder from inside a tool call, so
 * the store must exist before `registerCapabilities`; the sweep dispatches to
 * capabilities, so it cannot start until after.
 *
 * THE WARNING WHEN THERE IS NO REDIS IS NOT THE SAME WARNING AS THE ONE ABOUT
 * WORKING MEMORY, and saying so is the reason this file logs at all. Losing a
 * turn window on restart makes the companion shallow for a few minutes. Losing
 * the record of "said at eight, nobody answered" loses the reason escalation
 * exists — the family call that should have happened at half past eight simply
 * does not, and nothing anywhere reports it.
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import { MemoryEscalationStore } from "@sp-i/ai/escalation/memory-escalation-store.ts";
import { RedisEscalationStore } from "@sp-i/ai/escalation/redis-escalation-store.ts";
import { EscalationRunner, type EscalationHandler } from "@sp-i/ai/escalation/runner.ts";
import type { EscalationStore } from "@sp-i/ai/escalation/types.ts";
import type { Log } from "./types.ts";

export type EscalationHandle = {
  /** Null when nothing in this build escalates anything. */
  runner: EscalationRunner | null;
  stop(): Promise<void>;
};

/** Lazy when it is Redis, so an unused store opens no socket. */
export function buildEscalationStore(cfg: Config): EscalationStore {
  return cfg.redisUrl ? new RedisEscalationStore(cfg.redisUrl) : new MemoryEscalationStore();
}

export function startEscalationRunner(
  cfg: Config,
  log: Log,
  store: EscalationStore,
  handlers: ReadonlyMap<string, EscalationHandler>,
): EscalationHandle {
  if (handlers.size === 0) {
    return {
      runner: null,
      async stop() {
        await store.close?.();
      },
    };
  }

  const runner = new EscalationRunner({ store, handlers, log });
  runner.start();

  log("info", "escalation running", {
    capabilities: [...handlers.keys()],
    store: cfg.redisUrl ? "redis" : "memory",
  });

  if (!cfg.redisUrl) {
    log("error", "unanswered reminders are in-process and do not survive a restart", {
      effect: "a dose nobody confirmed is forgotten, and no one is told it was missed",
      fix: "set REDIS_URL",
    });
  }

  return {
    runner,
    async stop() {
      runner.stop();
      await store.close?.();
    },
  };
}
