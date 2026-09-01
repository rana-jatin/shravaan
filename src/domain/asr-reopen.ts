/**
 * What to do when the ASR socket drops — the ladder, as a pure function.
 *
 * THE BUG THIS MODULE EXISTS TO PREVENT RECURRING.
 *
 * The session used to reset its consecutive-failure count on the socket's
 * `open` event, on the reasonable-sounding grounds that a clean open means the
 * connection works. It does not. Sarvam accepts the WebSocket upgrade and THEN
 * closes with 4000 if it dislikes a query parameter, so a rejected socket fires
 * `open` exactly like a healthy one. Observed against a live key: the count went
 * 0 → 1 → 0 → 1 forever, logging `attempt: 1` on every cycle.
 *
 * Both thresholds below sit above 1, so both became unreachable:
 *   - failover never engaged, even with ASR_FAILOVER_ENABLED=true
 *   - the give-up threshold never tripped, so the session never degraded and
 *     never stopped — it reconnected in a tight loop against the provider,
 *     indefinitely, while the user heard silence
 *
 * The fix is the distinction this module encodes: a connection that RAN is not
 * the same as one that merely OPENED. A socket that stayed up for a stability
 * window was doing its job; a rejected one dies in well under a second.
 */

import { SOCKET_RECONNECT, delayFor, type BackoffPolicy } from "./backoff.ts";

/**
 * How long an ASR socket must survive to count as having worked.
 *
 * Sized off the two populations, which are nowhere near each other: the observed
 * parameter rejections closed in under half a second, while a socket carrying a
 * real conversation lives for minutes. Anything in between separates them, so
 * this is deliberately generous rather than tuned — the failure it guards
 * against is a rejected socket being mistaken for a working one.
 */
export const ASR_STABLE_MS = 10_000;

export type ReopenDecision =
  /** Move to the standby provider. Carries a data-residency cost — see ADR 0008. */
  | { action: "failover"; reopens: number }
  /** Out of reconnects. The session can no longer hear and must say so. */
  | { action: "lose_hearing"; reopens: number }
  /** Try Sarvam again after a backoff. */
  | { action: "reopen"; reopens: number; delayMs: number };

export type ReopenInput = {
  /** Consecutive failures BEFORE this one. */
  reopens: number;
  /**
   * Did the socket that just died survive {@link ASR_STABLE_MS}? A stable
   * connection that drops is a fresh incident, not a continuing one, so its
   * failure starts the count again rather than adding to a stale total.
   */
  socketWasStable: boolean;
  /** Whether a standby provider is configured AND covers this language. */
  standbyAvailable: boolean;
  maxReopens: number;
  policy?: BackoffPolicy;
  rand?: () => number;
};

/**
 * Note the ordering: failover is considered BEFORE the give-up threshold, so a
 * language with a standby relocates rather than going deaf. Nine of our eleven
 * languages have no standby at all and take the second branch.
 */
export function reopenDecision(input: ReopenInput): ReopenDecision {
  const {
    reopens,
    socketWasStable,
    standbyAvailable,
    maxReopens,
    policy = SOCKET_RECONNECT,
    rand,
  } = input;

  // A previously healthy connection failing is failure number one, not number
  // five. This replaces the reset-on-open that made the count meaningless.
  const next = socketWasStable ? 1 : reopens + 1;

  if (standbyAvailable && next >= 2) return { action: "failover", reopens: next };
  if (next > maxReopens) return { action: "lose_hearing", reopens: next };

  return {
    action: "reopen",
    reopens: next,
    delayMs: rand ? delayFor(next - 1, policy, rand) : delayFor(next - 1, policy),
  };
}
