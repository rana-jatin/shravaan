/**
 * Medication reminders — the first capability that speaks without being asked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS WHAT THE LAST FIVE STEPS WERE FOR, and it is deliberately thin: a
 * schedule, four tools, two sentences of copy, and two handlers that wire the
 * existing machines together. Nothing here implements timing, persistence,
 * retries, escalation or speech. If a second reminder-shaped capability needs
 * to edit anything outside this file, the seams are wrong.
 *
 * WHAT IT DOES NOT DO, on purpose:
 *
 *   It does not recognise medications. The label is the user's words, stored
 *   and spoken back unchanged. Matching against a drug list would make this a
 *   system that gives medical advice.
 *
 *   It does not keep an adherence record. Confirming deletes the record. "Did
 *   I take it on Tuesday" has no answer here, the same rule as game scores.
 *
 *   It does not decide somebody missed a dose. The family message says the
 *   device asked and heard nothing, because that is the only thing observed.
 *
 * HALF-CONFIGURED IS ALLOWED HERE, unlike emergency alerting, and the
 * difference is worth stating. An alarm with nowhere to send it is worse than
 * no alarm, because the user is told help is coming. A reminder with nobody to
 * escalate to still does the main job — it reminds — so it runs, and the boot
 * log says plainly that the family half is off.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { openEscalation } from "../escalation/ladder.ts";
import type { EscalationHandler } from "../escalation/runner.ts";
import type { Escalation } from "../escalation/types.ts";
import { MEDICATION_COPY, familyNotice, pendingMedicationReview } from "../copy/medication.ts";
import { t } from "../i18n/resolve.ts";
import { Notifier } from "../notify/notifier.ts";
import { buildTransport, transportGaps } from "../notify/transport.ts";
import type { Recipient } from "../notify/types.ts";
import type { OccurrenceHandler } from "../scheduler/ticker.ts";
import { parseContacts } from "../tools/emergency.ts";
import {
  createCancelMedicationReminder,
  createConfirmMedication,
  createListMedicationReminders,
  createSetMedicationReminder,
  MEDICATION_CAPABILITY,
  type MedicationDeps,
} from "../tools/medication.ts";
import type { Capability, CapabilityReport } from "./types.ts";

function labelOf(escalation: Escalation): string {
  const label = escalation.payload["label"];
  return typeof label === "string" ? label : "your medication";
}

function timezoneOf(escalation: Escalation, fallback: string): string {
  const zone = escalation.payload["timezone"];
  return typeof zone === "string" ? zone : fallback;
}

export const medicationCapability: Capability = {
  name: MEDICATION_CAPABILITY,

  // A plain switch, unlike emergency's "anything set at all". There is no
  // half-configured state that needs reporting: contacts and a relay are
  // optional here, and their absence is a log line rather than a refusal.
  isConfigured: (cfg) => cfg.medication.enabled,

  register(registry, { cfg, log, schedules, escalations, sessions, now }): CapabilityReport {
    const deps: MedicationDeps = {
      schedules,
      escalations,
      maxPerUser: cfg.medication.maxPerUser,
      log,
    };

    const specs = [
      createSetMedicationReminder(deps),
      createListMedicationReminders(deps),
      createCancelMedicationReminder(deps),
      createConfirmMedication(deps),
    ];
    for (const spec of specs) registry.register(spec);

    // The same family and the same relay as the alarm — see the note in
    // shared/src/config/env.ts about why the list is reused rather than
    // duplicated, and why a deployment needing them apart needs a second one.
    const { contacts } = parseContacts(cfg.emergency.contacts);
    const transport = buildTransport(cfg);
    const notifier = transport ? new Notifier({ channels: transport.channels }) : null;
    const canEscalate = notifier !== null && contacts.length > 0;

    const recipients: Recipient[] = contacts.map((c) => ({ name: c.name, email: c.email }));

    /**
     * A schedule came due. Open a ladder and stop.
     *
     * IT DOES NOT SPEAK HERE, and that is the design: the sweep owns every
     * utterance, so there is exactly one code path that says a reminder out
     * loud and exactly one that decides whether it landed. Speaking here too
     * would mean the first attempt followed different rules from the retry.
     *
     * The cost is up to one sweep of latency — the same order as the tick that
     * produced this occurrence, and invisible against a wall clock reminder.
     */
    const onOccurrence: OccurrenceHandler = async (occurrence) => {
      const record = openEscalation(
        {
          uid: occurrence.schedule.uid,
          capability: MEDICATION_CAPABILITY,
          scheduleId: occurrence.schedule.id,
          dueAt: occurrence.at,
          // The zone travels with the record because the family message renders
          // a local time, and by then the schedule may have been deleted.
          payload: {
            label: occurrence.schedule.payload["label"],
            timezone: occurrence.schedule.timezone,
          },
        },
        // WHEN WE STARTED TRYING, not when the dose was due. After an outage
        // the ticker may hand over an occurrence several minutes old, and
        // dating the record from `dueAt` would put it straight past the nudge
        // window — telling the family before the device had said one word.
        new Date(now()),
      );
      await escalations.put(record);
    };

    const escalation: EscalationHandler = {
      ladder: {
        nudgeAfterMinutes: cfg.medication.nudgeAfterMinutes,
        escalateAfterMinutes: cfg.medication.escalateAfterMinutes,
        abandonAfterMinutes: cfg.medication.abandonAfterMinutes,
      },

      speak: async (record, stage) => {
        const session = sessions.reach(record.uid);
        // Not an error. An unplugged device, or somebody out of the house — and
        // the ladder treats never reaching them as MORE urgent than reaching
        // them and getting no answer.
        if (!session) return { spoken: false, reason: "no_session" };

        const label = labelOf(record);
        const result = await session.speakProactively({
          reason: `medication_${stage}`,
          // Resolved against the session's language at the moment of speaking.
          // The caller cannot know it: the person may have switched languages
          // three turns ago and told nobody outside that conversation.
          text: (language) =>
            t(MEDICATION_COPY, stage === "reminded" ? "reminder" : "nudge", language, {
              vars: { label },
            }),
        });

        return result.spoken ? { spoken: true } : { spoken: false, reason: result.reason };
      },

      notify: async (record) => {
        if (!notifier || !canEscalate) return { delivered: false, reason: "no_contacts" };

        const notice = familyNotice({
          label: labelOf(record),
          dueAt: new Date(record.dueAt),
          timezone: timezoneOf(record, cfg.defaultTimezone),
          attempts: record.attempts,
          // `pending` is the one stage that means nothing was ever said out
          // loud, and the family is told which of the two happened.
          everSpoken: record.stage !== "pending",
        });

        const outcome = await notifier.send({
          // NOT `emergency`. A channel uses this to decide whether it may wake
          // a phone at three in the morning, and an unconfirmed tablet may not.
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

    log(canEscalate ? "info" : "warn", "medication reminders ARMED", {
      escalates_to: canEscalate ? contacts.map((c) => c.name) : [],
      transport: transport?.label ?? "none",
      ladder: `remind, nudge after ${cfg.medication.nudgeAfterMinutes}m, tell family after a further ${cfg.medication.escalateAfterMinutes}m, stop at ${cfg.medication.abandonAfterMinutes}m`,
      unreviewed_languages: [...new Set(pendingMedicationReview().map((e) => e.language))],
      ...(canEscalate
        ? {}
        : {
            effect: "reminders and nudges work; nobody is told when one goes unanswered",
            ...transportGaps(cfg),
            hint: "set EMERGENCY_CONTACTS and a mail transport to arm the family half",
          }),
    });

    return {
      name: MEDICATION_CAPABILITY,
      registered: true,
      tools: specs.map((s) => s.name),
      detail: { medication: canEscalate ? "reminders+escalation" : "reminders only" },
      onOccurrence,
      escalation,
    };
  },
};
