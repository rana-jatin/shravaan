/**
 * Notification channels.
 *
 * The seam under the alarm used to be a single `MailSender` — a *mail*
 * abstraction, so SMS, a call, push and WhatsApp had nowhere to plug in. These
 * tests cover the routing rules that replaced it, and the one behaviour that
 * must survive every future channel: telling the truth about what was sent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Notifier } from "../src/notify/notifier.ts";
import { emailChannel } from "../src/notify/email.ts";
import type {
  ChannelKind,
  Notification,
  NotificationChannel,
  Recipient,
} from "../src/notify/types.ts";
import type { MailMessage } from "../src/providers/smtp.ts";

const HARSH: Recipient = { name: "Harsh", email: "harsh@example.com" };
const AMAN: Recipient = { name: "Aman", phone: "+915550000000" };
const BOTH: Recipient = { name: "Priya", email: "priya@example.com", phone: "+915550000001" };

function notification(over: Partial<Notification> = {}): Notification {
  return {
    urgency: "emergency",
    subject: "EMERGENCY: someone has asked this device for help",
    body: "They said: help help",
    to: [HARSH],
    ...over,
  };
}

/** A channel that records rather than sends. */
function recorder(kind: ChannelKind, reach: (r: Recipient) => boolean) {
  const sent: Notification[] = [];
  const channel: NotificationChannel = {
    kind,
    canReach: reach,
    send: async (n) => void sent.push(n),
  };
  return { channel, sent };
}

describe("the email channel", () => {
  it("reaches a contact with an address and not one without", () => {
    const channel = emailChannel(async () => {});
    assert.equal(channel.canReach(HARSH), true);
    assert.equal(channel.canReach(AMAN), false);
  });

  it("carries the notification into a mail message", async () => {
    const sent: MailMessage[] = [];
    await emailChannel(async (m) => void sent.push(m)).send(notification({ to: [HARSH, BOTH] }));

    assert.deepEqual(sent[0]!.to, ["harsh@example.com", "priya@example.com"]);
    assert.match(sent[0]!.subject, /EMERGENCY/);
    assert.equal(sent[0]!.text, "They said: help help");
  });

  it("sends nothing rather than an empty envelope", async () => {
    let calls = 0;
    await emailChannel(async () => void calls++).send(notification({ to: [AMAN] }));
    assert.equal(calls, 0);
  });
});

describe("delivering a notification", () => {
  it("tries every channel, not just the first that works", async () => {
    // For an emergency this is the point: a phone on silent and an unread inbox
    // fail in uncorrelated ways.
    const a = recorder("email", (r) => Boolean(r.email));
    const b = recorder("sms", (r) => Boolean(r.phone));

    const out = await new Notifier({ channels: [a.channel, b.channel] }).send(
      notification({ to: [HARSH, AMAN] }),
    );

    assert.equal(a.sent.length, 1);
    assert.equal(b.sent.length, 1);
    assert.equal(out.delivered, true);
    assert.deepEqual(out.reached.sort(), ["Aman", "Harsh"]);
  });

  it("hands a channel only the people it can reach", async () => {
    const sms = recorder("sms", (r) => Boolean(r.phone));
    await new Notifier({ channels: [sms.channel] }).send(notification({ to: [HARSH, AMAN, BOTH] }));

    assert.deepEqual(
      sms.sent[0]!.to.map((r) => r.name),
      ["Aman", "Priya"],
    );
  });

  it("counts someone reached twice only once", async () => {
    const a = recorder("email", () => true);
    const b = recorder("sms", () => true);
    const out = await new Notifier({ channels: [a.channel, b.channel] }).send(
      notification({ to: [BOTH] }),
    );
    assert.deepEqual(out.reached, ["Priya"]);
  });

  it("distinguishes nobody reachable from the transport failing", async () => {
    // Not an error: a contact with only an email is simply not reachable by
    // SMS, and saying so is more useful than reporting a failure.
    const sms = recorder("sms", (r) => Boolean(r.phone));
    const out = await new Notifier({ channels: [sms.channel] }).send(notification({ to: [HARSH] }));

    assert.equal(out.delivered, false);
    assert.deepEqual(out.results, [{ kind: "sms", delivered: [] }]);
    assert.equal(Notifier.firstError(out), undefined);
  });

  it("retries a channel once before giving up", async () => {
    // A transient TCP failure to a relay is cheap to retry; a rejected password
    // fails identically twice and the second attempt costs a second.
    let calls = 0;
    const flaky: NotificationChannel = {
      kind: "email",
      canReach: () => true,
      send: async () => {
        calls++;
        throw new Error("ECONNREFUSED");
      },
    };

    const out = await new Notifier({ channels: [flaky] }).send(notification());
    assert.equal(calls, 2);
    assert.equal(out.delivered, false);
    assert.match(Notifier.firstError(out)!, /ECONNREFUSED/);
  });

  it("stops retrying as soon as one attempt succeeds", async () => {
    let calls = 0;
    const flaky: NotificationChannel = {
      kind: "email",
      canReach: () => true,
      send: async () => {
        if (++calls === 1) throw new Error("transient");
      },
    };

    const out = await new Notifier({ channels: [flaky] }).send(notification());
    assert.equal(calls, 2);
    assert.equal(out.delivered, true);
  });

  it("keeps going when one channel is broken", async () => {
    // One dead transport must not silence the others. That is the whole reason
    // for having more than one.
    const broken: NotificationChannel = {
      kind: "sms",
      canReach: () => true,
      send: async () => {
        throw new Error("gateway down");
      },
    };
    const working = recorder("email", () => true);

    const out = await new Notifier({ channels: [broken, working.channel] }).send(notification());

    assert.equal(out.delivered, true);
    assert.deepEqual(out.reached, ["Harsh"]);
    assert.equal(working.sent.length, 1);
  });

  it("never throws, whatever a channel does", async () => {
    // It is called from the middle of the session's speech path. An exception
    // would take down the turn that is telling the user help is coming.
    const hostile: NotificationChannel = {
      kind: "call",
      canReach: () => true,
      send: () => {
        throw new Error("thrown synchronously");
      },
    };
    const out = await new Notifier({ channels: [hostile] }).send(notification());
    assert.equal(out.delivered, false);
  });

  it("reports not delivered when there are no channels at all", async () => {
    const out = await new Notifier({ channels: [] }).send(notification());
    assert.equal(out.delivered, false);
    assert.deepEqual(out.results, []);
  });
});
