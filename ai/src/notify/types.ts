/**
 * Reaching a person who is not in the conversation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `MailSender`. The seam underneath the alarm used to be a
 * function that took a `MailMessage` — a *mail* abstraction, so SMS, a phone
 * call, push and WhatsApp had nowhere to plug in without rewriting the one path
 * in this product that must not be rewritten casually.
 *
 * The thing being abstracted is not "sending an email". It is "telling somebody
 * who is not here that something has happened", and the right unit of that is a
 * NOTIFICATION plus a list of CHANNELS that might carry it. A channel knows two
 * things: whether it can reach a given person at all, and how to say it.
 *
 * WHAT DOES NOT CHANGE: this is still not an emergency service. It tells people
 * who know the user. It cannot call 108, and adding a `call` channel later must
 * not be allowed to blur that — see the header of tools/emergency.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Channels that exist, and the ones the interface was shaped to admit. */
export type ChannelKind = "email" | "sms" | "call" | "push" | "whatsapp";

/**
 * Someone to tell.
 *
 * Every address is optional because a channel decides for itself whether it can
 * reach this person — a contact with only an email is unreachable by SMS, and
 * that is a routing fact rather than a configuration error.
 */
export type Recipient = {
  /** SPOKEN back to the user ("I'm telling Harsh"), so it must read as a name. */
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
};

/**
 * How hard this is trying to interrupt someone.
 *
 * Not a priority number. A channel uses it to decide whether it may wake a
 * phone at 3 a.m., and a future escalation ladder uses it to decide what to
 * reach for next.
 */
export type Urgency = "emergency" | "reminder" | "info";

export type Notification = {
  urgency: Urgency;
  /** Used by channels that have one. SMS and calls ignore it. */
  subject: string;
  /** Plain text — the only body every channel can carry. */
  body: string;
  /**
   * For channels with a hard length limit. Falls back to `body`.
   *
   * Deliberately separate rather than truncating: an SMS cut mid-sentence at
   * 160 characters is how "I could not reach anyone" becomes "I could not".
   */
  short?: string | undefined;
  to: Recipient[];
};

/** What one channel managed. */
export type DeliveryResult = {
  kind: ChannelKind;
  /** Names actually reached. Empty with no error means nobody was reachable. */
  delivered: string[];
  error?: string | undefined;
};

export type NotificationChannel = {
  kind: ChannelKind;

  /**
   * Can this channel reach them at all?
   *
   * Checked before sending so a channel is never handed a recipient it has no
   * address for, and so "nobody was reachable" is distinguishable from "the
   * transport failed" in the result.
   */
  canReach(recipient: Recipient): boolean;

  /** Throws on failure. The Notifier owns retrying and reporting. */
  send(notification: Notification): Promise<void>;
};
