/**
 * Raising the alarm.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO WAYS IN, ONE WAY OUT.
 *
 * `EmergencyAlerter` is called from two places and they cover different gaps:
 *
 *   1. THE LOCAL MATCHER, from Session#onFinal, before the language gate and
 *      before any network call. Catches "help help", "bachao", "I've fallen".
 *      Fast and deterministic — it cannot be rate-limited, cannot be slowed by
 *      a token stream, and cannot decide the user was being figurative.
 *
 *   2. THE `raise_alarm` TOOL, for what a phrase table cannot catch — "my chest
 *      is hurting", "something is wrong with me", said calmly and in a sentence
 *      no list would contain.
 *
 * Either alone has a hole the other covers. Both land here, so the cooldown,
 * the composition and the retry are shared and a doubled trigger cannot send
 * two emails.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ THIS IS NOT AN EMERGENCY SERVICE. It emails people who know the user. It
 * does not call 108, it cannot see whether anyone read the mail, and it fails
 * silently if the network is down — which is why the send RESULT is spoken back
 * rather than assumed. Anything that would let a family believe this replaces a
 * medical alert pendant is a product harm, not a feature.
 */

import type { LanguageCode } from "@sp-i/shared/domain/types.ts";
import { Notifier } from "../notify/notifier.ts";
import type { Notification, NotificationChannel } from "../notify/types.ts";
import type { ToolSpec } from "./registry.ts";

/** Sending takes as long as it takes; the ack is already spoken by then. */
const ALARM_MS = 20_000;
const ALARM_FILLER_MS = 300;

/**
 * How long a repeat is folded into the alert already sent.
 *
 * Someone in distress says "help" five times in twenty seconds. Five emails
 * teach the contacts to skim, and a skimmed alert is a missed one. Two minutes
 * is long enough to absorb a burst and short enough that a genuinely new
 * emergency half an hour later still gets through.
 */
const DEFAULT_COOLDOWN_MS = 120_000;

export type EmergencyContact = { name: string; email: string };

export type AlertTrigger = "phrase" | "repeated" | "bare" | "model";

export type AlertInput = {
  uid: string;
  sid: string;
  language: LanguageCode;
  timezone: string;
  /** Verbatim, as the ASR heard it. Never cleaned up — the contacts need this. */
  spoken: string;
  trigger: AlertTrigger;
  /** The phrase that fired, or the model's own account of what happened. */
  detail?: string;
  /** Oldest last, as the session keeps them. */
  recent?: Array<{ role: string; text: string }>;
};

export type AlertResult = {
  sent: boolean;
  contacts: string[];
  /** Folded into an alert already sent, with how many times they have asked. */
  suppressed: boolean;
  repeats: number;
  error?: string;
};

/** "Harsh and Aman" — spoken, so it must read as a person would say it. */
export function formatNames(contacts: EmergencyContact[]): string {
  const names = contacts.map((c) => c.name);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * `Harsh=harsh@x.ac.in,aman@y.ac.in` — a name is optional.
 *
 * Without one the local part is title-cased, which turns
 * `harsh.20224070@mnnit.ac.in` into "Harsh". That name is SPOKEN to a
 * frightened person, so a roll number read aloud would be worse than useless.
 */
export function parseContacts(raw: string | null): {
  contacts: EmergencyContact[];
  invalid: string[];
} {
  const contacts: EmergencyContact[] = [];
  const invalid: string[] = [];
  for (const segment of (raw ?? "").split(",")) {
    const part = segment.trim();
    if (part === "") continue;

    const eq = part.indexOf("=");
    const name = eq === -1 ? null : part.slice(0, eq).trim();
    const email = (eq === -1 ? part : part.slice(eq + 1)).trim();

    // Deliberately permissive: an address this rejects is one nobody is told
    // about, so the bar is "has a local part and a dotted domain".
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalid.push(part);
      continue;
    }
    contacts.push({ email, name: name || deriveName(email) });
  }
  return { contacts, invalid };
}

function deriveName(email: string): string {
  const local = email.slice(0, email.indexOf("@"));
  // `harsh.20224070` -> `harsh`; `a_b` -> `a`. Digits are a roll number, never
  // a name, and reading them aloud helps nobody.
  const first = local.split(/[._\-+]/).find((p) => /[a-z]/i.test(p)) ?? local;
  const letters = first.replace(/[^a-z]/gi, "");
  return letters ? letters[0]!.toUpperCase() + letters.slice(1).toLowerCase() : email;
}

