/**
 * The Google Calendar API client.
 *
 * Hermetic: no credential, no network. The service-account tests generate a
 * real RSA keypair with node:crypto and verify the assertion we sign against
 * it, so the JWT path is genuinely exercised rather than mocked past — the
 * signing is the one part that cannot be checked by reading it.
 *
 * The API-KEY tests carry the most product weight. A key looks like a working
 * credential right up until it isn't, and the failure lands mid-conversation
 * as a 401 the user hears as "sorry, I can't reach your calendar". These pin
 * the refusal to boot time and to a message that names the fix.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";

import {
  CalendarAuthError,
  GoogleCalendar,
  parseServiceAccount,
} from "../src/providers/google-calendar.ts";
import { createAddAppointment } from "../src/tools/calendar.ts";
import { fakeHost, invocation, jsonFetch } from "./helpers.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const account = { clientEmail: "sp-i@example.iam.gserviceaccount.com", privateKey };

/** Records every request, and answers the token endpoint before anything else. */
function recordingFetch(apiBody: unknown, status = 200) {
  const calls: { url: string; method: string; body: string | null; auth: string | null }[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers["authorization"] ?? null,
    });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "tok-abc", expires_in: 3600 }),
      } as Response;
    }
    return {
      ok: status < 300,
      status,
      json: async () => apiBody,
    } as Response;
  }) as typeof globalThis.fetch;
  return { fetch: f, calls };
}

describe("an API key is not a scope", () => {
  it("refuses a write locally, naming the fix", async () => {
    // Never reaches the network: Google's discovery document requires an OAuth
    // scope on every write method, and a key carries none. Failing here beats
    // failing as a 401 the user hears mid-sentence.
    const cal = new GoogleCalendar({ auth: { mode: "api_key", key: "k" }, fetch: jsonFetch({}) });

    assert.equal(cal.canWrite, false);
    await assert.rejects(
      () =>
        cal.insertEvent({
          calendarId: "primary",
          summary: "x",
          start: "2026-09-04T10:00:00",
          end: "2026-09-04T11:00:00",
          timezone: "Asia/Kolkata",
        }),
      (err: Error) =>
        err instanceof CalendarAuthError && /GOOGLE_SERVICE_ACCOUNT_JSON/.test(err.message),
    );
  });

  it("refuses a delete locally too", async () => {
    const cal = new GoogleCalendar({ auth: { mode: "api_key", key: "k" }, fetch: jsonFetch({}) });
    await assert.rejects(
      () => cal.deleteEvent({ calendarId: "primary", eventId: "e" }),
      CalendarAuthError,
    );
  });

  it("puts the key in the query and sends no bearer token", async () => {
    const rec = recordingFetch({ items: [] });
    const cal = new GoogleCalendar({
      auth: { mode: "api_key", key: "secret-key" },
      fetch: rec.fetch,
    });
    await cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() });

    assert.equal(rec.calls.length, 1, "no token exchange for a key");
    assert.ok(rec.calls[0]!.url.includes("key=secret-key"));
    assert.equal(rec.calls[0]!.auth, null);
  });

  it("turns a 403 on a private calendar into an explanation, not a bare error", async () => {
    // The exact failure someone hits after pasting a key and pointing it at
    // their own diary. The message has to carry the diagnosis with it.
    const cal = new GoogleCalendar({
      auth: { mode: "api_key", key: "k" },
      fetch: jsonFetch({ error: { message: "Not Found" } }, 403),
    });
    await assert.rejects(
      () => cal.listEvents({ calendarId: "primary", from: new Date(), to: new Date() }),
      (err: Error) => err instanceof CalendarAuthError && /PUBLIC calendars/.test(err.message),
    );
  });
});

