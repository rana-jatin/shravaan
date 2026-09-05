/**
 * Raising the alarm.
 *
 * Moved from backend/composition/alerting.ts unchanged in behaviour.
 *
 * HALF-CONFIGURED IS THE DANGEROUS STATE and is refused rather than tolerated.
 * Contacts with no relay would recognise "help" and have nowhere to send it; a
 * relay with no contacts has nobody to send to. Either way the companion says
 * help is coming when nothing is, which is worse than never listening for the
 * word at all.
 *
 * This is also the one capability that contributes something beyond a tool. The
 * alerter goes to every Session, because the LOCAL phrase matcher runs in
 * `Session#onFinal` before any tool round — "bachao" must not wait on a model
 * deciding to call a function. See tools/emergency.ts for the two ways in.
 */

import { createRaiseAlarm, EmergencyAlerter, parseContacts } from "../tools/emergency.ts";
import { buildTransport, transportGaps } from "../notify/transport.ts";
import { pendingEmergencyReview } from "../copy/emergency-intent.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const emergencyCapability: Capability = {
  name: "emergency",

  // Anything set at all. Whether it is set COMPLETELY is decided in register,
  // because half-configured has to be reported, not silently skipped.
  isConfigured: (cfg) =>
    Boolean(cfg.emergency.contacts) || Boolean(cfg.mail.smtp.host) || Boolean(cfg.mail.apiKey),

  // The one capability whose absence has to be said out loud. An operator who
  // does not know alerting is off believes a cry for help will reach somebody.
  unconfiguredNotice: () => ({
    level: "warn",
    msg: "emergency alerting is not configured",
    extra: { hint: "set EMERGENCY_CONTACTS and SMTP_* to arm it" },
  }),

  register(registry, { cfg, log }, contributions): CapabilityReport {
    const { contacts, invalid } = parseContacts(cfg.emergency.contacts);
    if (invalid.length > 0) {
      log("error", "EMERGENCY_CONTACTS has entries that are not email addresses — dropped", {
        dropped: invalid,
      });
    }

    // Shared with medication escalation, which reaches the same family through
    // the same relay — see notify/transport.ts.
    const transport = buildTransport(cfg);

    if (contacts.length === 0 || !transport) {
      // Refused rather than half-enabled. See the file header.
      log("error", "EMERGENCY ALERTING IS OFF — configured only halfway", {
        contacts: contacts.length,
        transport: cfg.mail.transport,
        ...transportGaps(cfg),
        effect: "a call for help will be treated as an ordinary turn",
      });
      return { name: "emergency", registered: false, tools: [], detail: { emergency: false } };
    }

    const alerter = new EmergencyAlerter({
      // One channel today. SMS, a call or WhatsApp arrive as more entries
      // there, not as edits to the alarm path. See notify/transport.ts.
      channels: transport.channels,
      contacts,
      cooldownMs: cfg.emergency.cooldownMs,
      log,
    });
    contributions.alerter = alerter;

    const spec = createRaiseAlarm(alerter);
    registry.register(spec);

    // Said at boot at WARN, deliberately. An unreviewed stop phrase means the
    // music does not stop; an unreviewed emergency phrase means a call for help
    // does not register, and nobody finds out until it matters.
    log("warn", "emergency alerting ARMED", {
      contacts: contacts.map((c) => `${c.name} <${c.email}>`),
      transport: transport.label,
      unreviewed_languages: pendingEmergencyReview(),
      note: "en-IN and hi-IN phrases reviewed; the rest need a native speaker",
    });

    return {
      name: "emergency",
      registered: true,
      tools: [spec.name],
      detail: { emergency: contacts.map((c) => c.name) },
    };
  },
};