export type AlerterDeps = {
  /**
   * Every way of reaching the contacts, tried in order.
   *
   * This was a single `MailSender`. It is a list because a phone on silent and
   * an unread inbox fail in uncorrelated ways, and SMS, a call or WhatsApp
   * should be a new module rather than an edit to the alarm path. Deployments
   * today configure exactly one — email — and behave as they always did.
   */
  channels: NotificationChannel[];
  contacts: EmergencyContact[];
  cooldownMs?: number;
  now?: () => number;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

export class EmergencyAlerter {
  readonly #d: AlerterDeps;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #notifier: Notifier;
  /** Per session: a burst is one event, but two sessions are two people. */
  readonly #last = new Map<string, { at: number; repeats: number }>();

  constructor(deps: AlerterDeps) {
    this.#d = deps;
    this.#cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#now = deps.now ?? Date.now;
    // The retry lives here now — it is a delivery concern, not an emergency
    // one, and a medication reminder deserves the same one attempt back.
    this.#notifier = new Notifier({
      channels: deps.channels,
      ...(deps.log ? { log: deps.log } : {}),
    });
  }

  get contacts(): EmergencyContact[] {
    return this.#d.contacts;
  }

  get names(): string {
    return formatNames(this.#d.contacts);
  }

  /**
   * Send the alert, or fold it into one already sent.
   *
   * NEVER THROWS. It is called from the middle of the session's speech path,
   * and an exception there would take down the turn that is trying to tell the
   * user help is coming. Failure comes back as `sent: false` with a reason, and
   * the session speaks it.
   */
  async raise(input: AlertInput): Promise<AlertResult> {
    const to = this.#d.contacts.map((c) => c.email);
    if (to.length === 0) {
      return { sent: false, contacts: [], suppressed: false, repeats: 0, error: "no contacts" };
    }

    const now = this.#now();
    const prior = this.#last.get(input.sid);
    if (prior && now - prior.at < this.#cooldownMs) {
      prior.repeats += 1;
      this.#d.log?.("warn", "emergency repeat folded into the alert already sent", {
        sid: input.sid,
        repeats: prior.repeats,
        since_ms: now - prior.at,
      });
      return { sent: true, contacts: to, suppressed: true, repeats: prior.repeats };
    }

    const repeats = prior ? prior.repeats : 0;
    this.#last.set(input.sid, { at: now, repeats: 0 });

    const notification = compose(input, this.#d.contacts, repeats);
    const outcome = await this.#notifier.send(notification);

    if (outcome.delivered) {
      this.#d.log?.("warn", "EMERGENCY ALERT SENT", {
        sid: input.sid,
        uid: input.uid,
        to,
        trigger: input.trigger,
        channels: outcome.results.filter((r) => r.delivered.length > 0).map((r) => r.kind),
      });
      return { sent: true, contacts: to, suppressed: false, repeats: 0 };
    }

    // The alert did not go out. Clear the cooldown so the NEXT cry for help
    // tries again rather than being folded into a message nobody received.
    this.#last.delete(input.sid);
    return {
      sent: false,
      contacts: to,
      suppressed: false,
      repeats: 0,
      error: Notifier.firstError(outcome) ?? "no channel could reach anyone",
    };
  }
}

const TRIGGER_TEXT: Record<AlertTrigger, string> = {
  repeated:
    'the words "help help" — asked for twice, which is the phrasing this device watches for',
  phrase: "a phrase this device watches for",
  bare: "a single shouted call for help",
  model: "the companion judged this an emergency from what was being said",
};

/**
 * The email itself.
 *
 * Written to be read on a lock screen at 3 a.m. by someone who was asleep. The
 * first line has to answer "who, and how bad" before anyone opens anything, so
 * the verbatim words come before the metadata, not after.
 */
