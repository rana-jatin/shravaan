/**
 * The alarm path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS STRICTER THAN THE REST OF THE SUITE.
 *
 * Everywhere else a defect produces a wrong answer. Here it produces an
 * eighty-year-old on the floor of a room nobody is coming to. The asymmetry
 * between a false positive (a phone call) and a false negative (that) is not a
 * matter of taste, so the tests below are written to catch the second even at
 * the cost of tolerating the first.
 *
 * The SMTP tests speak the real protocol to a real in-process socket server,
 * rather than asserting against a mock of our own client. A mailer that has
 * only ever been checked against a fake of itself is a mailer nobody has sent
 * mail with.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import assert from "node:assert/strict";
import net from "node:net";
import { after, describe, it } from "node:test";

import { EMERGENCY_ACK, EMERGENCY_FAILED, matchEmergency } from "../src/copy/emergency-intent.ts";
import { SPEAKABLE } from "../src/domain/languages.ts";
import { createSmtpSender, type MailMessage } from "../src/providers/smtp.ts";
import {
  createHttpMailSender,
  explainMailApiError,
  parseAddress,
} from "../src/providers/mail-api.ts";
import {
  EmergencyAlerter,
  createRaiseAlarm,
  formatNames,
  parseContacts,
} from "../src/tools/emergency.ts";
import { fakeHost, invocation } from "./helpers.ts";

const CONTACTS = [
  { name: "Harsh", email: "harsh.20224070@mnnit.ac.in" },
  { name: "Aman", email: "aman.20234023@mnnit.ac.in" },
];

describe("hearing a call for help", () => {
  it("catches the phrasing in the brief", () => {
    assert.ok(matchEmergency("help help", "en-IN"));
    assert.equal(matchEmergency("help help", "en-IN")?.kind, "repeated");
  });

  it("catches a bare shout", () => {
    assert.ok(matchEmergency("help", "en-IN"));
    assert.ok(matchEmergency("Help!", "en-IN"));
  });

  it("catches what a fall actually sounds like", () => {
    for (const said of [
      "help me",
      "somebody help",
      "I have fallen",
      "i've fallen and i can't get up",
      "I can't breathe",
      "call an ambulance",
      "chest pain",
      "call my son",
    ]) {
      assert.ok(matchEmergency(said, "en-IN"), `missed: ${said}`);
    }
  });

  it("catches Hindi in both script and transliteration", () => {
    // Saaras returns Devanagari for hi-IN, so a transliteration-only table
    // would match nothing at all in practice.
    for (const said of ["bachao", "madad karo", "बचाओ", "मदद करो", "मैं गिर गया"]) {
      assert.ok(matchEmergency(said, "hi-IN"), `missed: ${said}`);
    }
  });

  it("hears English help from a speaker of any of the eleven", () => {
    // The most likely phrasing of all: code-mixed, and the ASR will have
    // tagged the turn as the user's own language.
    for (const { code: language } of SPEAKABLE) {
      assert.ok(matchEmergency("help me", language), `missed in ${language}`);
    }
  });

  it("does NOT fire on ordinary uses of the word", () => {
    // The one way this feature ends up worse than not existing: contacts who
    // learn to ignore it. A bare "help" only counts alone or repeated.
    for (const said of [
      "can you help me pick a song",
      "I need some help with the television",
      "help me remember my grandson's birthday",
      "that was helpful",
      "who can help with the garden",
    ]) {
      assert.equal(matchEmergency(said, "en-IN"), null, `false alarm on: ${said}`);
    }
  });

  it("ignores an empty transcript", () => {
    assert.equal(matchEmergency("", "en-IN"), null);
    assert.equal(matchEmergency("   ", "en-IN"), null);
  });

  it("has an acknowledgement and a failure line in every speakable language", () => {
    // A language with no ack would be a language where help is raised in
    // silence — the user hears nothing and assumes nothing happened.
    for (const { code: language } of SPEAKABLE) {
      assert.ok(EMERGENCY_ACK[language]?.trim(), `no ack for ${language}`);
      assert.ok(EMERGENCY_FAILED[language]?.trim(), `no failure line for ${language}`);
      assert.ok(EMERGENCY_ACK[language]!.includes("{names}"), `${language} ack drops the names`);
    }
  });
});

describe("naming the people", () => {
  it("reads a roll-number address as a first name", () => {
    // "I'm telling Harsh" — a roll number read aloud to a frightened person
    // helps nobody.
    const { contacts } = parseContacts("harsh.20224070@mnnit.ac.in,aman.20234023@mnnit.ac.in");
    assert.deepEqual(contacts.map((c) => c.name), ["Harsh", "Aman"]);
  });

  it("takes an explicit name when given one", () => {
    const { contacts } = parseContacts("Dr Rao=rao@hospital.in,harsh.2022@mnnit.ac.in");
    assert.deepEqual(contacts.map((c) => c.name), ["Dr Rao", "Harsh"]);
  });

  it("reports an address that is not an address rather than silently dropping it", () => {
    const { contacts, invalid } = parseContacts("harsh@mnnit.ac.in,not-an-email,  ");
    assert.equal(contacts.length, 1);
    assert.deepEqual(invalid, ["not-an-email"]);
  });

  it("speaks the list the way a person would", () => {
    assert.equal(formatNames(CONTACTS), "Harsh and Aman");
    assert.equal(formatNames([CONTACTS[0]!]), "Harsh");
    assert.equal(
      formatNames([...CONTACTS, { name: "Rao", email: "r@x.in" }]),
      "Harsh, Aman and Rao",
    );
  });
});

describe("raising the alarm", () => {
  const input = {
    uid: "u1",
    sid: "s1",
    language: "en-IN" as const,
    timezone: "Asia/Kolkata",
    spoken: "help help",
    trigger: "repeated" as const,
  };

  function alerter(send: (m: MailMessage) => Promise<void>, over = {}) {
    return new EmergencyAlerter({ send, contacts: CONTACTS, ...over });
  }

  it("emails every contact", async () => {
    const sent: MailMessage[] = [];
    const out = await alerter(async (m) => void sent.push(m)).raise(input);

    assert.equal(out.sent, true);
    assert.deepEqual(sent[0]?.to, CONTACTS.map((c) => c.email));
  });

  it("puts the verbatim words in the body, not a summary", async () => {
    // The people receiving this need to judge for themselves how bad it is.
    const sent: MailMessage[] = [];
    await alerter(async (m) => void sent.push(m)).raise({
      ...input,
      spoken: "bachao mujhe utha nahi ja raha",
    });
    assert.ok(sent[0]!.text.includes("bachao mujhe utha nahi ja raha"));
    assert.ok(/EMERGENCY/i.test(sent[0]!.subject));
    // It must not read as though an ambulance is on its way.
    assert.ok(/NOT an emergency service/i.test(sent[0]!.text));
    assert.ok(sent[0]!.text.includes("108"));
  });

  it("retries once before giving up", async () => {
    let calls = 0;
    const out = await alerter(async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }).raise(input);

    assert.equal(calls, 2);
    assert.equal(out.sent, false);
    assert.match(out.error!, /ECONNREFUSED/);
  });

  it("recovers when the retry succeeds", async () => {
    let calls = 0;
    const out = await alerter(async () => {
      if (++calls === 1) throw new Error("transient");
    }).raise(input);
    assert.equal(out.sent, true);
  });

  it("folds a burst into one email", async () => {
    // Five "help"s in twenty seconds is one event. Five emails teach the
    // contacts to skim, and a skimmed alert is a missed one.
    const sent: MailMessage[] = [];
    const a = alerter(async (m) => void sent.push(m));
    for (let i = 0; i < 5; i++) await a.raise(input);

    assert.equal(sent.length, 1);
  });

  it("still reports success while folding, so the user is still reassured", async () => {
    const a = alerter(async () => {});
    await a.raise(input);
    const second = await a.raise(input);
    assert.equal(second.sent, true);
    assert.equal(second.suppressed, true);
    assert.equal(second.repeats, 1);
  });

  it("lets a NEW emergency through once the cooldown has passed", async () => {
    let clock = 0;
    const sent: MailMessage[] = [];
    const a = alerter(async (m) => void sent.push(m), {
      cooldownMs: 1000,
      now: () => clock,
    });
    await a.raise(input);
    clock += 5000;
    await a.raise(input);
    assert.equal(sent.length, 2);
  });

  it("counts the folded repeats into the next email", async () => {
    let clock = 0;
    const sent: MailMessage[] = [];
    const a = alerter(async (m) => void sent.push(m), { cooldownMs: 1000, now: () => clock });
    await a.raise(input);
    await a.raise(input);
    await a.raise(input);
    clock += 5000;
    await a.raise(input);
    assert.match(sent[1]!.text, /already asked 2 more time/);
  });

  it("does not let a FAILED send start a cooldown", async () => {
    // The critical one. A failure that armed the cooldown would fold the next
    // cry for help into a message nobody ever received.
    let ok = false;
    let attempts = 0;
    const a = alerter(async () => {
      attempts++;
      if (!ok) throw new Error("down");
    });

    const first = await a.raise(input);
    assert.equal(first.sent, false);
    assert.equal(attempts, 2, "tried twice");

    ok = true;
    const second = await a.raise(input);
    assert.equal(second.sent, true, "the next cry for help is not suppressed");
    assert.equal(second.suppressed, false);
  });

  it("keeps one session's burst from silencing another's", async () => {
    const sent: MailMessage[] = [];
    const a = alerter(async (m) => void sent.push(m));
    await a.raise(input);
    await a.raise({ ...input, sid: "s2", uid: "u2" });
    assert.equal(sent.length, 2, "two people are two emergencies");
  });

  it("never throws, whatever the transport does", async () => {
    // It is called from the middle of the speech path; an exception there takes
    // down the turn that is trying to tell the user help is coming.
    const out = await alerter(async () => {
      throw Object.assign(new Error("weird"), { code: null });
    }).raise(input);
    assert.equal(out.sent, false);
  });

  it("says so rather than pretending when there are no contacts", async () => {
    const a = new EmergencyAlerter({ send: async () => {}, contacts: [] });
    const out = await a.raise(input);
    assert.equal(out.sent, false);
    assert.match(out.error!, /no contacts/);
  });
});

describe("the raise_alarm tool", () => {
  const ctx = () => invocation({ host: fakeHost({ timezone: () => "Asia/Kolkata" }) });

  it("tells the model plainly when the alert did NOT go out", async () => {
    // The model must never claim help is coming when it is not — that is the
    // one failure worse than having no alarm.
    const spec = createRaiseAlarm(
      new EmergencyAlerter({
        send: async () => {
          throw new Error("relay down");
        },
        contacts: CONTACTS,
      }),
    );
    const out = await spec.handler!({ what_happened: "She has fallen" }, ctx());

    assert.equal(out["alerted"], false);
    assert.match(String(out["tell_the_user"]), /could not reach/i);
  });

  it("reports success with the names the user knows", async () => {
    const spec = createRaiseAlarm(
      new EmergencyAlerter({ send: async () => {}, contacts: CONTACTS }),
    );
    const out = await spec.handler!({ what_happened: "Chest pain" }, ctx());
    assert.equal(out["alerted"], true);
    assert.deepEqual(out["contacts"], ["Harsh", "Aman"]);
  });

  it("is described so the model does not ask permission first", () => {
    const spec = createRaiseAlarm(
      new EmergencyAlerter({ send: async () => {}, contacts: CONTACTS }),
    );
    assert.match(spec.description, /do not ask their permission/i);
    assert.equal(spec.progress_key, "progress.mail");
  });
});

// ---------------------------------------------------------------------------
// The wire protocol, against a real socket.
// ---------------------------------------------------------------------------

type Captured = { commands: string[]; data: string };

/**
 * A throwaway SMTP server that says yes to everything.
 *
 * Speaking the real protocol to a real socket is the point: the client's
 * multi-line reply parsing, AUTH LOGIN handshake, dot-stuffing and DATA
 * terminator are all things that look right and fail on the wire.
 */
