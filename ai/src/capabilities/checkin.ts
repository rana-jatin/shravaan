/**
 * The daily check-in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS THE TEST OF THE LAST SIX STEPS, and what it does not contain is
 * the result. No scheduling, no persistence, no timing, no retry, no speech, no
 * notification — the same four machines medication uses, with different copy
 * and one genuinely different idea about what counts as an answer.
 *
 * THE DIFFERENCE, AND WHY IT NEEDED A NEW SEAM. Medication is acknowledged by
 * an act: the person says they took it and the model calls a tool. A check-in
 * is acknowledged by the person SAYING ANYTHING AT ALL, which no tool call can
 * represent — "theek hoon", "kaun hai" and a complaint about the heat are the
 * same answer to the only question being asked. So instead of a confirm tool
 * there is `answered`, polled on every sweep, and it reads exactly one bit: has
 * this conversation had another user turn since we asked.
 *
 * ⚠ ONE BIT, AND IT MUST STAY ONE BIT. Nothing here reads what they said,
 * scores it, or reports it. A check-in that noticed how somebody sounded would
 * be a wellbeing assessment, which is ADR 0009's territory, is off by default
 * for three good reasons, and has nothing to do with knowing whether anybody is
 * in the room.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { openEscalation } from "../escalation/ladder.ts";
import type { EscalationHandler } from "../escalation/runner.ts";
import type { Escalation } from "../escalation/types.ts";
import { CHECKIN_COPY, checkinNotice, pendingCheckinReview } from "../copy/checkin.ts";
import { t } from "../i18n/resolve.ts";
import { Notifier } from "../notify/notifier.ts";
import { buildTransport, transportGaps } from "../notify/transport.ts";
import type { Recipient } from "../notify/types.ts";
import type { OccurrenceHandler } from "../scheduler/ticker.ts";
import { parseContacts } from "../tools/emergency.ts";
import {
  CHECKIN_CAPABILITY,
  createCancelDailyCheckin,
  createSetDailyCheckin,
  type CheckinDeps,
} from "../tools/checkin.ts";
import type { Capability, CapabilityReport } from "./types.ts";

/**
 * Where the question was asked: which conversation, and at which turn.
 *
 * BOTH HALVES ARE LOAD-BEARING. The turn number alone is meaningless across a
 * reconnect — a fresh session starts counting again, so a person happily
 * chatting in a new session could still read as not having answered. Pinning
 * the sid means a restart resolves to "cannot tell", and the ladder's next rung
 * asks again in the new conversation and marks it there.
 */
type AskedAt = { sid: string; turn: number };

function askedAt(record: Escalation): AskedAt | null {
  const mark = record.payload["askedAt"];
  if (typeof mark !== "object" || mark === null) return null;
  const { sid, turn } = mark as Partial<AskedAt>;
  return typeof sid === "string" && typeof turn === "number" ? { sid, turn } : null;
}

