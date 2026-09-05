/**
 * The ladder itself. Pure — a record and an event in, a record and an action
 * out. No clock, no store, no voice, no notifier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT ONLY EVER CLIMBS. There is no path back down: a nudged reminder cannot
 * become merely reminded, an escalated one cannot un-tell the family. The one
 * way out is sideways, into `acknowledged`, and that is what the person
 * answering does. A ladder that could descend would be a ladder that could
 * loop, and a loop here is a device that reminds somebody about the same
 * tablet all afternoon.
 *
 * TWO DECISIONS WORTH READING BEFORE CHANGING ANYTHING:
 *
 * 1. NOT REACHING SOMEBODY IS MORE URGENT THAN REACHING THEM AND GETTING NO
 *    ANSWER. A `pending` record that has not managed to speak for the whole
 *    nudge window skips straight to `notify` — it never becomes `nudged`,
 *    because nudging presupposes having reminded. Silence from a device that
 *    was never able to speak is not evidence about the person at all, and
 *    treating it as if it were would delay the one signal that matters.
 *
 * 2. GIVING UP IS A FEATURE. `abandonAfterMinutes` is measured from `dueAt`,
 *    not from the current stage, so the whole thing is bounded. Two hours late,
 *    "take your eight o'clock tablet" is advice nobody should act on, and a
 *    reminder that never stops is one that gets the device unplugged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  Escalation,
  EscalationAction,
  EscalationEvent,
  EscalationStep,
  Ladder,
} from "./types.ts";
import { isTerminal } from "./types.ts";

const MINUTE_MS = 60_000;

/**
 * A record for one occurrence that has just come due.
 *
 * The id is the occurrence, not a fresh uuid: two dispatches of the same due
 * instant — a retry, a second replica, a restart mid-tick — must land on one
 * record and not two ladders climbing side by side.
 */
export function openEscalation(
  occurrence: {
    uid: string;
    capability: string;
    scheduleId: string;
    dueAt: Date;
    payload: Record<string, unknown>;
  },
  at: Date,
): Escalation {
  return {
    id: `${occurrence.scheduleId}@${occurrence.dueAt.getTime()}`,
    uid: occurrence.uid,
    capability: occurrence.capability,
    scheduleId: occurrence.scheduleId,
    dueAt: occurrence.dueAt.toISOString(),
    stage: "pending",
    since: at.toISOString(),
    attempts: 0,
    payload: occurrence.payload,
  };
}

export function reduce(
  escalation: Escalation,
  event: EscalationEvent,
  at: Date,
  ladder: Ladder,
): EscalationStep {
  // A settled record is finished. Emitting `settle` rather than `none` makes a
  // sweep self-cleaning: whatever left this behind, the next pass removes it.
  if (isTerminal(escalation.stage)) {
    return { escalation, action: { kind: "settle" }, changed: false };
  }

  if (event.type === "acknowledged") {
    return settled(escalation, at, "acknowledged", "answered");
  }

  // Before anything else, and measured from `dueAt` rather than the current
  // stage: this bounds the whole ladder, not one rung of it.
  if (elapsedMs(escalation.dueAt, at) >= ladder.abandonAfterMinutes * MINUTE_MS) {
    return settled(escalation, at, "abandoned", "gave_up");
  }

  switch (event.type) {
    case "spoken":
      return spoken(escalation, at);

    case "not_spoken":
      // The attempt counts even though nothing was said. A record showing eight
      // attempts and no speech is the shape of a device somebody muted.
      return step(escalation, {
        attempts: escalation.attempts + 1,
        lastRefusal: event.reason,
      });

    case "notified":
      return step(escalation, { stage: "escalated", since: at.toISOString() }, "clear_refusal");

    case "not_notified":
      // Stay where we are so the next sweep tries again, but restart the clock
      // on this rung: without that, a dead SMTP host would be retried on every
      // tick for as long as the record lives.
      return step(escalation, { since: at.toISOString(), lastRefusal: event.reason });

    case "elapsed":
      return elapsed(escalation, at, ladder);
  }
}

