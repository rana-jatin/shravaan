/**
 * Redis key formats and TTLs. Pure — no client, no I/O.
 *
 * TTLs are IDLE WINDOWS, not call durations. This is the correction from the
 * original telephony-shaped design: a companion pauses, someone walks away
 * mid-sentence and comes back, and a call-length TTL would drop the thread
 * exactly when continuity matters most.
 *
 * Spec: docs/02-data-contracts.md section 2
 */

export const TTL = {
  /** Idle window. Refreshed on every turn. */
  SESSION_SECONDS: 30 * 60,
  /** Held during a turn so barge-in cannot race a completing turn. */
  LOCK_SECONDS: 10,
  /**
   * ABSOLUTE, not idle. Entitlements and account status must go stale
   * predictably — an idle TTL means a suspended account keeps its capabilities
   * as long as it stays chatty.
   */
  USER_CONTEXT_SECONDS: 15 * 60,
  /**
   * Durable cache, not session-scoped. Under strong continuity a session-scoped
   * profile means every session pays a cold long-term-memory read.
   * Invalidated explicitly when the memory worker commits.
   */
  USER_PROFILE_SECONDS: 7 * 24 * 60 * 60,
  /**
   * A BACKSTOP, not a lifetime. An escalation is deleted the moment it settles;
   * this only catches a record whose sweeper died before it could. Two days is
   * long enough that no live reminder is ever cut short, and short enough that a
   * forgotten one cannot quietly become a history of somebody's medication —
   * see the note on `EscalationStore`.
   */
  ESCALATION_SECONDS: 48 * 60 * 60,
} as const;

/** Last N turns kept for the LLM window. */
export const TURN_WINDOW = 12;

/** Approximate cap on the mem:writes stream. */
export const MEM_WRITES_MAXLEN = 100_000;

export const key = {
  sessionState: (sid: string) => `sess:${sid}:state`,
  sessionTurns: (sid: string) => `sess:${sid}:turns`,
  sessionPending: (sid: string) => `sess:${sid}:pending`,
  sessionLock: (sid: string) => `sess:${sid}:lock`,
  userContext: (uid: string) => `user:${uid}:ctx`,
  userProfile: (uid: string) => `user:${uid}:profile`,
  memWrites: () => `mem:writes`,

  /**
   * Reminders. THE ONLY KEYS HERE WITH NO TTL, and the exception is the point:
   * everything above is working memory, which is meant to go stale. A schedule
   * is a standing instruction from a caregiver — "the blue tablet at eight" —
   * and a key that quietly expired would turn a missed dose into a silence
   * nobody could attribute to anything. Schedules end when someone deletes them.
   *
   * Split into `id:` and `index:` so no schedule id can ever collide with an
   * index key, whatever a caller names one.
   */
  schedule: (id: string) => `sched:id:${id}`,
  /** Every schedule id, for the ticker. */
  scheduleIndex: () => `sched:index:all`,
  /** One person's schedule ids. */
  userScheduleIndex: (uid: string) => `sched:index:user:${uid}`,

  /**
   * Reminders that are mid-ladder. Unlike a schedule these DO expire, and the
   * asymmetry is the point: a schedule is a standing instruction, an escalation
   * is one morning's unfinished business.
   */
  escalation: (id: string) => `esc:id:${id}`,
  /** Every open escalation, for the sweep. */
  escalationIndex: () => `esc:index:open`,
  /** One person's open escalations. */
  userEscalationIndex: (uid: string) => `esc:index:user:${uid}`,
} as const;

/** Every key belonging to a session, for teardown. */
export function sessionKeys(sid: string): string[] {
  return [
    key.sessionState(sid),
    key.sessionTurns(sid),
    key.sessionPending(sid),
    key.sessionLock(sid),
  ];
}
