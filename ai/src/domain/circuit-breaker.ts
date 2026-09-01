/**
 * Circuit breaker — slice 8.
 *
 * WHY THIS EXISTS, in one sentence: without it, a dependency outage becomes a
 * LATENCY outage, and the second is worse than the first.
 *
 * The concrete case is Redis. `docs/03-latency-budget.md` allocates ~5 ms to the
 * working-memory read. When Redis is unreachable, `ioredis` does not fail in 5 ms
 * — it hangs until its connect timeout, on every single call, on every single
 * turn. The session has a documented degraded path ("continue stateless on JSON
 * context only") and it works perfectly; it just never gets reached, because
 * every turn spends seconds discovering the outage afresh.
 *
 * So: fail fast, remember the failure, and probe occasionally. The point is not
 * to protect Redis. It is to make our OWN degraded path arrive on time.
 *
 * Pure and clock-injected — no timers, nothing to leak, testable without waiting.
 */

export type BreakerState = "closed" | "open" | "half_open";

export type BreakerOptions = {
  /** Consecutive failures before opening. */
  failureThreshold: number;
  /** How long to stay open before allowing one probe through. */
  openMs: number;
  now?: (() => number) | undefined;
};

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 3, openMs: 10_000 };

export class CircuitBreaker {
  readonly #opts: BreakerOptions;
  readonly #now: () => number;
  #failures = 0;
  #openedAt = 0;
  #probing = false;
  #state: BreakerState = "closed";

  constructor(opts: BreakerOptions = DEFAULT_BREAKER) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get state(): BreakerState {
    this.#refresh();
    return this.#state;
  }

  get failures(): number {
    return this.#failures;
  }

  /**
   * May a call go out right now?
   *
   * Half-open admits exactly ONE probe. Letting the whole backlog through the
   * moment the window elapses is how a recovering dependency gets knocked over
   * again by the traffic that was waiting for it.
   */
  canAttempt(): boolean {
    this.#refresh();
    if (this.#state === "closed") return true;
    if (this.#state === "open") return false;
    if (this.#probing) return false;
    this.#probing = true;
    return true;
  }

  onSuccess(): void {
    this.#failures = 0;
    this.#probing = false;
    this.#state = "closed";
  }

  onFailure(): void {
    this.#probing = false;
    this.#failures += 1;
    if (this.#failures >= this.#opts.failureThreshold) {
      this.#state = "open";
      this.#openedAt = this.#now();
    }
  }

  /** Force closed — used when a caller has independent evidence of recovery. */
  reset(): void {
    this.#failures = 0;
    this.#probing = false;
    this.#state = "closed";
  }

  #refresh(): void {
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#opts.openMs) {
      this.#state = "half_open";
      this.#probing = false;
    }
  }
}

/**
 * Run `fn` behind a breaker, returning `fallback` when the circuit is open or the
 * call fails.
 *
 * Deliberately never throws. Every caller in this system has a meaningful
 * degraded answer — an empty turn window, a null profile, a dropped write — and
 * a thrown error at these call sites would only be caught and converted into
 * exactly that value one frame up the stack.
 */
export async function guard<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
  fallback: T,
  /** `err` is null when the breaker refused the attempt rather than the call failing. */
  onTrip?: (err: unknown, state: BreakerState) => void,
): Promise<T> {
  if (!breaker.canAttempt()) {
    onTrip?.(null, breaker.state);
    return fallback;
  }
  try {
    const out = await fn();
    breaker.onSuccess();
    return out;
  } catch (err) {
    breaker.onFailure();
    onTrip?.(err, breaker.state);
    return fallback;
  }
}