function elapsed(escalation: Escalation, at: Date, ladder: Ladder): EscalationStep {
  const onThisRung = elapsedMs(escalation.since, at);

  switch (escalation.stage) {
    case "pending": {
      // Never spoken. Past the nudge window, the failure to reach anybody is
      // itself the news — see decision 1 in the header.
      if (onThisRung >= ladder.nudgeAfterMinutes * MINUTE_MS) return act(escalation, "notify");
      // Otherwise keep trying, every sweep. This is the recovery path for a
      // conversation that was simply busy thirty seconds ago.
      return act(escalation, "speak", "reminded");
    }

    case "reminded":
      if (onThisRung >= ladder.nudgeAfterMinutes * MINUTE_MS) {
        return act(escalation, "speak", "nudged");
      }
      return quiet(escalation);

    case "nudged":
      if (onThisRung >= ladder.escalateAfterMinutes * MINUTE_MS) {
        return act(escalation, "notify");
      }
      return quiet(escalation);

    case "escalated":
      // Somebody has been told. Nothing more happens here; the abandon check
      // above is what eventually removes the record.
      return quiet(escalation);

    default:
      return quiet(escalation);
  }
}

function spoken(escalation: Escalation, at: Date): EscalationStep {
  const attempts = escalation.attempts + 1;
  const since = at.toISOString();

  if (escalation.stage === "pending") {
    return step(escalation, { stage: "reminded", since, attempts }, "clear_refusal");
  }
  if (escalation.stage === "reminded") {
    return step(escalation, { stage: "nudged", since, attempts }, "clear_refusal");
  }

  // Spoken again from a rung that does not have a next one. The count moves,
  // the clock on this rung does not — an extra utterance must not postpone the
  // escalation it was supposed to make unnecessary.
  return step(escalation, { attempts }, "clear_refusal");
}

function settled(
  escalation: Escalation,
  at: Date,
  stage: "acknowledged" | "abandoned",
  reason: string,
): EscalationStep {
  return {
    escalation: {
      ...escalation,
      stage,
      since: at.toISOString(),
      settledAt: at.toISOString(),
      reason,
    },
    action: { kind: "settle" },
    changed: true,
  };
}

function act(
  escalation: Escalation,
  kind: "speak" | "notify",
  stage?: "reminded" | "nudged",
): EscalationStep {
  // The record is UNCHANGED. An action is a request, not a result: the caller
  // performs it and feeds the outcome back as `spoken` / `notified` or their
  // failures. Recording the climb here would mean a reminder nobody managed to
  // say still read as said.
  const action: EscalationAction =
    kind === "speak" ? { kind: "speak", stage: stage ?? "reminded" } : { kind: "notify" };
  return { escalation, action, changed: false };
}

function quiet(escalation: Escalation): EscalationStep {
  return { escalation, action: { kind: "none" }, changed: false };
}

/**
 * Apply a patch and report honestly whether anything moved.
 *
 * `clear_refusal` rather than `lastRefusal: undefined`, because under
 * `exactOptionalPropertyTypes` those are different things: the field being
 * absent means "the last attempt worked", and writing `undefined` into it would
 * be a third state nobody asked for.
 */
function step(
  escalation: Escalation,
  patch: Partial<Escalation>,
  clearRefusal?: "clear_refusal",
): EscalationStep {
  const next: Escalation = { ...escalation, ...patch };
  if (clearRefusal) delete next.lastRefusal;

  const changed =
    next.stage !== escalation.stage ||
    next.since !== escalation.since ||
    next.attempts !== escalation.attempts ||
    next.lastRefusal !== escalation.lastRefusal;

  return { escalation: next, action: { kind: "none" }, changed };
}

function elapsedMs(from: string, at: Date): number {
  const started = Date.parse(from);
  // A corrupt timestamp must not make a record immortal. Treating it as due
  // now sends it to the abandon check, which is the safe direction: the record
  // is removed and the next occurrence opens a clean one.
  if (Number.isNaN(started)) return Number.POSITIVE_INFINITY;
  return at.getTime() - started;
}
