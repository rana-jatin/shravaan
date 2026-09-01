/**
 * Sending the alert over HTTPS instead of SMTP.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE WEB API IS THE RIGHT CHOICE FOR *THIS* PATH.
 *
 * For ordinary mail the two are interchangeable and SMTP is more portable. For
 * an emergency alert they are not, and the difference is not a preference:
 *
 *   ROUND TRIPS. SMTP is a conversation — greeting, EHLO, STARTTLS, EHLO again,
 *   AUTH LOGIN, username, password, MAIL FROM, one RCPT TO per contact, DATA,
 *   the body, then the terminator. That is a dozen round trips before the relay
 *   has the message. The Web API is ONE. On a bad mobile link, which is exactly
 *   the link this will be used over, that is the difference between two seconds
 *   and twenty.
 *
 *   REACHABILITY. Ports 465 and 587 are blocked outbound on a great many campus,
 *   hostel and office networks — and the contacts here are on a campus domain,
 *   so that is not hypothetical. 443 is not blocked anywhere that the device
 *   could reach Sarvam from in the first place: if the companion can talk at
 *   all, it can send this.
 *
 *   DIAGNOSIS. A rejected SMTP login is `535 5.7.8` and a sentence. These
 *   endpoints return JSON that says which field was wrong.
 *
 * SMTP stays supported and is not deprecated — it is the only way to point at a
 * relay inside India, which the residency thread in docs/05 Q14 cares about.
 * See src/providers/smtp.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three dialects, because they are ten lines each and a deployment that has to
 * switch providers during an outage should not be editing code to do it.
 * Verified live 2026-08-31: all three endpoints answer 401 to a bad key, which
 * is how these URLs and header shapes were confirmed rather than assumed.
 */

import type { MailMessage, MailSender } from "./smtp.ts";

export type MailApiProvider = "sendgrid" | "resend" | "brevo";

export type MailApiConfig = {
  provider: MailApiProvider;
  apiKey: string;
  /** `someone@example.com` or `Companion <someone@example.com>`. */
  from: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** `Name <a@b.c>` into its parts. Providers disagree on which they want. */
export function parseAddress(value: string): { email: string; name: string | null } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (m) return { email: m[2]!.trim(), name: m[1]!.replace(/^"|"$/g, "").trim() || null };
  return { email: value.trim(), name: null };
}

type Dialect = {
  url: string;
  headers: (key: string) => Record<string, string>;
  body: (from: { email: string; name: string | null }, msg: MailMessage) => unknown;
  /** Anything else is a failure, including a 200 where 202 was expected. */
  ok: (status: number) => boolean;
};

const DIALECTS: Record<MailApiProvider, Dialect> = {
  // 202 Accepted with an EMPTY body on success — there is nothing to parse, so
  // the status is the whole result.
  sendgrid: {
    url: "https://api.sendgrid.com/v3/mail/send",
    headers: (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
    body: (from, msg) => ({
      personalizations: [{ to: msg.to.map((email) => ({ email })) }],
      from: from.name ? { email: from.email, name: from.name } : { email: from.email },
      subject: msg.subject,
      content: [{ type: "text/plain", value: msg.text }],
    }),
    ok: (s) => s === 202,
  },
  resend: {
    url: "https://api.resend.com/emails",
    headers: (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
    body: (from, msg) => ({
      from: from.name ? `${from.name} <${from.email}>` : from.email,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    }),
    ok: (s) => s === 200,
  },
  // Brevo authenticates with its own header, NOT a bearer token.
  brevo: {
    url: "https://api.brevo.com/v3/smtp/email",
    headers: (key) => ({ "api-key": key, "content-type": "application/json" }),
    body: (from, msg) => ({
      sender: from.name ? { email: from.email, name: from.name } : { email: from.email },
      to: msg.to.map((email) => ({ email })),
      subject: msg.subject,
      textContent: msg.text,
    }),
    ok: (s) => s === 201 || s === 200,
  },
};

export function createHttpMailSender(cfg: MailApiConfig): MailSender {
  const dialect = DIALECTS[cfg.provider];
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const from = parseAddress(cfg.from);
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function send(msg: MailMessage): Promise<void> {
    if (msg.to.length === 0) throw new Error("mail-api: no recipients");

    // A hung request is the failure mode that matters: without this the alarm
    // waits on a socket that is never going to answer, and the user is told
    // nothing either way.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    try {
      const res = await doFetch(dialect.url, {
        method: "POST",
        headers: dialect.headers(cfg.apiKey),
        body: JSON.stringify(dialect.body(from, msg)),
        signal: abort.signal,
      });

      if (!dialect.ok(res.status)) {
        // The provider's own JSON is the only useful diagnosis — an unverified
        // sender, a suspended account, a malformed address.
        const detail = await res.text().catch(() => "");
        throw new Error(
          `${cfg.provider}: HTTP ${res.status} ${detail.slice(0, 300) || "(empty body)"}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`${cfg.provider}: timed out after ${timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * What a rejection usually means, in words that name the fix.
 *
 * These three fail for the same handful of reasons and every one of them is a
 * setup mistake rather than a bug — but the raw response says so only if you
 * already know the vocabulary.
 */
export function explainMailApiError(provider: MailApiProvider, message: string): string | null {
  // ORDER MATTERS. An unverified sender comes back as a 403, so the generic
  // auth branch would swallow it and send someone hunting for a bad key.
  if (/verif|sender identity|from address/i.test(message)) {
    return (
      "The SENDER address is not verified. Every one of these providers refuses to send " +
      "from an address or domain you have not proved you control, and the refusal looks " +
      "like an auth error. SendGrid: Settings > Sender Authentication > Single Sender " +
      "Verification, then set MAIL_FROM to exactly that address."
    );
  }
  if (/HTTP 401/.test(message)) {
    return provider === "sendgrid"
      ? "The API key was rejected. A SendGrid key needs the Mail Send permission — one created with Restricted Access and no scopes ticked returns exactly this."
      : "The API key was rejected. Check it was copied whole; these are shown once at creation and cannot be read back.";
  }
  if (/HTTP 403/.test(message)) {
    return "Authenticated but not permitted. Usually a key without Mail Send permission, or an account still pending review.";
  }
  if (/HTTP 429/.test(message)) {
    return "Rate limited by the provider. On an alerting path that is worth an alert of its own.";
  }
  if (/timed out/.test(message)) {
    return "The request never completed. This runs over 443, so a timeout usually means the network is down rather than a blocked port.";
  }
  return null;
}
