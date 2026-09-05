/**
 * Turning mail config into a channel, once.
 *
 * This was inline in `capabilities/emergency.ts` and correct there. It moved
 * the moment a second capability needed it: medication escalation reaches the
 * same family through the same relay, and two copies of "which transport did
 * they configure, and is it complete" is two places for the answer to drift —
 * with the drift showing up as a family who were told about an emergency but
 * not about a missed dose, or the reverse.
 *
 * ONE SEAM, AND MORE CHANNELS ARRIVE AS ENTRIES IN A LIST. SMS, a phone call
 * and WhatsApp all belong here as further `NotificationChannel`s beside email,
 * which is why this returns channels rather than a mail sender.
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import { createSmtpSender, type MailSender } from "../providers/smtp.ts";
import { createHttpMailSender } from "../providers/mail-api.ts";
import { emailChannel } from "./email.ts";
import type { NotificationChannel } from "./types.ts";

export type Transport = {
  channels: NotificationChannel[];
  /** For the boot log, so an operator can see which relay is live. */
  label: string;
};

/**
 * The channels this deployment can actually reach anybody on.
 *
 * Null when none are usable — which is a different thing from "an empty list",
 * and callers treat it that way: a capability decides for itself whether it can
 * run without a way to tell somebody, and emergency alerting cannot.
 */
export function buildTransport(cfg: Config): Transport | null {
  const mail = buildMailSender(cfg);
  if (!mail) return null;
  return { channels: [emailChannel(mail.sender)], label: mail.label };
}

function buildMailSender(cfg: Config): { sender: MailSender; label: string } | null {
  // One seam, two transports. See providers/mail-api.ts for why the HTTP one is
  // preferred on the alarm path.
  if (cfg.mail.transport === "smtp") {
    if (!cfg.mail.smtp.host || !cfg.mail.smtp.from) return null;
    return {
      sender: createSmtpSender({
        host: cfg.mail.smtp.host,
        port: cfg.mail.smtp.port,
        security: cfg.mail.smtp.security,
        user: cfg.mail.smtp.user,
        pass: cfg.mail.smtp.pass,
        from: cfg.mail.smtp.from,
      }),
      label: `smtp ${cfg.mail.smtp.host}:${cfg.mail.smtp.port} (${cfg.mail.smtp.security})`,
    };
  }

  if (!cfg.mail.apiKey || !cfg.mail.from) return null;
  return {
    sender: createHttpMailSender({
      provider: cfg.mail.transport,
      apiKey: cfg.mail.apiKey,
      from: cfg.mail.from,
    }),
    label: `${cfg.mail.transport} web api, from ${cfg.mail.from}`,
  };
}

/** Which fields are missing, for a boot log that says what to fix. */
export function transportGaps(cfg: Config): Record<string, string> {
  return cfg.mail.transport === "smtp"
    ? {
        smtp_host: cfg.mail.smtp.host ? "set" : "MISSING",
        smtp_from: cfg.mail.smtp.from ? "set" : "MISSING",
      }
    : {
        mail_api_key: cfg.mail.apiKey ? "set" : "MISSING",
        mail_from: cfg.mail.from ? "set" : "MISSING",
      };
}
