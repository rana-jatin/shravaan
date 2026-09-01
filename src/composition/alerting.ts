/**
 * Emergency alerting: contacts, a mail transport, and the alerter that uses them.
 *
 * Extracted from src/server.ts.
 *
 * HALF-CONFIGURED IS THE DANGEROUS STATE and is refused rather than tolerated —
 * contacts with no relay, or a relay with no contacts, means someone believes an
 * alarm will be delivered when nothing will send it. The boot log says which of
 * the two is missing.
 */

import type { Config } from "../config/env.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { createRaiseAlarm, EmergencyAlerter, parseContacts } from "../tools/emergency.ts";
import { createSmtpSender, type MailSender } from "../providers/smtp.ts";
import { createHttpMailSender } from "../providers/mail-api.ts";
import { pendingEmergencyReview } from "../copy/emergency-intent.ts";
import type { Log } from "./types.ts";

export type AlertWiring = {
  /** Null where alerting is unconfigured, which leaves the alarm path inert. */
  alerter: EmergencyAlerter | null;
  /** Names of the contacts that would actually be mailed. */
  contacts: string[];
};

export function registerAlerting(tools: ToolRegistry, cfg: Config, log: Log): AlertWiring {
  // Emergency contacts. Registered only when there is somewhere to send an
  // alert AND a relay to send it through — see below for why half-configured is
  // treated as not configured.
  const { contacts, invalid } = parseContacts(cfg.emergency.contacts);
  if (invalid.length > 0) {
    log("error", "EMERGENCY_CONTACTS has entries that are not email addresses — dropped", {
      dropped: invalid,
    });
  }

  // One seam, two transports. See src/providers/mail-api.ts for why the HTTP
  // one is preferred on this particular path.
  let mailSender: MailSender | null = null;
  let transportLabel = "";
  if (cfg.mail.transport === "smtp") {
    if (cfg.mail.smtp.host && cfg.mail.smtp.from) {
      mailSender = createSmtpSender({
        host: cfg.mail.smtp.host,
        port: cfg.mail.smtp.port,
        security: cfg.mail.smtp.security,
        user: cfg.mail.smtp.user,
        pass: cfg.mail.smtp.pass,
        from: cfg.mail.smtp.from,
      });
      transportLabel = `smtp ${cfg.mail.smtp.host}:${cfg.mail.smtp.port} (${cfg.mail.smtp.security})`;
    }
  } else if (cfg.mail.apiKey && cfg.mail.from) {
    mailSender = createHttpMailSender({
      provider: cfg.mail.transport,
      apiKey: cfg.mail.apiKey,
      from: cfg.mail.from,
    });
    transportLabel = `${cfg.mail.transport} web api, from ${cfg.mail.from}`;
  }

  let alerter: EmergencyAlerter | null = null;
  if (contacts.length > 0 && mailSender) {
    alerter = new EmergencyAlerter({
      send: mailSender,
      contacts,
      cooldownMs: cfg.emergency.cooldownMs,
      log,
    });
    tools.register(createRaiseAlarm(alerter));

    // Said at boot at WARN, deliberately. An unreviewed stop phrase means the
    // music does not stop; an unreviewed emergency phrase means a call for help
    // does not register, and nobody finds out until it matters.
    const unreviewed = pendingEmergencyReview();
    log("warn", "emergency alerting ARMED", {
      contacts: contacts.map((c) => `${c.name} <${c.email}>`),
      transport: transportLabel,
      unreviewed_languages: unreviewed,
      note: "en-IN and hi-IN phrases reviewed; the rest need a native speaker",
    });
  } else if (contacts.length > 0 || cfg.mail.smtp.host || cfg.mail.apiKey) {
    // HALF-CONFIGURED IS THE DANGEROUS STATE, so it is refused rather than
    // half-enabled. Contacts with no relay would recognise "help" and have no
    // way to send it; a relay with no contacts has nowhere to send it. Either
    // way the companion would say help is coming when nothing is.
    log("error", "EMERGENCY ALERTING IS OFF — configured only halfway", {
      contacts: contacts.length,
      transport: cfg.mail.transport,
      ...(cfg.mail.transport === "smtp"
        ? {
            smtp_host: cfg.mail.smtp.host ? "set" : "MISSING",
            smtp_from: cfg.mail.smtp.from ? "set" : "MISSING",
          }
        : {
            mail_api_key: cfg.mail.apiKey ? "set" : "MISSING",
            mail_from: cfg.mail.from ? "set" : "MISSING",
          }),
      effect: "a call for help will be treated as an ordinary turn",
    });
  } else {
    log("warn", "emergency alerting is not configured", {
      hint: "set EMERGENCY_CONTACTS and SMTP_* to arm it",
    });
  }

  return { alerter, contacts: alerter ? contacts.map((c) => c.name) : [] };
}
