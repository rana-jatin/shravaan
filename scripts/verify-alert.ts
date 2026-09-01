/**
 * Send one real test alert, to prove the emergency path actually delivers.
 *
 *   npm run verify:alert
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCRIPT EXISTS.
 *
 * Every test in test/emergency.test.ts is hermetic — the SMTP client is checked
 * against an in-process server, the API client against an injected fetch. That
 * proves the protocols are right. It proves nothing about whether YOUR key is
 * accepted, whether the sender address was verified, or whether the message
 * lands in spam.
 *
 * The first time anyone finds that out must not be the first time somebody
 * falls. So this sends a genuine message through the configured transport and
 * reports exactly what the provider said.
 *
 * ⚠ IT DOES NOT LOOK LIKE AN EMERGENCY. The subject and the first line say TEST
 * in as many words, because the recipients are real people and frightening them
 * to check the plumbing would be its own harm.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { loadConfig } from "../src/config/env.ts";
import { createSmtpSender, type MailSender } from "../src/providers/smtp.ts";
import { createHttpMailSender, explainMailApiError } from "../src/providers/mail-api.ts";
import { formatNames, parseContacts } from "../src/tools/emergency.ts";
import { EMERGENCY_ACK, pendingEmergencyReview } from "../src/copy/emergency-intent.ts";

const cfg = loadConfig();
const { contacts, invalid } = parseContacts(cfg.emergency.contacts);

function die(what: string, fix: string): never {
  console.error(`\n  ✖ ${what}\n    ${fix}\n`);
  process.exit(1);
}

if (invalid.length > 0) {
  console.error(`  ! not email addresses, ignored: ${invalid.join(", ")}`);
}
if (contacts.length === 0) {
  die("EMERGENCY_CONTACTS is empty", "Set it in .env — see .env.example.");
}

let send: MailSender;
let transport: string;
let sender: string;

if (cfg.mail.transport === "smtp") {
  if (!cfg.mail.smtp.host) {
    die("SMTP_HOST is not set", "Or set MAIL_TRANSPORT=sendgrid to use the Web API instead.");
  }
  if (!cfg.mail.smtp.from) {
    die("SMTP_FROM and SMTP_USER are both unset", "Set SMTP_USER to the sending address.");
  }
  if (!cfg.mail.smtp.pass) {
    die("SMTP_PASS is not set", "Gmail: https://myaccount.google.com/apppasswords");
  }
  if (/\s/.test(cfg.mail.smtp.pass)) {
    // App passwords are displayed in four groups of four. Pasting them with the
    // spaces still in is the single most common cause of a 535.
    console.error("  ! SMTP_PASS contains a space — app passwords are shown in groups");
    console.error("    of four but must be entered with NO spaces.\n");
  }
  transport = `smtp ${cfg.mail.smtp.host}:${cfg.mail.smtp.port} (${cfg.mail.smtp.security})`;
  sender = cfg.mail.smtp.from;
  send = createSmtpSender({
    host: cfg.mail.smtp.host,
    port: cfg.mail.smtp.port,
    security: cfg.mail.smtp.security,
    user: cfg.mail.smtp.user,
    pass: cfg.mail.smtp.pass,
    from: cfg.mail.smtp.from,
  });
} else {
  if (!cfg.mail.apiKey) {
    die(
      `MAIL_TRANSPORT=${cfg.mail.transport} but no API key is set`,
      "Set MAIL_API_KEY (SENDGRID_API_KEY is accepted too). SendGrid: Settings > API Keys > Create, with Mail Send permission.",
    );
  }
  if (!cfg.mail.from) {
    die(
      "MAIL_FROM is not set",
      "It must be an address VERIFIED with the provider. SendGrid: Settings > Sender Authentication > Single Sender Verification.",
    );
  }
  transport = `${cfg.mail.transport} web api`;
  sender = cfg.mail.from;
  send = createHttpMailSender({
    provider: cfg.mail.transport,
    apiKey: cfg.mail.apiKey,
    from: cfg.mail.from,
  });
}

console.log(`
  transport  ${transport}
  from       ${sender}
  to         ${contacts.map((c) => `${c.name} <${c.email}>`).join("\n             ")}
  spoken as  "${(EMERGENCY_ACK["en-IN"] ?? "").replace("{names}", formatNames(contacts))}"
`);

const started = Date.now();
try {
  await send({
    to: contacts.map((c) => c.email),
    subject: "TEST — not an emergency — companion device alert check",
    text: [
      "THIS IS A TEST. Nobody needs help. You do not need to do anything.",
      "",
      "You are listed as an emergency contact for a companion device used by an",
      "older person. This message only confirms the device can reach you.",
      "",
      "A real alert will say EMERGENCY in the subject line and will quote, word",
      "for word, what the person said.",
      "",
      `Sent ${new Date().toLocaleString("en-IN", { timeZone: cfg.defaultTimezone })} (${cfg.defaultTimezone})`,
      `Transport: ${transport}`,
      "",
      "If this landed in spam, please mark it as not spam — a real alert arriving",
      "in a spam folder is the same as one that never arrived.",
    ].join("\n"),
  });

  console.log(`  ✔ accepted by the provider in ${Date.now() - started} ms\n`);
  console.log("  Now CHECK BOTH INBOXES, INCLUDING SPAM. A provider accepting a");
  console.log("  message is not the same as a person receiving it, and this path is");
  console.log("  only worth having if the mail actually lands.\n");

  const unreviewed = pendingEmergencyReview();
  if (unreviewed.length > 0) {
    console.log(`  ! ${unreviewed.length} languages still have unreviewed trigger phrases:`);
    console.log(`    ${unreviewed.join(", ")}`);
    console.log("    A call for help in those may not register. en-IN and hi-IN are ready.\n");
  }
} catch (err) {
  const message = String(err instanceof Error ? err.message : err);
  console.error(`\n  ✖ FAILED after ${Date.now() - started} ms\n    ${message}\n`);

  const explained =
    cfg.mail.transport === "smtp" ? null : explainMailApiError(cfg.mail.transport, message);

  if (explained) {
    console.error(`    ${explained}\n`);
  } else if (/\b535\b/.test(message)) {
    console.error("    535 is a rejected login. For Gmail this is almost always:");
    console.error("      - the account password instead of an APP PASSWORD");
    console.error("      - an app password pasted with its spaces");
    console.error("      - 2-Step Verification off, so app passwords do not exist\n");
  } else if (/timed out|ECONNREFUSED|EHOSTUNREACH/.test(message)) {
    console.error("    The relay was unreachable. Many campus and hostel networks block");
    console.error("    outbound SMTP — this is the reason to prefer MAIL_TRANSPORT=sendgrid,");
    console.error("    which runs over 443.\n");
  }
  process.exit(1);
}
