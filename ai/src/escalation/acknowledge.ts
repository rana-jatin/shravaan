/**
 * The person answered.
 *
 * A FREE FUNCTION RATHER THAN A METHOD ON THE RUNNER, and the reason is a
 * dependency cycle it would otherwise create. A capability needs to be able to
 * say "they confirmed it" from inside a tool call; the runner needs a handler
 * from every capability; so a capability holding the runner and the runner
 * holding the capability is a knot with no good place to cut it.
 *
 * It needs no ladder and no handlers, which is what makes this possible:
 * `reduce` settles an `acknowledged` event before any timing is consulted. An
 * answer is an answer whatever rung it arrives on.
 */

import { reduce } from "./ladder.ts";
import { DEFAULT_LADDER, type Escalation, type EscalationStore } from "./types.ts";

export type AcknowledgeDeps = {
  store: EscalationStore;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
};

/**
 * Settle every open reminder for one person, oldest due first.
 *
 * PLURAL BECAUSE A MORNING CAN OVERLAP: the eight o'clock tablet is still
 * unacknowledged when the half past eight one comes due, and "yes, done" is not
 * a claim about only one of them. A caller that needs to tell them apart should
 * narrow with `capability` — and if it needs to be narrower than that, it needs
 * to ask a better question before calling this, not after.
 *
 * Returns what was settled, so a caller can say something true about it.
 */
export async function acknowledgeOpen(
  deps: AcknowledgeDeps,
  uid: string,
  opts: { capability?: string } = {},
): Promise<Escalation[]> {
  const log = deps.log ?? (() => {});
  const at = new Date((deps.now ?? Date.now)());

  let open: Escalation[];
  try {
    open = await deps.store.openFor(uid);
  } catch (err) {
    log("error", "could not read reminders to acknowledge", {
      uid,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const settled: Escalation[] = [];
  for (const escalation of open) {
    if (opts.capability !== undefined && escalation.capability !== opts.capability) continue;

    // The ladder is not consulted on this path — see the header — so which one
    // is passed cannot change the outcome.
    const step = reduce(escalation, { type: "acknowledged" }, at, DEFAULT_LADDER);

    try {
      await deps.store.remove(escalation.id);
    } catch (err) {
      // The answer still counted. A record that outlives it gets swept again,
      // and the worst case is one more prompt — not a lost answer.
      log("error", "acknowledged but could not clear the reminder", {
        id: escalation.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    settled.push(step.escalation);
    log("info", "reminder acknowledged", {
      id: escalation.id,
      capability: escalation.capability,
      stage_reached: escalation.stage,
      attempts: escalation.attempts,
    });
  }

  return settled;
}
