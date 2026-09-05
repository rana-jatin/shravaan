/**
 * Retry with backoff — slice 8.
 *
 * IT LIVES IN `shared/` BECAUSE THREE PACKAGES NOW NEED IT. It began beside the
 * turn loop, which was where the only caller was; it is also what bounds a TTS
 * socket reconnect, and now what retries an idempotent GET inside
 * `shared/providers/http.ts` — and `shared` cannot import from `ai`, so a copy
 * there would have been a second implementation of the one thing in this file
 * that must not be got twice (see jitter, below).
 *
 * The POLICIES below are turn-loop-shaped and stay with the mechanism rather
 * than being split across packages: they are data, and a reader comparing
 * "how patient is the LLM path" with "how patient is a socket" should not have
 * to open two files to do it.
 *
 * TWO PROPERTIES MATTER HERE AND BOTH ARE EASY TO GET WRONG.
 *
 * 1. JITTER IS NOT DECORATION. Sarvam-105B's rate limit is per account, not per
 *    session (40 req/min Starter — docs/adr/0003-llm.md). When it trips it trips
 *    for every live conversation at once. Un-jittered backoff marches all of them
 *    into the same retry instant and the limit trips again, forever. Full jitter
 *    spreads them out, which is the only thing that actually drains the queue.
 *
 * 2. THE BUDGET IS THE POINT, NOT THE ATTEMPT COUNT. There is a person waiting in
 *    real time. Six perfectly-spaced retries that resolve after nine seconds are
 *    a worse outcome than giving up at two and saying something. So the loop stops
 *    when the NEXT delay would cross the budget, not when attempts run out.
 *
 * Nothing here reads a clock or sleeps on its own — both are injected — so the
 * policies are testable without waiting for wall-clock time to pass.
 */

export type BackoffPolicy = {
  /** First delay before jitter. Subsequent delays double it. */
  baseMs: number;
  /** Ceiling on a single delay, before jitter. */
  maxDelayMs: number;
  /** Total attempts including the first. 1 means "no retry". */
  maxAttempts: number;
  /**
   * Give up once the cumulative wait would exceed this. The user's patience, not
   * the provider's, is the binding constraint.
   */
  budgetMs: number;
  /** Full jitter. Off only in tests and when a provider dictates the wait. */
  jitter: boolean;
};

/**
 * The LLM path. Short and shallow on purpose: a 429 that has not cleared in ~2.5s
 * will not clear inside a turn, and the honest move is to say so.
 */
export const LLM_RETRY: BackoffPolicy = {
  baseMs: 250,
  maxDelayMs: 2000,
  maxAttempts: 3,
  budgetMs: 2500,
  jitter: true,
};

/**
 * Socket reconnects. Longer budget than the LLM path because a reconnect happens
 * BETWEEN utterances (the ~1 min Bulbul idle close lands in a conversational
 * pause), so nobody is mid-sentence while it runs.
 */
export const SOCKET_RECONNECT: BackoffPolicy = {
  baseMs: 200,
  maxDelayMs: 5000,
  maxAttempts: 5,
  budgetMs: 15000,
  jitter: true,
};

/** Uncapped exponential step for `attempt` (0-based), before jitter. */
export function rawDelayFor(attempt: number, p: BackoffPolicy): number {
  return Math.min(p.maxDelayMs, p.baseMs * 2 ** Math.max(0, attempt));
}

/**
 * Full jitter: uniform over [0, raw]. Deliberately not "raw/2 + jitter" — the
 * whole population must be able to land early, or the herd stays a herd.
 */
export function delayFor(
  attempt: number,
  p: BackoffPolicy,
  rand: () => number = Math.random,
): number {
  const raw = rawDelayFor(attempt, p);
  return p.jitter ? Math.floor(rand() * raw) : raw;
}

/** The worst-case schedule. Used by tests and by the docs table. */
export function retryPlan(p: BackoffPolicy): number[] {
  const out: number[] = [];
  let elapsed = 0;
  for (let attempt = 0; attempt < p.maxAttempts - 1; attempt++) {
    const d = rawDelayFor(attempt, p);
    if (elapsed + d > p.budgetMs) break;
    out.push(d);
    elapsed += d;
  }
  return out;
}

export type RetryInfo = {
  /** 0-based index of the attempt that just failed. */
  attempt: number;
  delayMs: number;
  /** Wall time since the first attempt started. */
  elapsedMs: number;
  err: unknown;
};

export type WithBackoffOptions = {
  policy: BackoffPolicy;
  /** Anything this rejects propagates immediately. Retrying a 400 is a bug. */
  retryable: (err: unknown) => boolean;
  /**
   * A provider-dictated wait (Retry-After). Honoured when it is LONGER than our
   * own delay — ignoring it is how an account gets throttled harder — but still
   * subject to the budget, so an absurd value ends the turn instead of stalling it.
   */
  retryAfter?: ((err: unknown) => number | undefined) | undefined;
  onRetry?: ((info: RetryInfo) => void) | undefined;
  onGiveUp?: ((info: { attempts: number; elapsedMs: number; err: unknown }) => void) | undefined;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  rand?: (() => number) | undefined;
};

export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithBackoffOptions,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const rand = opts.rand ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const started = now();

  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.policy.maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new AbortError();
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;

      // A barge-in cancels the turn outright. Retrying into an abandoned turn
      // makes the agent answer a question the user already moved on from.
      if (opts.signal?.aborted) throw err;
      if (!opts.retryable(err)) throw err;
      if (attempt === opts.policy.maxAttempts - 1) break;

      const ours = delayFor(attempt, opts.policy, rand);
      const theirs = opts.retryAfter?.(err);
      const delayMs = theirs !== undefined ? Math.max(ours, theirs) : ours;

      const elapsedMs = now() - started;
      // Budget check happens BEFORE sleeping. Discovering afterwards that we
      // overshot has already spent the silence we were trying to protect.
      if (elapsedMs + delayMs > opts.policy.budgetMs) break;

      opts.onRetry?.({ attempt, delayMs, elapsedMs, err });
      await sleep(delayMs, opts.signal);
    }
  }

  opts.onGiveUp?.({
    attempts: opts.policy.maxAttempts,
    elapsedMs: now() - started,
    err: lastErr,
  });
  throw lastErr;
}

/** unref'd: a pending retry must never be the reason a process refuses to exit. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export class AbortError extends Error {
  override readonly name = "AbortError";
  constructor() {
    super("aborted before the attempt was made");
  }
}
