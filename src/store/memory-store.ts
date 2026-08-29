/**
 * In-memory SessionStore.
 *
 * Not a toy: it is the reference implementation the contract tests check Redis
 * against, and it is what single-instance development runs on. It implements the
 * same TTL semantics — idle windows for sess:*, absolute for user:* — because a
 * store that quietly never expires would hide exactly the bugs the TTL design
 * exists to prevent.
 *
 * `now` is injectable so tests can advance the clock instead of sleeping.
 */

import { TTL, key } from "../domain/redis-keys.ts";
import type { JsonContext, Profile, SessionState, Turn } from "../domain/types.ts";
import type { SessionStore, TurnContext } from "./session-store.ts";

type Entry = { value: unknown; expiresAt: number };

export class MemorySessionStore implements SessionStore {
  readonly #data = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #get<T>(k: string): T | null {
    const e = this.#data.get(k);
    if (!e) return null;
    if (e.expiresAt <= this.#now()) {
      this.#data.delete(k);
      return null;
    }
    return e.value as T;
  }

  #set(k: string, value: unknown, ttlSeconds: number): void {
    this.#data.set(k, { value, expiresAt: this.#now() + ttlSeconds * 1000 });
  }

  /** Extend TTL only if the key is still live — never resurrect an expired one. */
  #expire(k: string, ttlSeconds: number): void {
    const e = this.#data.get(k);
    if (!e || e.expiresAt <= this.#now()) return;
    e.expiresAt = this.#now() + ttlSeconds * 1000;
  }

  async loadForTurn(sid: string, uid: string, windowSize: number): Promise<TurnContext> {
    return {
      state: this.#get<SessionState>(key.sessionState(sid)),
      turns: (this.#get<Turn[]>(key.sessionTurns(sid)) ?? []).slice(0, windowSize),
      profile: this.#get<Profile>(key.userProfile(uid)),
    };
  }

  async saveState(state: SessionState): Promise<void> {
    this.#set(key.sessionState(state.sid), state, TTL.SESSION_SECONDS);
  }

  async loadState(sid: string): Promise<SessionState | null> {
    return this.#get<SessionState>(key.sessionState(sid));
  }

  async appendTurn(sid: string, turn: Turn, windowSize: number): Promise<void> {
    const k = key.sessionTurns(sid);
    const list = this.#get<Turn[]>(k) ?? [];
    // Newest first, mirroring LPUSH + LTRIM.
    list.unshift(turn);
    this.#set(k, list.slice(0, windowSize), TTL.SESSION_SECONDS);
  }

  async loadTurns(sid: string, windowSize: number): Promise<Turn[]> {
    return (this.#get<Turn[]>(key.sessionTurns(sid)) ?? []).slice(0, windowSize);
  }

  async touch(sid: string): Promise<void> {
    this.#expire(key.sessionState(sid), TTL.SESSION_SECONDS);
    this.#expire(key.sessionTurns(sid), TTL.SESSION_SECONDS);
    this.#expire(key.sessionPending(sid), TTL.SESSION_SECONDS);
  }

  async acquireLock(sid: string, token: string): Promise<boolean> {
    const k = key.sessionLock(sid);
    if (this.#get<string>(k) !== null) return false;
    this.#set(k, token, TTL.LOCK_SECONDS);
    return true;
  }

  async releaseLock(sid: string, token: string): Promise<void> {
    const k = key.sessionLock(sid);
    // Only the holder may release. Otherwise a slow turn whose lock already
    // expired would delete the lock a later turn legitimately holds.
    if (this.#get<string>(k) === token) this.#data.delete(k);
  }

  async loadContext(uid: string): Promise<JsonContext | null> {
    return this.#get<JsonContext>(key.userContext(uid));
  }

  async saveContext(ctx: JsonContext): Promise<void> {
    this.#set(key.userContext(ctx.uid), ctx, TTL.USER_CONTEXT_SECONDS);
  }

  async invalidateContext(uid: string): Promise<void> {
    this.#data.delete(key.userContext(uid));
  }

  async loadProfile(uid: string): Promise<Profile | null> {
    return this.#get<Profile>(key.userProfile(uid));
  }

  async saveProfile(profile: Profile): Promise<void> {
    this.#set(key.userProfile(profile.uid), profile, TTL.USER_PROFILE_SECONDS);
  }

  async invalidateProfile(uid: string): Promise<void> {
    this.#data.delete(key.userProfile(uid));
  }

  async endSession(sid: string): Promise<void> {
    for (const k of [
      key.sessionState(sid),
      key.sessionTurns(sid),
      key.sessionPending(sid),
      key.sessionLock(sid),
    ]) {
      this.#data.delete(k);
    }
  }

  async close(): Promise<void> {
    this.#data.clear();
  }

  /** Test/debug only. */
  get size(): number {
    return this.#data.size;
  }
}
