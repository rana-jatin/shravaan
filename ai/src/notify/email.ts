/**
 * The email channel — the one this product actually ships.
 *
 * A thin adapter over `MailSender`, which keeps both transports underneath it:
 * SMTP for a relay inside India, and the web API for the round-trip and
 * reachability reasons set out in providers/mail-api.ts. Neither of those
 * arguments changes by being behind a channel.
 */

import type { MailMessage, MailSender } from "../providers/smtp.ts";
import type { NotificationChannel, Notification, Recipient } from "./types.ts";

export function emailChannel(send: MailSender): NotificationChannel {
  return {
    kind: "email",
    canReach: (recipient: Recipient) => Boolean(recipient.email),
    async send(notification: Notification) {
      const to = notification.to.map((r) => r.email).filter((e): e is string => Boolean(e));
      if (to.length === 0) return;

      const message: MailMessage = {
        to,
        subject: notification.subject,
        text: notification.body,
      };
      await send(message);
    },
  };
}