function fakeSmtpServer(): Promise<{ port: number; captured: Captured; close: () => void }> {
  const captured: Captured = { commands: [], data: "" };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 test.local ESMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else {
            captured.data += `${line}\n`;
          }
          continue;
        }

        captured.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          // Multi-line, which is the shape that breaks naive readers.
          socket.write("250-test.local\r\n250-SIZE 35882577\r\n250 AUTH LOGIN PLAIN\r\n");
        } else if (upper === "AUTH LOGIN") {
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else if (captured.commands.filter((c) => /^[A-Za-z0-9+/]+=*$/.test(c)).length === 1 &&
                   /^[A-Za-z0-9+/]+=*$/.test(line)) {
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (/^[A-Za-z0-9+/]+=*$/.test(line)) {
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else {
          socket.write("250 2.1.0 Ok\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, captured, close: () => server.close() });
    });
  });
}

describe("SMTP, on the wire", () => {
  const servers: Array<() => void> = [];
  after(() => servers.forEach((close) => close()));

  async function send(msg: MailMessage) {
    const s = await fakeSmtpServer();
    servers.push(s.close);
    const sender = createSmtpSender({
      host: "127.0.0.1",
      port: s.port,
      security: "none",
      user: "sp-i@example.com",
      pass: "app-password",
      from: "sp-i@example.com",
    });
    await sender(msg);
    return s.captured;
  }

  const message: MailMessage = {
    to: CONTACTS.map((c) => c.email),
    subject: "EMERGENCY: someone has asked this device for help",
    text: "They said: help help",
  };

  it("completes a full session and gets the mail queued", async () => {
    const c = await send(message);
    const verbs = c.commands.map((l) => l.split(" ")[0]!.toUpperCase());
    assert.ok(verbs.includes("EHLO"), c.commands.join(" | "));
    assert.ok(verbs.includes("MAIL"));
    assert.ok(verbs.includes("DATA"));
    assert.equal(c.commands.filter((l) => l.toUpperCase().startsWith("RCPT")).length, 2);
  });

  it("authenticates with base64, not the raw password", async () => {
    const c = await send(message);
    assert.ok(c.commands.includes("AUTH LOGIN"));
    assert.ok(
      !c.commands.some((l) => l.includes("app-password")),
      "the password never appears in the clear",
    );
    assert.ok(c.commands.includes(Buffer.from("app-password").toString("base64")));
  });

  it("survives a multi-line EHLO reply", async () => {
    // The server above answers with 250- continuations. A reader that treats
    // the first line as the whole reply desynchronises from here on.
    const c = await send(message);
    assert.ok(c.commands.some((l) => l.toUpperCase().startsWith("MAIL FROM")));
  });

  it("delivers a non-ASCII body intact", async () => {
    // Devanagari through base64 — the transcript will not be English.
    const hindi = "उन्होंने कहा: बचाओ, मैं गिर गया";
    const c = await send({ ...message, text: hindi });
    const b64 = c.data.split("\n\n").slice(1).join("").replace(/\s/g, "");
    assert.ok(Buffer.from(b64, "base64").toString("utf8").includes(hindi));
  });

  it("encodes a non-ASCII subject rather than sending raw bytes", async () => {
    const c = await send({ ...message, subject: "आपातकाल" });
    assert.ok(/Subject: =\?UTF-8\?B\?/.test(c.data), c.data.slice(0, 400));
  });

  it("dot-stuffs a line that would otherwise end the message early", async () => {
    // A body line of "." alone terminates DATA. Unstuffed, everything after it
    // is silently discarded — the alert arrives truncated.
    const c = await send({ ...message, text: "line one\n.\nline two" });
    const b64 = c.data.split("\n\n").slice(1).join("").replace(/\s/g, "");
    assert.ok(Buffer.from(b64, "base64").toString("utf8").includes("line two"));
  });

  it("refuses to send with no recipients", async () => {
    const sender = createSmtpSender({
      host: "127.0.0.1",
      port: 1,
      security: "none",
      user: null,
      pass: null,
      from: "a@b.com",
    });
    await assert.rejects(() => sender({ ...message, to: [] }), /no recipients/);
  });
});

