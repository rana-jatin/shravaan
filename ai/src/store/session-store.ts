/**
 * Working-memory store interface.
 *
 * Behind an interface for two reasons, both from the design rather than from
 * taste. First, "Redis down → continue stateless on JSON context only" is a
 * specified degradation path (docs/01-architecture.md section 6), so the system
 * must be able to run without a store at all. Second, the domain logic that
 * depends on this is worth testing without standing up a server.
 *
 * Key formats and TTLs live in src/domain/redis-keys.ts and mirror
 * docs/02-data-contracts.md section 2.
 */

import type { JsonContext, Profile, SessionState, Turn } from "@sp-i/shared/domain/types.ts";

/**
 * Everything the orchestrator needs for one turn, fetched in ONE round trip.
 *
 * The ~5 ms Redis budget in docs/03-latency-budget.md assumes a single pipelined
 * read, not three sequential ones. Three round trips would not blow the budget
 * on a LAN, but it is the kind of drift that is invisible until it is not.
 */
export type TurnContext = {
  state: SessionState | null;
  turns: Turn[];
  profile: Profile | null;
};

export interface SessionStore {
  /** One pipelined read of state + turn window + profile. */
  loadForTurn(sid: string, uid: string, windowSize: number): Promise<TurnContext>;

  saveState(state: SessionState): Promise<void>;
  loadState(sid: string): Promise<SessionState | null>;

  /** LPUSH + LTRIM to the capped window. */
  appendTurn(sid: string, turn: Turn, windowSize: number): Promise<void>;
  loadTurns(sid: string, windowSize: number): Promise<Turn[]>;

  /**
   * Refresh the idle TTL on every sess:* key. Called on activity — this is what
   * makes the window idle-based rather than absolute.
   */
  touch(sid: string): Promise<void>;

  /**
   * One turn at a time per session. Returns false if another holder has it.
   * `token` must be unique per acquisition so a holder cannot release a lock it
   * no longer owns after a timeout.
   */
  acquireLock(sid: string, token: string): Promise<boolean>;
  releaseLock(sid: string, token: string): Promise<void>;

  loadContext(uid: string): Promise<JsonContext | null>;
  saveContext(ctx: JsonContext): Promise<void>;
  /** Called when a tool reports context_mutated. */
  invalidateContext(uid: string): Promise<void>;

  loadProfile(uid: string): Promise<Profile | null>;
  saveProfile(profile: Profile): Promise<void>;
  invalidateProfile(uid: string): Promise<void>;

  /** Remove every key for a session. */
  endSession(sid: string): Promise<void>;

  close(): Promise<void>;
}

/**
 * The degraded path: no store at all.
 *
 * Used when Redis is unreachable. The companion becomes shallow — no turn
 * window, no profile, every turn standalone — but it stays alive and keeps
 * talking, which is the right trade. Reads return empty, writes are dropped
 * silently on purpose: a store outage must not also become a crash loop.
 */
export class NullSessionStore implements SessionStore {
  // Parameters are declared even though unused: callers holding the concrete
  // type must be able to pass them, and the signatures document the contract.
  async loadForTurn(_sid: string, _uid: string, _windowSize: number): Promise<TurnContext> {
    return { state: null, turns: [], profile: null };
  }
  async saveState(_state: SessionState): Promise<void> {}
  async loadState(_sid: string): Promise<SessionState | null> {
    return null;
  }
  async appendTurn(_sid: string, _turn: Turn, _windowSize: number): Promise<void> {}
  async loadTurns(_sid: string, _windowSize: number): Promise<Turn[]> {
    return [];
  }
  async touch(_sid: string): Promise<void> {}
  /** Always granted: with no shared store there is nothing to contend with. */
  async acquireLock(_sid: string, _token: string): Promise<boolean> {
    return true;
  }
  async releaseLock(_sid: string, _token: string): Promise<void> {}
  async loadContext(_uid: string): Promise<JsonContext | null> {
    return null;
  }
  async saveContext(_ctx: JsonContext): Promise<void> {}
  async invalidateContext(_uid: string): Promise<void> {}
  async loadProfile(_uid: string): Promise<Profile | null> {
    return null;
  }
  async saveProfile(_profile: Profile): Promise<void> {}
  async invalidateProfile(_uid: string): Promise<void> {}
  async endSession(_sid: string): Promise<void> {}
  async close(): Promise<void> {}
}