describe("service account", () => {
  it("signs an assertion the public key actually verifies", async () => {
    const rec = recordingFetch({ items: [] });
    const cal = new GoogleCalendar({
      auth: { mode: "service_account", ...account },
      fetch: rec.fetch,
    });
    await cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() });

    const token = rec.calls.find((c) => c.url.includes("oauth2.googleapis.com"));
    assert.ok(token, "a token exchange happened");
    const assertion = new URLSearchParams(token.body!).get("assertion")!;
    const [h, p, sig] = assertion.split(".");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    assert.ok(
      verifier.verify(createPublicKey(publicKey), Buffer.from(sig!, "base64url")),
      "signature verifies against the service account's public key",
    );

    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
    assert.equal(claims["iss"], account.clientEmail);
    assert.equal(claims["aud"], "https://oauth2.googleapis.com/token");
    assert.equal(claims["scope"], "https://www.googleapis.com/auth/calendar");
    assert.ok((claims["exp"] as number) > (claims["iat"] as number));
  });

  it("sends the token as a bearer and reuses it", async () => {
    const rec = recordingFetch({ items: [] });
    const cal = new GoogleCalendar({
      auth: { mode: "service_account", ...account },
      fetch: rec.fetch,
    });
    await cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() });
    await cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() });

    const exchanges = rec.calls.filter((c) => c.url.includes("oauth2.googleapis.com"));
    assert.equal(exchanges.length, 1, "token cached across calls");
    const api = rec.calls.filter((c) => !c.url.includes("oauth2.googleapis.com"));
    assert.equal(api.length, 2);
    assert.ok(api.every((c) => c.auth === "Bearer tok-abc"));
    assert.ok(
      api.every((c) => !c.url.includes("key=")),
      "no API key alongside a bearer token",
    );
  });

  it("re-mints a token once it is close to expiry", async () => {
    let clock = 1_000_000;
    const rec = recordingFetch({ items: [] });
    const cal = new GoogleCalendar({
      auth: { mode: "service_account", ...account },
      fetch: rec.fetch,
      now: () => clock,
    });
    await cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() });
    clock += 3600_000; // the full hour the fake token was good for
    await cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() });

    assert.equal(rec.calls.filter((c) => c.url.includes("oauth2")).length, 2);
  });

  it("says what went wrong when the exchange is rejected", async () => {
    // Google puts the actionable half in error_description — a clock skew, a
    // disabled account, a calendar that was never shared.
    const cal = new GoogleCalendar({
      auth: { mode: "service_account", ...account },
      fetch: jsonFetch(
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        400,
      ),
    });
    await assert.rejects(
      () => cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() }),
      /Invalid JWT Signature/,
    );
  });

  it("asks Google to expand the recurrences", () => {
    // The whole reason to prefer the API. `orderBy=startTime` is only legal
    // alongside singleEvents, so the two travel together.
    const rec = recordingFetch({ items: [] });
    const cal = new GoogleCalendar({ auth: { mode: "api_key", key: "k" }, fetch: rec.fetch });
    return cal.listEvents({ calendarId: "c", from: new Date(), to: new Date() }).then(() => {
      const url = rec.calls[0]!.url;
      assert.ok(url.includes("singleEvents=true"), url);
      assert.ok(url.includes("orderBy=startTime"), url);
    });
  });
});

describe("reading what Google returns", () => {
  const cal = (items: unknown[]) =>
    new GoogleCalendar({ auth: { mode: "api_key", key: "k" }, fetch: jsonFetch({ items }) });

  const list = (items: unknown[]) =>
    cal(items).listEvents({ calendarId: "c", from: new Date(), to: new Date() });

  it("reads an all-day event as all-day", async () => {
    const [e] = await list([{ id: "a", summary: "Diwali", start: { date: "2026-11-08" } }]);
    assert.equal(e?.allDay, true);
    assert.equal(e?.start.getDate(), 8);
    assert.equal(e?.start.getMonth(), 10);
  });

  it("reads a timed event with its offset", async () => {
    const [e] = await list([
      {
        id: "b",
        summary: "Doctor",
        location: "City Hospital",
        start: { dateTime: "2026-09-04T10:30:00+05:30" },
        end: { dateTime: "2026-09-04T11:00:00+05:30" },
      },
    ]);
    assert.equal(e?.allDay, false);
    assert.equal(e?.location, "City Hospital");
    assert.equal(e?.start.toISOString(), "2026-09-04T05:00:00.000Z");
  });

  it("drops a cancelled instance", async () => {
    // Google returns cancelled occurrences of a recurring event in the list.
    // Reading one out as an appointment is the failure this prevents.
    const out = await list([
      { id: "c", status: "cancelled", summary: "Called off", start: { date: "2026-09-04" } },
      { id: "d", status: "confirmed", summary: "Real", start: { date: "2026-09-04" } },
    ]);
    assert.deepEqual(
      out.map((e) => e.summary),
      ["Real"],
    );
  });

  it("skips an entry with nothing to say", async () => {
    assert.deepEqual(await list([{ id: "e", start: { date: "2026-09-04" } }]), []);
    assert.deepEqual(await list([{ id: "f", summary: "  ", start: { date: "2026-09-04" } }]), []);
  });

  it("survives a malformed item without losing the good ones", async () => {
    const out = await list([
      { id: "g", summary: "Broken", start: { dateTime: "not a date" } },
      { id: "h", summary: "Fine", start: { date: "2026-09-04" } },
    ]);
    assert.deepEqual(
      out.map((e) => e.summary),
      ["Fine"],
    );
  });
});

