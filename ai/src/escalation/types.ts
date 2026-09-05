/**
 * What happens after a reminder is said, and nobody answers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE PIECE THE TICKER DELIBERATELY IS NOT. `scheduler/ticker.ts` says
 * a thing once and forgets it: it has no memory across restarts and no idea
 * whether anybody heard. That was the right shape for a loop that must never
 * say a thing twice — and it is the wrong shape for the actual product
 * question, which is not "was the reminder spoken" but "did somebody take the
 * tablet, and if not, who needs to know".
 *
 * So this is the state that outlives the process. A record here is created
 * when an occurrence comes due and is deleted when it is settled; in between,
 * it survives a restart, which is what makes "the eight o'clock dose was never
 * confirmed" answerable at nine.
 *
 * IT IS STILL NOT A HEALTH RECORD. It holds one occurrence, it is deleted when
 * it settles, and it has a TTL behind that in case it does not. Nobody can ask
 * it what happened last Tuesday, and that is deliberate — see the note on
 * `EscalationStore` about what a longer memory here would turn this product
 * into.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Iso8601 } from "@sp-i/shared/domain/types.ts";

/**
 * Where one reminder has got to.
 *
 *   pending      → due, and we have not managed to say it yet
 *   reminded     → said once
 *   nudged       → said twice
 *   escalated    → somebody else has been told
 *   acknowledged → the person answered
 *   abandoned    → nothing more will happen; the record is on its way out
 *
 * `acknowledged` and `abandoned` are terminal. Everything else is somewhere in
 * the middle of a ladder that only ever goes one way.
 */
export type EscalationStage =
  "pending" | "reminded" | "nudged" | "escalated" | "acknowledged" | "abandoned";

export const TERMINAL: readonly EscalationStage[] = ["acknowledged", "abandoned"];

export function isTerminal(stage: EscalationStage): boolean {
  return TERMINAL.includes(stage);
}

export type Escalation = {
  /** `{scheduleId}@{dueAt}` — one per occurrence, so a retry cannot fork. */
  id: string;
  uid: string;
  /** Whose copy and whose contacts. Matched by name, like a schedule's. */
  capability: string;
  scheduleId: string;
  /** The instant the occurrence was due, not the instant this was created. */
  dueAt: Iso8601;
  stage: EscalationStage;
  /** When the CURRENT stage was entered. Every deadline below is from here. */
  since: Iso8601;
  /** How many times speaking has been attempted, successfully or not. */
  attempts: number;
  /** Carried from the schedule. The capability's business, not this module's. */
  payload: Record<string, unknown>;
  /**
   * Why the last attempt to speak or notify did not land.
   *
   * Kept because "eight attempts, all `media`" and "eight attempts, all
   * `closed`" are different situations for whoever is asked why a reminder went
   * unheard, and the difference is invisible from the attempt count alone.
   */
  lastRefusal?: string;
  /** Set once, on the way into a terminal stage. */
  settledAt?: Iso8601;
  /** Why it settled: "answered", "gave_up", or a refusal that never cleared. */
  reason?: string;
};

/**
 * How patient to be, per capability.
 *
 * NOT CONFIG, and not one global setting. A hydration prompt and a blood
 * pressure tablet do not deserve the same persistence, and a deployment-wide
 * number would have to be tuned for whichever of them matters least. A
 * capability names its own ladder.
 *
 * THE NUMBERS BELOW ARE JUDGEMENT, NOT MEASUREMENT, and should be read that
 * way: ten minutes is roughly "long enough to walk to the kitchen and back",
 * and nagging sooner than that is how a person learns to ignore the device.
 */
export type Ladder = {
  /** After being reminded, how long before saying it again. */
  nudgeAfterMinutes: number;
  /** After the nudge, how long before telling somebody else. */
  escalateAfterMinutes: number;
  /**
   * How long the whole thing may run before it is given up on.
   *
   * A record that never settles is a reminder that never stops, and two hours
   * later "take your eight o'clock tablet" is advice nobody should follow.
   */
  abandonAfterMinutes: number;
};

export const DEFAULT_LADDER: Ladder = {
  nudgeAfterMinutes: 10,
  escalateAfterMinutes: 20,
  abandonAfterMinutes: 120,
};

export type EscalationEvent =
  /** A sweep. Everything time-driven happens here. */
  | { type: "elapsed" }
  /** The utterance reached a live conversation. */
  | { type: "spoken" }
  /** It did not. `reason` is a ProactiveRefusal, carried as a plain string. */
  | { type: "not_spoken"; reason: string }
  /** The person answered. Who decides that is the capability's problem. */
  | { type: "acknowledged" }
  /** Somebody else was told. */
  | { type: "notified" }
  /** Notifying failed outright — no channel could reach anybody. */
  | { type: "not_notified"; reason: string };

/**
 * What the caller should DO, as data.
 *
 * The ladder performs nothing itself: it has no clock, no store, no voice and
 * no notifier, so every one of these cases is testable by reading a value.
 */
export type EscalationAction =
  | { kind: "none" }
  /** Say it. `stage` is what the record will become once it lands. */
  | { kind: "speak"; stage: "reminded" | "nudged" }
  /** Tell somebody else. */
  | { kind: "notify" }
  /** Terminal: delete the record. */
  | { kind: "settle" };

export type EscalationStep = {
  escalation: Escalation;
  action: EscalationAction;
  /** False when the event moved nothing — the common case on a quiet sweep. */
  changed: boolean;
};

/**
 * Where open escalations live between restarts.
 *
 * ONLY OPEN ONES. A settled record is deleted, not archived, and the store has
 * no history query because there is no history: a durable log of which doses a
 * person confirmed and which they did not is a clinical record, and this
 * product has no consent for one, no retention policy for one, and no way for
 * a person to see or correct what it said about them. The moment that store
 * exists, somebody will want to chart it.
 *
 * `openFor` exists so a capability can answer "is there a reminder waiting on
 * this person right now" — which is what an acknowledgement needs and is a
 * different question from "what happened last Tuesday".
 */
export type EscalationStore = {
  /** Every open record, for the sweep. */
  open(): Promise<Escalation[]>;
  /** One person's open records, oldest due first. */
  openFor(uid: string): Promise<Escalation[]>;
  get(id: string): Promise<Escalation | null>;
  put(escalation: Escalation): Promise<void>;
  remove(id: string): Promise<void>;
  close?(): Promise<void>;
};

/** Oldest due first: a backlog is worked in the order it happened. */
export function compareEscalations(a: Escalation, b: Escalation): number {
  if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
