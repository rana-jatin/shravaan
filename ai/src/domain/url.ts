/**
 * URL handling for config that a human typed.
 *
 * Both helpers were private to src/server.ts and are needed by two composition
 * modules now, so they live here rather than in two copies.
 */

/** Parses as http(s). Anything else in NEWS_FEEDS is config damage, not a feed. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Enough of a URL to debug it, never enough to use it.
 *
 * A calendar feed needs no API key, which makes it easy to forget that THE URL
 * IS THE CREDENTIAL: Google's "secret address in iCal format" carries a
 * `private-<hash>` segment, and anyone holding it can read that person's whole
 * diary, indefinitely, with no login and no audit trail. So it is a secret that
 * happens to be shaped like a link — and a link is exactly the kind of thing
 * that gets pasted into a log, a ticket or a screenshot without a second look.
 *
 * The host is the useful half for diagnosis ("that isn't Google at all"); the
 * path is the half worth protecting.
 */
export function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}/… (${value.length} chars)`;
  } catch {
    // Unparseable is the common case here — that is usually why it was dropped.
    return `<unparseable, ${value.length} chars, starts "${value.slice(0, 12)}">`;
  }
}
