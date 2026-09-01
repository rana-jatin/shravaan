/**
 * Google Calendar API v3 — the scope-bearing path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS ALONGSIDE THE iCal FEED.
 *
 * The iCal reader in src/domain/ical.ts needs no credential at all and stays
 * the fallback. This is the upgrade, and the reason is not writing — it is that
 * `singleEvents=true` makes GOOGLE expand the recurrences.
 *
 * Our own expander is ~200 lines and had seven defects in it (see D10 in
 * docs/07-defect-register.md), every one of which spoke a wrong appointment
 * aloud as fact. Google's handles BYSETPOS, BYMONTHDAY, RDATE and real TZID
 * conversion, none of which ours does. Handing that problem back to the people
 * who defined the format is worth more than the write capability.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ WHAT AN API KEY CAN AND CANNOT DO. This is the single most expensive thing
 * to learn late, so it is enforced in code rather than left to a comment.
 *
 * A key answers "which project is calling". It carries NO user identity and
 * therefore no scope. Per Google's own discovery document, every write method
 * (events.insert/update/patch/delete) requires one of `calendar`,
 * `calendar.app.created`, `calendar.events` or `calendar.events.owned`.
 *
 *   read a PUBLIC calendar with a key ....... yes
 *   read a PRIVATE calendar with a key ...... no  (401/404, never partial)
 *   write anything at all with a key ........ no  (no public write scope exists)
 *
 * So `api_key` mode refuses writes locally, with a message naming the fix,
 * rather than letting the model discover it as a 401 mid-conversation.
 */

import { createSign } from "node:crypto";
import type { CalendarEvent } from "../domain/ical.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/calendar/v3";

/** Refresh this far before expiry, so a token cannot die mid-request. */
const TOKEN_SKEW_MS = 60_000;

export type GoogleAuth =
  | { mode: "api_key"; key: string }
  /**
   * A service account, shared with like a person: the user opens Google
   * Calendar, Settings > Share with specific people, and pastes the account's
   * `client_email`. No consent screen, no refresh-token lifecycle, and it works
   * on a consumer Gmail calendar — which is what makes it the only credential
   * an elderly user's caregiver can realistically set up once and forget.
   */
  | { mode: "service_account"; clientEmail: string; privateKey: string };

export type GoogleCalendarDeps = {
  auth: GoogleAuth;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests, so token expiry is assertable without waiting. */
  now?: () => number;
};

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Written-out reason a call was refused, for the tool to turn into speech. */
export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarAuthError";
  }
}

