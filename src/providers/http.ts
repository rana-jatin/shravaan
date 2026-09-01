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
 * A non-2xx IS infrastructure, so it throws rather than returning a value. The
 * tool executor maps a throw to `upstream_error` and the reviewed
 * `tool.unavailable` copy — contrast with a domain outcome ("no station for
 * that language"), which is data and gets returned.
 */
export async function getText(
  fetcher: HttpFetch,
  url: string,
  what: string,
  init?: HttpInit,
): Promise<string> {
  const res = await fetcher(url, init);
  if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}`);
  return res.text();
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
  init?: HttpInit,
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