function compose(
  input: AlertInput,
  contacts: EmergencyContact[],
  earlierRepeats: number,
): Notification {
  const when = new Date().toLocaleString("en-IN", {
    timeZone: input.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

  const lines = [
    "THIS IS AN AUTOMATED ALERT FROM A COMPANION DEVICE.",
    "",
    `Someone using the device asked for help at ${when} (${input.timezone}).`,
    "",
    "WHAT THEY SAID:",
    `    "${input.spoken.trim()}"`,
    "",
    `How it was detected: ${TRIGGER_TEXT[input.trigger]}.`,
    ...(input.detail ? [`Detail: ${input.detail}`] : []),
    `Language of the conversation: ${input.language}`,
  ];

  if (earlierRepeats > 0) {
    lines.push("", `They had already asked ${earlierRepeats} more time(s) before this alert.`);
  }

  if (input.recent && input.recent.length > 0) {
    lines.push("", "THE MINUTES BEFORE, oldest first:");
    for (const turn of input.recent) {
      lines.push(`    ${turn.role === "user" ? "them" : "device"}: ${turn.text.slice(0, 300)}`);
    }
  }

  lines.push(
    "",
    "PLEASE CHECK ON THEM NOW — by phone if you can, in person if you cannot reach them.",
    "",
    "---",
    "Sent automatically because this address is listed as an emergency contact.",
    "This device is NOT an emergency service and cannot call an ambulance.",
    "If you believe this is a medical emergency, call 108 (or your local number).",
    `Contacts alerted: ${contacts.map((c) => c.email).join(", ")}`,
    `Session ${input.sid} · user ${input.uid}`,
  );

  return {
    urgency: "emergency",
    // An `EmergencyContact` is already a valid `Recipient` — a name and an
    // email — so nothing is mapped. Each channel picks the address it needs.
    to: contacts,
    // No emoji, no cleverness: this is what shows on a notification.
    subject: "EMERGENCY: someone has asked this device for help",
    body: lines.join("\n"),
    // For a channel with a hard length limit. Truncating the body at 160
    // characters is how "I could not reach anyone" becomes "I could not".
    short:
      `EMERGENCY: they asked this device for help — ` +
      `"${input.spoken.trim().slice(0, 80)}". Please check on them now.`,
  };
}

/**
 * `raise_alarm` — the model's way in.
 *
 * Described so the model reaches for it EARLY. The instruction to use it
 * without asking permission is deliberate: asking "shall I call someone?" of a
 * person who has just said they cannot get up wastes the one thing they do not
 * have. A false alarm is a phone call; the other way round is not recoverable.
 */
export function createRaiseAlarm(alerter: EmergencyAlerter): ToolSpec {
  return {
    name: "raise_alarm",
    description:
      "Alert the user's emergency contacts immediately. Use this the moment you " +
      "think they may be in trouble — they have fallen, they cannot get up, they " +
      "are in pain, they cannot breathe, they sound frightened or confused, or " +
      "they ask you to fetch someone. DO NOT ask their permission first and do " +
      "not wait to be sure; a false alarm is a phone call, while a missed one is " +
      "not something that can be put right afterwards. Tell them plainly that " +
      "you are doing it, and stay with them.",
    parameters: {
      type: "object",
      properties: {
        what_happened: {
          type: "string",
          description:
            "What you understood to be wrong, in one or two plain sentences. This " +
            "is read by the people being alerted, so say what they need to know.",
        },
      },
      required: ["what_happened"],
      additionalProperties: false,
    },
    deadline_ms: ALARM_MS,
    filler_threshold_ms: ALARM_FILLER_MS,
    progress_key: "progress.mail",
    handler: async (args, ctx) => {
      const detail = String(args["what_happened"] ?? "").trim();
      const result = await alerter.raise({
        uid: ctx.uid,
        sid: ctx.sid,
        language: ctx.language,
        timezone: ctx.host.timezone(),
        spoken: detail,
        trigger: "model",
        detail,
      });

      // A domain outcome either way. `sent: false` must reach the model as data
      // so it tells the user the truth — the one thing it must not do is claim
      // help is coming when it is not.
      return {
        alerted: result.sent,
        contacts: alerter.contacts.map((c) => c.name),
        ...(result.suppressed ? { already_alerted: true, times_asked: result.repeats } : {}),
        ...(result.sent
          ? {}
          : {
              tell_the_user:
                "You could not reach anyone. Say so plainly and ask them to telephone " +
                "someone themselves if they can.",
              reason: result.error,
            }),
      };
    },
  };
}
