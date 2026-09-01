/**
 * Redis SessionStore.
 *
 * Shapes follow docs/02-data-contracts.md section 2:
 *   sess:{sid}:state    hash-equivalent, stored as JSON   idle 30 min
 *   sess:{sid}:turns    list, capped at the window        idle 30 min
 *   sess:{sid}:lock     string + token                    10 s
 *   user:{uid}:ctx      JSON                              ABSOLUTE 15 min
 *   user:{uid}:profile  JSON                              absolute 7 days
 *
 * `loadForTurn` is a single pipelined round trip. The ~5 ms budget in
 * docs/03-latency-budget.md assumes that, not three sequential reads.
 */

import { Redis } from "ioredis";
import { TTL, key } from "@sp-i/shared/domain/redis-keys.ts";
import type { JsonContext, Profile, SessionState, Turn } from "@sp-i/shared/domain/types.ts";
import type { SessionStore, TurnContext } from "./session-store.ts";

/**
 * Release must be atomic: check the token and delete in one step. Without this,
 * a turn whose lock already expired could delete a lock a later turn legitimately
 * holds — the classic distributed-lock bug, and here it would let barge-in race a
 * completing turn, which is precisely what the lock exists to prevent.
 */
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt value is treated as absent rather than fatal. Working memory is
    // recoverable; crashing a live conversation over it is not a good trade.
    return null;
  }
}

export class RedisSessionStore implements SessionStore {
  readonly #redis: Redis;

  constructor(urlOrClient: string | Redis) {
    this.#redis = typeof urlOrClient === "string" ? new Redis(urlOrClient) : urlOrClient;
  }

  async loadForTurn(sid: string, uid: string, windowSize: number): Promise<TurnContext> {
    const results = await this.#redis
      .pipeline()
      .get(key.sessionState(sid))
      .lrange(key.sessionTurns(sid), 0, windowSize - 1)
      .get(key.userProfile(uid))
      .exec();

    if (!results) return { state: null, turns: [], profile: null };

    const [stateRes, turnsRes, profileRes] = results;
    const rawTurns = (turnsRes?.[1] as string[] | undefined) ?? [];

    return {
      state: parse<SessionState>((stateRes?.[1] as string | null) ?? null),
      turns: rawTurns.map((t) => parse<Turn>(t)).filter((t): t is Turn => t !== null),
      profile: parse<Profile>((profileRes?.[1] as string | null) ?? null),
    };
  }

  async saveState(state: SessionState): Promise<void> {
    await this.#redis.set(
      key.sessionState(state.sid),
      JSON.stringify(state),
      "EX",
      TTL.SESSION_SECONDS,
    );
  }

  async loadState(sid: string): Promise<SessionState | null> {
    return parse<SessionState>(await this.#redis.get(key.sessionState(sid)));
  }

  async appendTurn(sid: string, turn: Turn, windowSize: number): Promise<void> {
    const k = key.sessionTurns(sid);
    await this.#redis
      .pipeline()
      .lpush(k, JSON.stringify(turn))
      .ltrim(k, 0, windowSize - 1)
      .expire(k, TTL.SESSION_SECONDS)
      .exec();
  }

  async loadTurns(sid: string, windowSize: number): Promise<Turn[]> {
    const raw = await this.#redis.lrange(key.sessionTurns(sid), 0, windowSize - 1);
    return raw.map((t) => parse<Turn>(t)).filter((t): t is Turn => t !== null);
  }

  async touch(sid: string): Promise<void> {
    // EXPIRE on a missing key is a no-op, so this never resurrects a dead session.
    await this.#redis
      .pipeline()
      .expire(key.sessionState(sid), TTL.SESSION_SECONDS)
      .expire(key.sessionTurns(sid), TTL.SESSION_SECONDS)
      .expire(key.sessionPending(sid), TTL.SESSION_SECONDS)
      .exec();
  }

  async acquireLock(sid: string, token: string): Promise<boolean> {
    const res = await this.#redis.set(key.sessionLock(sid), token, "EX", TTL.LOCK_SECONDS, "NX");
    return res === "OK";
  }

  async releaseLock(sid: string, token: string): Promise<void> {
    await this.#redis.eval(RELEASE_IF_OWNER, 1, key.sessionLock(sid), token);
  }

  async loadContext(uid: string): Promise<JsonContext | null> {
    return parse<JsonContext>(await this.#redis.get(key.userContext(uid)));
  }

  async saveContext(ctx: JsonContext): Promise<void> {
    // ABSOLUTE ttl, never refreshed on access: entitlements and account status
    // must go stale predictably, or a suspended account keeps its capabilities
    // for as long as it stays chatty.
    await this.#redis.set(
      key.userContext(ctx.uid),
      JSON.stringify(ctx),
      "EX",
      TTL.USER_CONTEXT_SECONDS,
    );
  }

  async invalidateContext(uid: string): Promise<void> {
    await this.#redis.del(key.userContext(uid));
  }

  async loadProfile(uid: string): Promise<Profile | null> {
    return parse<Profile>(await this.#redis.get(key.userProfile(uid)));
  }

  async saveProfile(profile: Profile): Promise<void> {
    await this.#redis.set(
      key.userProfile(profile.uid),
      JSON.stringify(profile),
      "EX",
      TTL.USER_PROFILE_SECONDS,
    );
  }

  async invalidateProfile(uid: string): Promise<void> {
    await this.#redis.del(key.userProfile(uid));
  }

  async endSession(sid: string): Promise<void> {
    await this.#redis.del(
      key.sessionState(sid),
      key.sessionTurns(sid),
      key.sessionPending(sid),
      key.sessionLock(sid),
    );
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