// ---------------------------------------------------------------------------
// The HTTP transport.
// ---------------------------------------------------------------------------

/** Captures one request and answers with the status under test. */
function captureFetch(status: number, body = "") {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return { ok: status < 300, status, text: async () => body } as Response;
  }) as typeof globalThis.fetch;
  return { fetch: f, seen };
}

describe("the Web API transport", () => {
  const msg: MailMessage = {
    to: CONTACTS.map((c) => c.email),
    subject: "EMERGENCY: someone has asked this device for help",
    text: "They said: बचाओ",
  };

  it("sends SendGrid the shape its API actually wants", async () => {
    const cap = captureFetch(202);
    await createHttpMailSender({
      provider: "sendgrid",
      apiKey: "SG.key",
      from: "Companion <device@example.com>",
      fetch: cap.fetch,
    })(msg);

    const req = cap.seen[0]!;
    assert.equal(req.url, "https://api.sendgrid.com/v3/mail/send");
    assert.equal(req.headers["authorization"], "Bearer SG.key");
    const body = req.body as Record<string, any>;
    assert.deepEqual(body["personalizations"], [
      { to: CONTACTS.map((c) => ({ email: c.email })) },
    ]);
    assert.deepEqual(body["from"], { email: "device@example.com", name: "Companion" });
    assert.equal(body["content"][0].type, "text/plain");
    // The transcript is not English. It must survive as text, not as HTML.
    assert.ok(String(body["content"][0].value).includes("बचाओ"));
  });

  it("treats a SendGrid 202 as sent and anything else as failure", async () => {
    const ok = captureFetch(202);
    await createHttpMailSender({
      provider: "sendgrid", apiKey: "k", from: "a@b.com", fetch: ok.fetch,
    })(msg);

    const bad = captureFetch(200, "");
    await assert.rejects(
      () => createHttpMailSender({
        provider: "sendgrid", apiKey: "k", from: "a@b.com", fetch: bad.fetch,
      })(msg),
      /HTTP 200/,
      "a 200 from SendGrid is NOT an accepted send",
    );
  });

  it("uses Brevo's own auth header rather than a bearer token", async () => {
    const cap = captureFetch(201);
    await createHttpMailSender({
      provider: "brevo", apiKey: "xkeysib-1", from: "a@b.com", fetch: cap.fetch,
    })(msg);
    assert.equal(cap.seen[0]!.headers["api-key"], "xkeysib-1");
    assert.equal(cap.seen[0]!.headers["authorization"], undefined);
  });

  it("sends Resend a single from string", async () => {
    const cap = captureFetch(200);
    await createHttpMailSender({
      provider: "resend", apiKey: "re_1", from: "Companion <a@b.com>", fetch: cap.fetch,
    })(msg);
    assert.equal((cap.seen[0]!.body as Record<string, unknown>)["from"], "Companion <a@b.com>");
  });

  it("carries the provider's own error text into the failure", async () => {
    // That text is the only thing that says WHICH field was wrong.
    const cap = captureFetch(403, '{"errors":[{"message":"does not match a verified Sender Identity"}]}');
    await assert.rejects(
      () => createHttpMailSender({
        provider: "sendgrid", apiKey: "k", from: "a@b.com", fetch: cap.fetch,
      })(msg),
      /verified Sender Identity/,
    );
  });

  it("gives up rather than hanging forever", async () => {
    const never = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as typeof globalThis.fetch;

    await assert.rejects(
      () => createHttpMailSender({
        provider: "sendgrid", apiKey: "k", from: "a@b.com", fetch: never, timeoutMs: 30,
      })(msg),
      /timed out/,
    );
  });

  it("splits a display name from the address", () => {
    assert.deepEqual(parseAddress("Companion <a@b.com>"), { email: "a@b.com", name: "Companion" });
    assert.deepEqual(parseAddress("a@b.com"), { email: "a@b.com", name: null });
    assert.deepEqual(parseAddress('"SP-I" <a@b.com>'), { email: "a@b.com", name: "SP-I" });
  });
});

describe("explaining a rejection", () => {
  it("names the sender problem rather than blaming the key", () => {
    // A 403 for an unverified sender would otherwise be read as a bad key, and
    // whoever set it up goes hunting in the wrong place.
    const out = explainMailApiError(
      "sendgrid",
      'sendgrid: HTTP 403 {"errors":[{"message":"The from address does not match a verified Sender Identity"}]}',
    );
    assert.match(String(out), /SENDER address is not verified/);
  });

  it("points a 401 at the key's permissions", () => {
    assert.match(String(explainMailApiError("sendgrid", "sendgrid: HTTP 401 {}")), /Mail Send permission/);
  });
});
