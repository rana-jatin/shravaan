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

/** The real thing, cast to the narrow surface above. */
export const nodeFetch = (): HttpFetch => globalThis.fetch;