export const checkinCapability: Capability = {
  name: CHECKIN_CAPABILITY,

  isConfigured: (cfg) => cfg.checkin.enabled,

  register(registry, { cfg, log, schedules, escalations, sessions, now }): CapabilityReport {
    const deps: CheckinDeps = { schedules, log };
    const specs = [createSetDailyCheckin(deps), createCancelDailyCheckin(deps)];
    for (const spec of specs) registry.register(spec);

    const { contacts } = parseContacts(cfg.emergency.contacts);
    const transport = buildTransport(cfg);
    const notifier = transport ? new Notifier({ channels: transport.channels }) : null;
    const canEscalate = notifier !== null && contacts.length > 0;
    const recipients: Recipient[] = contacts.map((c) => ({ name: c.name, email: c.email }));

    const onOccurrence: OccurrenceHandler = async (occurrence) => {
      await escalations.put(
        openEscalation(
          {
            uid: occurrence.schedule.uid,
            capability: CHECKIN_CAPABILITY,
            scheduleId: occurrence.schedule.id,
            dueAt: occurrence.at,
            payload: { timezone: occurrence.schedule.timezone },
          },
          new Date(now()),
        ),
      );
    };

    const escalation: EscalationHandler = {
      ladder: {
        // Slower than medication, deliberately. A tablet has a window; somebody
        // who has not spoken yet this morning has not done anything wrong.
        nudgeAfterMinutes: cfg.checkin.nudgeAfterMinutes,
        escalateAfterMinutes: cfg.checkin.escalateAfterMinutes,
        abandonAfterMinutes: cfg.checkin.abandonAfterMinutes,
      },

      speak: async (record, stage) => {
        const session = sessions.reach(record.uid);
        if (!session) return { spoken: false, reason: "no_session" };

        const result = await session.speakProactively({
          reason: `checkin_${stage}`,
          text: (language) => t(CHECKIN_COPY, stage === "reminded" ? "ask" : "nudge", language),
        });
        if (!result.spoken) return { spoken: false, reason: result.reason };

        // Read AFTER the utterance, because speaking is itself a turn. The mark
        // is what "have they answered" is measured against, so it has to be the
        // state the question left behind, not the state before it.
        return {
          spoken: true,
          payload: { askedAt: { sid: session.sid, turn: session.state.turn_no } },
        };
      },

      /**
       * One bit: has this conversation moved on since we asked.
       *
       * A NEW SESSION READS AS "CANNOT TELL" rather than as an answer, and that
       * is the safe direction for a wellbeing check — but it is not a dead end,
       * because the next rung asks again in the new conversation and re-marks
       * it there. So a device that rebooted between the question and the answer
       * costs one extra prompt, not a false alarm.
       */
      answered: async (record) => {
        const mark = askedAt(record);
        if (!mark) return false;

        const session = sessions.reach(record.uid);
        if (!session || session.sid !== mark.sid) return false;

        return session.state.turn_no > mark.turn;
      },

      notify: async (record) => {
        if (!notifier || !canEscalate) return { delivered: false, reason: "no_contacts" };

        const zone = record.payload["timezone"];
        const notice = checkinNotice({
          askedAt: new Date(record.dueAt),
          timezone: typeof zone === "string" ? zone : cfg.defaultTimezone,
          attempts: record.attempts,
          everSpoken: record.stage !== "pending",
        });

        const outcome = await notifier.send({
          // Not an emergency, and not a routine `info` either: somebody is
          // being asked to make a phone call they were not planning to make.
          urgency: "reminder",
          subject: notice.subject,
          body: notice.body,
          short: notice.short,
          to: recipients,
        });

        return outcome.delivered
          ? { delivered: true }
          : { delivered: false, reason: Notifier.firstError(outcome) ?? "nobody reachable" };
      },
    };

    log(canEscalate ? "info" : "warn", "daily check-in ARMED", {
      alerts: canEscalate ? contacts.map((c) => c.name) : [],
      transport: transport?.label ?? "none",
      ladder: `ask, again after ${cfg.checkin.nudgeAfterMinutes}m, tell somebody after a further ${cfg.checkin.escalateAfterMinutes}m, stop at ${cfg.checkin.abandonAfterMinutes}m`,
      answered_by: "any reply at all — nothing reads what they say",
      unreviewed_languages: [...new Set(pendingCheckinReview().map((e) => e.language))],
      ...(canEscalate
        ? {}
        : {
            effect: "the device asks, and nobody is told when there is no answer",
            ...transportGaps(cfg),
            hint: "set EMERGENCY_CONTACTS and a mail transport to arm the alert",
          }),
    });

    return {
      name: CHECKIN_CAPABILITY,
      registered: true,
      tools: specs.map((s) => s.name),
      detail: { checkin: canEscalate ? "asks+alerts" : "asks only" },
      onOccurrence,
      escalation,
    };
  },
};