describe("parseServiceAccount", () => {
  const read = () => {
    throw new Error("should not read a file");
  };

  it("is absent rather than broken when unset", () => {
    assert.equal(parseServiceAccount(null, read), null);
    assert.equal(parseServiceAccount("   ", read), null);
  });

  it("accepts inline JSON and unescapes a newline-mangled key", () => {
    // A PEM pasted through a .env line arrives with literal backslash-n, and
    // node:crypto rejects it silently-looking — "error:1E08010C" and nothing else.
    const out = parseServiceAccount(
      JSON.stringify({
        client_email: "a@b.iam.gserviceaccount.com",
        private_key: "-----A\\nB-----",
      }),
      read,
    );
    assert.equal(out?.privateKey, "-----A\nB-----");
  });

  it("reads a path to the file Google Cloud downloads", () => {
    const out = parseServiceAccount("/keys/sa.json", () =>
      JSON.stringify({ client_email: "a@b", private_key: "k" }),
    );
    assert.equal(out?.clientEmail, "a@b");
  });

  it("names the likely mistake when handed the wrong file", () => {
    // Downloading the OAuth client secret instead of the service-account key is
    // the common wrong turn, and both are JSON that parses fine.
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ installed: { client_id: "x" } }), read),
      /client_email or private_key/,
    );
  });
});

describe("add_appointment", () => {
  const ctx = () => invocation({ host: fakeHost({ timezone: () => "Asia/Kolkata" }) });

  function tool(rec = recordingFetch({ id: "new-1", htmlLink: "https://cal" })) {
    const client = new GoogleCalendar({
      auth: { mode: "service_account", ...account },
      fetch: rec.fetch,
    });
    return {
      spec: createAddAppointment({ client, calendarId: "primary", label: "your calendar" }),
      rec,
    };
  }

  /**
   * The event body we sent.
   *
   * NOT simply the first POST: minting the service-account token is also a
   * POST, and it goes first, so a naive search reads the JWT exchange instead.
   */
  const written = (rec: ReturnType<typeof recordingFetch>) =>
    JSON.parse(
      rec.calls.find((c) => c.method === "POST" && !c.url.includes("oauth2.googleapis.com"))!.body!,
    );

  it("writes a timed event as wall clock plus a timezone", async () => {
    // Never an instant: handing Google the offset ourselves is how an
    // appointment moves by half an hour twice a year.
    const { spec, rec } = tool();
    const out = await spec.handler(
      { what: "Doctor", date: "2026-09-04", time_24h: "10:30", duration_minutes: 45 },
      ctx(),
    );

    assert.equal(out["saved"], true);
    const body = written(rec);
    assert.deepEqual(body.start, { dateTime: "2026-09-04T10:30:00", timeZone: "Asia/Kolkata" });
    assert.deepEqual(body.end, { dateTime: "2026-09-04T11:15:00", timeZone: "Asia/Kolkata" });
  });

  it("gives an all-day event the exclusive end Google expects", async () => {
    // Same start and end makes a zero-length event that some clients then do
    // not show at all — an appointment that saved successfully and vanished.
    const { spec, rec } = tool();
    await spec.handler({ what: "Amma visiting", date: "2026-09-04" }, ctx());

    const body = written(rec);
    assert.deepEqual(body.start, { date: "2026-09-04" });
    assert.deepEqual(body.end, { date: "2026-09-05" });
  });

  it("rolls an end time past midnight onto the next day", async () => {
    const { spec, rec } = tool();
    await spec.handler(
      { what: "Late call", date: "2026-09-04", time_24h: "23:30", duration_minutes: 60 },
      ctx(),
    );
    assert.equal(written(rec).end.dateTime, "2026-09-05T00:30:00");
  });

  it("hands back what was WRITTEN, for the companion to read aloud", async () => {
    // Same reasoning as asked_for on get_weather (D9): the only way a listener
    // can catch a misheard date is hearing the saved one back.
    const { spec } = tool();
    const out = await spec.handler(
      { what: "Physio", date: "2026-09-04", time_24h: "09:00", where: "Clinic" },
      ctx(),
    );
    assert.deepEqual(out["confirm_back"], {
      what: "Physio",
      day: "Friday 4 September",
      time_24h: "09:00",
      where: "Clinic",
    });
  });

  it("returns a domain outcome for bad input rather than throwing", async () => {
    // A thrown error spends the reviewed unavailable copy in eleven languages.
    // A refusal the model can rephrase costs nothing.
    const { spec } = tool();
    assert.equal(
      (await spec.handler({ what: "x", date: "next tuesday" }, ctx()))["reason"],
      "bad_date",
    );
    assert.equal(
      (await spec.handler({ what: "", date: "2026-09-04" }, ctx()))["reason"],
      "missing_what",
    );
    assert.equal(
      (await spec.handler({ what: "x", date: "2026-09-04", time_24h: "25:00" }, ctx()))["reason"],
      "bad_time",
    );
  });

  it("is not registrable at all against a key-only credential", async () => {
    const client = new GoogleCalendar({
      auth: { mode: "api_key", key: "k" },
      fetch: jsonFetch({}),
    });
    const spec = createAddAppointment({ client, calendarId: "primary", label: "mine" });
    await assert.rejects(
      () => spec.handler({ what: "Doctor", date: "2026-09-04" }, ctx()),
      CalendarAuthError,
    );
  });
});