export class GoogleCalendar {
  readonly #auth: GoogleAuth;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(deps: GoogleCalendarDeps) {
    this.#auth = deps.auth;
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#now = deps.now ?? Date.now;
  }

  /** True when this credential is capable of modifying a calendar at all. */
  get canWrite(): boolean {
    return this.#auth.mode === "service_account";
  }

  /**
   * Mint (or reuse) an access token for a service account.
   *
   * RS256 over a JWT assertion, exchanged at Google's token endpoint. Done with
   * node:crypto rather than a dependency: it is thirty lines, and a calendar
   * credential is not a thing to hand to a transitive dependency tree.
   */
  async #accessToken(): Promise<string> {
    if (this.#auth.mode !== "service_account") {
      throw new CalendarAuthError("an API key cannot mint an access token");
    }
    const now = this.#now();
    if (this.#token && this.#token.expiresAt - TOKEN_SKEW_MS > now) return this.#token.value;

    const iat = Math.floor(now / 1000);
    const claims = {
      iss: this.#auth.clientEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    };
    const signingInput =
      `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
      `${base64url(JSON.stringify(claims))}`;

    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    const assertion = `${signingInput}.${base64url(signer.sign(this.#auth.privateKey))}`;

    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body["access_token"] !== "string") {
      // `error_description` is where Google puts the actionable half — a clock
      // skew, a disabled account, an unshared calendar.
      throw new CalendarAuthError(
        `token exchange failed (HTTP ${res.status}): ${String(body["error_description"] ?? body["error"] ?? "no access_token")}`,
      );
    }

    const ttlMs = (typeof body["expires_in"] === "number" ? body["expires_in"] : 3600) * 1000;
    this.#token = { value: body["access_token"], expiresAt: now + ttlMs };
    return this.#token.value;
  }

  async #request(
    path: string,
    init: { method?: string; query?: Record<string, string>; body?: unknown; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#auth.mode === "api_key") {
      url.searchParams.set("key", this.#auth.key);
    } else {
      headers["authorization"] = `Bearer ${await this.#accessToken()}`;
    }
    if (init.body !== undefined) headers["content-type"] = "application/json";

    const res = await this.#fetch(url.toString(), {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });

    if (res.status === 204) return {};
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (body["error"] ?? {}) as Record<string, unknown>;
      const message = String(err["message"] ?? `HTTP ${res.status}`);
      // 401 and 403 against a private calendar are the signature of a key being
      // used where a scope is needed. Say so once, here, rather than letting it
      // surface as a generic tool failure.
      if ((res.status === 401 || res.status === 403) && this.#auth.mode === "api_key") {
        throw new CalendarAuthError(
          `${message} — an API key can only read PUBLIC calendars. ` +
            `Share the calendar with a service account and set GOOGLE_SERVICE_ACCOUNT_JSON.`,
        );
      }
      throw new Error(`google calendar: ${message}`);
    }
    return body;
  }

  /**
   * Events in `[from, to)`, already expanded and already sorted.
   *
   * `singleEvents=true` is the whole point: Google turns every RRULE, RDATE,
   * EXDATE and RECURRENCE-ID override into concrete instances, in the
   * calendar's real timezone. `orderBy=startTime` is only legal alongside it.
   */
  async listEvents(opts: {
    calendarId: string;
    from: Date;
    to: Date;
    limit?: number;
    timezone?: string;
    signal?: AbortSignal;
  }): Promise<CalendarEvent[]> {
    const body = await this.#request(`/calendars/${encodeURIComponent(opts.calendarId)}/events`, {
      query: {
        timeMin: opts.from.toISOString(),
        timeMax: opts.to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(opts.limit ?? 25),
        ...(opts.timezone ? { timeZone: opts.timezone } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const items = Array.isArray(body["items"]) ? (body["items"] as Record<string, unknown>[]) : [];
    const out: CalendarEvent[] = [];
    for (const item of items) {
      // Google returns cancelled instances of a recurring event in the list.
      if (String(item["status"] ?? "") === "cancelled") continue;
      const summary = typeof item["summary"] === "string" ? item["summary"].trim() : "";
      if (!summary) continue; // Nothing to say, so nothing to report.

      const start = toDate(item["start"]);
      if (!start) continue;
      const end = toDate(item["end"]);

      out.push({
        uid: String(item["id"] ?? `${summary}-${start.date.toISOString()}`),
        summary,
        location: typeof item["location"] === "string" ? item["location"].trim() : null,
        start: start.date,
        end: end?.date ?? null,
        allDay: start.allDay,
      });
    }
    return out;
  }

  /**
   * Create an event. Refused locally under an API key — see the header.
   *
   * `start`/`end` are WALL CLOCK in `timezone`, not instants: `2026-09-04` for
   * an all-day event, `2026-09-04T15:00:00` otherwise. Google resolves the
   * offset itself when `dateTime` carries none and `timeZone` is given, which
   * is worth more than it sounds — computing that offset here would mean either
   * a tz database or the kind of arithmetic that silently moves a hospital
   * appointment by half an hour twice a year.
   */
  async insertEvent(opts: {
    calendarId: string;
    summary: string;
    start: string;
    end: string;
    timezone: string;
    location?: string;
    signal?: AbortSignal;
  }): Promise<{ id: string; htmlLink: string | null }> {
    this.#assertWritable("create an appointment");

    const stamp = (v: string) =>
      v.includes("T") ? { dateTime: v, timeZone: opts.timezone } : { date: v };

    const body = await this.#request(`/calendars/${encodeURIComponent(opts.calendarId)}/events`, {
      method: "POST",
      body: {
        summary: opts.summary,
        start: stamp(opts.start),
        end: stamp(opts.end),
        ...(opts.location ? { location: opts.location } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    return {
      id: String(body["id"] ?? ""),
      htmlLink: typeof body["htmlLink"] === "string" ? body["htmlLink"] : null,
    };
  }

  /**
   * Cancel an event.
   *
   * DELETE rather than a status change, because that is the only verb the API
   * offers — which is exactly why the TOOL that calls this must confirm out
   * loud first. A voice agent that mishears has no screen on which the user
   * could notice a hospital appointment quietly disappearing.
   */
  async deleteEvent(opts: {
    calendarId: string;
    eventId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    this.#assertWritable("cancel an appointment");
    await this.#request(
      `/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.eventId)}`,
      { method: "DELETE", ...(opts.signal ? { signal: opts.signal } : {}) },
    );
  }

  #assertWritable(action: string): void {
    if (this.canWrite) return;
    throw new CalendarAuthError(
      `cannot ${action}: an API key carries no OAuth scope, and every Google Calendar ` +
        `write method requires one. Share the calendar with a service account and set ` +
        `GOOGLE_SERVICE_ACCOUNT_JSON.`,
    );
  }
}

/** `{date}` for all-day, `{dateTime}` otherwise. Google never sends both. */
function toDate(value: unknown): { date: Date; allDay: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  if (typeof v["date"] === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v["date"]);
    if (!m) return null;
    // Local midnight, matching how the iCal path represents an all-day event.
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  if (typeof v["dateTime"] === "string") {
    const d = new Date(v["dateTime"]);
    return Number.isNaN(d.getTime()) ? null : { date: d, allDay: false };
  }
  return null;
}

/**
 * Read a service account from either an inline JSON blob or a path to the file
 * Google Cloud downloads.
 *
 * Returns null rather than throwing when unset, so an unconfigured deployment
 * simply does not register the tool — the same rule as every other external
 * capability here.
 */
export function parseServiceAccount(
  raw: string | null,
  readFile: (p: string) => string,
): { clientEmail: string; privateKey: string } | null {
  const value = raw?.trim();
  if (!value) return null;

  let json: string;
  if (value.startsWith("{")) {
    json = value;
  } else {
    try {
      json = readFile(value);
    } catch (err) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON: cannot read ${value}: ${String(err)}`);
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const clientEmail = parsed["client_email"];
  const privateKey = parsed["private_key"];
  if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key — " +
        "use the JSON Google Cloud downloads, not the OAuth client secret file",
    );
  }
  // A key pasted through a shell or a .env line arrives with literal \n.
  return { clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
}
