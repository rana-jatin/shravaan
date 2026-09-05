/**
 * The injectable HTTP surface, in one place.
 *
 * WHY THIS IS A TYPE AND NOT A WRAPPER. Nothing here does anything: it is the
 * narrowest slice of `fetch` this codebase actually uses, extracted so that a
 * test can hand a function to a provider and never open a socket. Every tool and
 * provider that leaves the process takes one of these, and `npm test` runs with
 * no credentials and no network because of it.
 *
 * It lives under providers/ rather than tools/ because both sides need it and
 * the dependency has to point one way. `src/tools/builtin.ts` re-exports the
 * type so the tools keep importing it from where they always did.
 *
 * `method` and `body` are optional because almost every caller is a GET —
 * weather, news, an iCal feed. Deepgram's `/v1/read` is the one POST, and
 * widening this by two optional fields is cheaper than a second near-identical
 * type that exists only to say "but this one posts".
 */

import { withBackoff, type BackoffPolicy } from "../domain/backoff.ts";

export type HttpFetch = (
  url: string,
  init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The real thing. `globalThis.fetch` already satisfies the surface above. */
export const nodeFetch = (): HttpFetch => globalThis.fetch;

/** Per-request options, named so callers do not repeat the indexed type. */
export type HttpInit = NonNullable<Parameters<HttpFetch>[1]>;

/**
 * How long a request may take before it is abandoned.
 *
 * ⚠ `fetch` HAS NO TIMEOUT OF ITS OWN. A request to a host that accepts the
 * connection and then says nothing hangs until the socket dies, which on a
 * mobile link can be minutes. Every caller here used to depend on the turn's
 * abort signal for that bound, and the caching work removed it from the shared
 * loads on purpose — a load one conversation started is now awaited by others,
 * so it must not be cancelled when the first person hangs up. This is what took
 * its place, and it is a property of the request rather than of the turn.
 *
 * Eight seconds, which is deliberately LONGER than the tool deadline
 * (NETWORK_MS, six). The two are different bounds: the deadline is how long a
 * person waits before being told something went wrong, and this is how long a
 * socket may stay open. A request that outlives its turn still populates the
 * cache for the next caller, and it is better that it finishes than that it is
 * killed a moment before it would have.
 */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * How an idempotent GET is retried.
 *
 * ONE ATTEMPT MORE, NOT FIVE. The whole call is inside a turn with a person
 * waiting in real time, so the budget is what binds: a second try that has not
 * landed within a second and a half was not going to save the turn. It is worth
 * having because the failure it covers is the common one — a single dropped
 * packet or a load balancer closing a connection — where the retry succeeds
 * immediately and nobody hears anything at all.
 *
 * Jittered like every other policy in this repo, for the reason spelled out at
 * the top of domain/backoff.ts: a rate limit is per account, so an un-jittered
 * retry marches every live conversation into the same instant.
 */
export const HTTP_GET_RETRY: BackoffPolicy = {
  baseMs: 200,
  maxDelayMs: 1000,
  maxAttempts: 2,
  budgetMs: 1500,
  jitter: true,
};

/** `HttpInit`, plus the two things `getText`/`getJson` add on top of `fetch`. */
export type RequestOptions = HttpInit & {
  /** Overrides DEFAULT_TIMEOUT_MS. Zero or less disables the timeout. */
  timeoutMs?: number;
  /**
   * Retry an idempotent request. Defaults to true FOR GET AND NOTHING ELSE.
   *
   * ⚠ THE METHOD IS THE GATE, and it is checked rather than trusted to the
   * caller. Retrying a POST is how one telemetry reading becomes two rows, or
   * one email becomes two — and the caller who would forget to turn it off is
   * exactly the caller adding a new POST in six months.
   */
  retry?: boolean;
};

/**
 * A non-2xx IS infrastructure, so it throws rather than returning a value. The
 * tool executor maps a throw to `upstream_error` and the reviewed
 * `tool.unavailable` copy — contrast with a domain outcome ("no station for
 * that language"), which is data and gets returned.
 *
 * Bounded by a timeout and, for a GET, retried once. See the two constants
 * above for why each is the shape it is.
 */
export async function getText(
  fetcher: HttpFetch,
  url: string,
  what: string,
  init?: RequestOptions,
): Promise<string> {
  const idempotent = (init?.method ?? "GET").toUpperCase() === "GET";
  const retry = (init?.retry ?? true) && idempotent;

  const attempt = async (): Promise<string> => {
    const res = await request(fetcher, url, what, init);
    // A non-2xx is checked BEFORE the body is read, so a 503 costs nothing
    // beyond the headers. The message names the service because the alternative
    // — a bare "HTTP 503" — reaches an operator with no way to tell which of
    // four upstreams a turn was talking to.
    if (!res.ok) throw new UpstreamError(what, res.status);
    return res.text();
  };

  if (!retry) return attempt();

  return withBackoff(attempt, {
    policy: HTTP_GET_RETRY,
    retryable: isRetryable,
    // The caller's own signal, when it has one. A barge-in must not be waited
    // out — `withBackoff` checks it before every attempt and before sleeping.
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}

/**
 * A non-2xx, carrying the status so the retry policy can read it.
 *
 * Message unchanged from the string this used to throw, because two tests and
 * an operator's grep both match on it.
 */
export class UpstreamError extends Error {
  readonly status: number;
  constructor(what: string, status: number) {
    super(`${what} returned HTTP ${status}`);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/**
 * Which failures are worth trying again.
 *
 * A 5xx, a 429 and a network-level failure are transient by definition. A 4xx
 * is us: a malformed query, a revoked key, a place name with a stray byte in
 * it. Retrying one is a bug that hides itself, because the second attempt fails
 * identically and the log says "gave up after 2".
 *
 * A TIMEOUT IS NOT RETRIED, which is the non-obvious one. It has already spent
 * eight seconds, and the turn's own deadline is six — a second attempt cannot
 * finish in time to be spoken, so it would only mean another eight seconds of
 * socket for an answer nobody will hear.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamError) return err.status >= 500 || err.status === 429;
  // A TypeError is what `fetch` throws for DNS failure, a refused connection
  // and a dropped socket — the exact case this retry exists for. Everything
  // else, a timeout included, falls through to false.
  return err instanceof TypeError;
}

/**
 * One attempt, with the timeout attached and the timeout error made legible.
 *
 * `AbortSignal.any` rather than replacing the caller's signal: a barge-in and a
 * timeout are different reasons to stop, and both have to be able to fire. A
 * caller that supplied a signal keeps it.
 */
async function request(
  fetcher: HttpFetch,
  url: string,
  what: string,
  init?: RequestOptions,
): Promise<Awaited<ReturnType<HttpFetch>>> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { timeoutMs: _t, retry: _r, ...rest } = init ?? {};

  if (timeoutMs <= 0) return fetcher(url, rest);

  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, deadline]) : deadline;

  try {
    return await fetcher(url, { ...rest, signal });
  } catch (err) {
    // A timeout reaches the caller as a sentence naming the service and the
    // bound it crossed. Left alone it is "The operation was aborted due to
    // timeout", which says nothing about which of four upstreams stalled.
    //
    // The caller's own abort is NOT rewritten: a barge-in is not a timeout, and
    // reporting it as one would put "the news feed timed out" in the log every
    // time somebody interrupted the device mid-sentence.
    const timedOut = deadline.aborted || (err instanceof Error && err.name === "TimeoutError");
    if (timedOut) throw new Error(`${what} did not respond within ${timeoutMs}ms`);
    throw err;
  }
}

/**
 * `getText`, plus the parse — and the parse is the point.
 *
 * Four call sites used to write `JSON.parse(await res.text())` inline, and two
 * of them did it UNGUARDED. An upstream that answers 200 with an HTML error page
 * (a captive portal, a proxy, a rate-limit interstitial) then threw a bare
 * SyntaxError from inside a tool handler instead of a sentence naming the
 * service that misbehaved. Everything routed through here fails the same,
 * legible way.
 */
export async function getJson<T = unknown>(
  fetcher: HttpFetch,
  url: string,
  what: string,
  init?: RequestOptions,
): Promise<T> {
  const body = await getText(fetcher, url, what, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${what} returned unparseable JSON`);
  }
}
