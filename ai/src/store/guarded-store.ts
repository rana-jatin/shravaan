/**
 * The store, behind a circuit breaker — slice 8.
 *
 * The degraded path for a Redis outage was already specified and already built:
 * "continue stateless on JSON context only" (docs/01-architecture.md section 6),
 * with `NullSessionStore` as its home. What was missing is that the degraded path
 * **never arrived on time**.
 *
 * `ioredis` against an unreachable server does not fail in the ~5 ms the latency
 * budget allocates. It fails after a connect timeout — on every call, on every
 * turn, forever. The conversation does keep going, technically, with several
 * seconds of dead air per turn while each read rediscovers an outage we already
 * knew about. A dependency outage had quietly become a latency outage, which is
 * the worse of the two.
 *
 * This wrapper makes the discovery happen once. After a few failures the circuit
 * opens, every call returns the empty answer immediately, and the companion
 * becomes shallow *and fast* instead of shallow *and broken*. A probe goes out
 * every so often; when Redis returns, so does the memory.
 *
 * Writes are fire-and-forget by contract, so a swallowed write is correct here.
 * Reads degrade to the same values `NullSessionStore` returns, so nothing
 * downstream needs a second code path.
 */

import {
  CircuitBreaker,
  DEFAULT_BREAKER,
  guard,
  type BreakerOptions,
  type BreakerState,
} from "../domain/circuit-breaker.ts";
import type { JsonContext, Profile, SessionState, Turn } from "@sp-i/shared/domain/types.ts";
import type { SessionStore, TurnContext } from "./session-store.ts";

export type GuardedStoreOptions = {
  breaker?: BreakerOptions;
  /** Called on every transition into or out of a degraded state. */
  onStateChange?: ((state: BreakerState, err: unknown) => void) | undefined;
  log?: ((level: string, msg: string, extra?: Record<string, unknown>) => void) | undefined;
};

const EMPTY_TURN_CONTEXT: TurnContext = { state: null, turns: [], profile: null };

export class GuardedSessionStore implements SessionStore {
  readonly #inner: SessionStore;
  readonly #breaker: CircuitBreaker;
  readonly #opts: GuardedStoreOptions;
  #lastState: BreakerState = "closed";

  constructor(inner: SessionStore, opts: GuardedStoreOptions = {}) {
    this.#inner = inner;
    this.#breaker = new CircuitBreaker(opts.breaker ?? DEFAULT_BREAKER);
    this.#opts = opts;
  }

  get healthy(): boolean {
    return this.#breaker.state === "closed";
  }

  get breakerState(): BreakerState {
    return this.#breaker.state;
  }

  #run<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    return guard(this.#breaker, fn, fallback, (err, state) => {
      if (err) {
        this.#opts.log?.("warn", "store call failed", {
          op: what,
          state,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (state !== this.#lastState) {
        this.#lastState = state;
        this.#opts.log?.(state === "closed" ? "info" : "warn", "store circuit", { state });
        this.#opts.onStateChange?.(state, err);
      }
    });
  }

  loadForTurn(sid: string, uid: string, windowSize: number): Promise<TurnContext> {
    // A fresh object each time: callers mutate the returned state in place.
    return this.#run("loadForTurn", () => this.#inner.loadForTurn(sid, uid, windowSize), {
      ...EMPTY_TURN_CONTEXT,
      turns: [],
    });
  }

  saveState(state: SessionState): Promise<void> {
    return this.#run("saveState", () => this.#inner.saveState(state), undefined);
  }
  loadState(sid: string): Promise<SessionState | null> {
    return this.#run("loadState", () => this.#inner.loadState(sid), null);
  }
  appendTurn(sid: string, turn: Turn, windowSize: number): Promise<void> {
    return this.#run("appendTurn", () => this.#inner.appendTurn(sid, turn, windowSize), undefined);
  }
  loadTurns(sid: string, windowSize: number): Promise<Turn[]> {
    return this.#run("loadTurns", () => this.#inner.loadTurns(sid, windowSize), []);
  }
  touch(sid: string): Promise<void> {
    return this.#run("touch", () => this.#inner.touch(sid), undefined);
  }

  /**
   * Grant the lock when the store is unreachable.
   *
   * Deliberate, and worth stating plainly: the lock exists so barge-in cannot
   * race a completing turn *within one process*. Denying it during an outage
   * would silently stop the user being answered at all, trading a rare
   * consistency risk for a guaranteed one. Losing the mutual exclusion across
   * replicas is the accepted cost of an outage.
   */
  acquireLock(sid: string, token: string): Promise<boolean> {
    return this.#run("acquireLock", () => this.#inner.acquireLock(sid, token), true);
  }
  releaseLock(sid: string, token: string): Promise<void> {
    return this.#run("releaseLock", () => this.#inner.releaseLock(sid, token), undefined);
  }

  loadContext(uid: string): Promise<JsonContext | null> {
    return this.#run("loadContext", () => this.#inner.loadContext(uid), null);
  }
  saveContext(ctx: JsonContext): Promise<void> {
    return this.#run("saveContext", () => this.#inner.saveContext(ctx), undefined);
  }
  invalidateContext(uid: string): Promise<void> {
    return this.#run("invalidateContext", () => this.#inner.invalidateContext(uid), undefined);
  }

  loadProfile(uid: string): Promise<Profile | null> {
    return this.#run("loadProfile", () => this.#inner.loadProfile(uid), null);
  }
  saveProfile(profile: Profile): Promise<void> {
    return this.#run("saveProfile", () => this.#inner.saveProfile(profile), undefined);
  }
  invalidateProfile(uid: string): Promise<void> {
    return this.#run("invalidateProfile", () => this.#inner.invalidateProfile(uid), undefined);
  }

  endSession(sid: string): Promise<void> {
    return this.#run("endSession", () => this.#inner.endSession(sid), undefined);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}
