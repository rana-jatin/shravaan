/**
 * Vitals — two tools in front of somebody else's database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THINNEST CAPABILITY IN THE SET, AND THAT IS THE RESULT RATHER THAN THE
 * AMBITION. Every other elder-care feature here grew a store, a ladder and a
 * copy table; this one gets a base URL. `elderguard-backend/` already ingests
 * telemetry from three directions and checks it against its bands, so the work
 * was not to build vitals — it was to not build them twice.
 *
 * ⚠ WHAT IT DOES WITH A READING IS WRITE IT DOWN. The whole capability is
 * built to make judgement impossible from here: the tools return numbers and
 * units, the log line carries the metric and never the value, and nothing in
 * this file compares a reading to anything. The one place a vital sign is
 * judged is the safety service's bands, and the one thing that follows from a
 * judgement is a question asked in reviewed copy.
 *
 * BOTH HALVES OF THE CONFIG OR NEITHER. A base URL without a key reaches a
 * service that will answer 401 to everything, which would register two tools
 * that always fail — the exact "offers it and then withdraws it" failure
 * `isConfigured` exists to prevent.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { nodeFetch } from "@sp-i/shared/providers/http.ts";
import {
  copyKeysFor,
  pendingVitalsReview,
  VITALS_COPY,
  vitalsNotice,
  type ObservedReading,
} from "../copy/vitals.ts";
import { isHttpUrl, redactUrl } from "../domain/url.ts";
import type { EscalationHandler } from "../escalation/runner.ts";
import type { Escalation } from "../escalation/types.ts";
import { t } from "../i18n/resolve.ts";
import { Notifier } from "../notify/notifier.ts";
import { buildTransport, transportGaps } from "../notify/transport.ts";
import type { Recipient } from "../notify/types.ts";
import { ElderguardClient } from "../providers/elderguard.ts";
import { parseContacts } from "../tools/emergency.ts";
import {
  createLogVital,
  createRecentVitals,
  VITALS_CAPABILITY,
  type VitalsDeps,
} from "../tools/vitals.ts";
import { AlertWatcher } from "../vitals/alert-watcher.ts";
import { notRegistered, type Capability, type CapabilityReport } from "./types.ts";

export const vitalsCapability: Capability = {
  name: VITALS_CAPABILITY,

  isConfigured: (cfg) => cfg.vitals.apiBase !== null && cfg.vitals.apiKey !== null,

  register(registry, { cfg, log, escalations, sessions, now }): CapabilityReport {
    const apiBase = cfg.vitals.apiBase;
    const apiKey = cfg.vitals.apiKey;
    // `isConfigured` already said both are present; this is the narrowing, and
    // it is also the guard for a future caller that skips the check.
    if (!apiBase || !apiKey) return notRegistered(VITALS_CAPABILITY);

    // A URL somebody typed. Registering against `localhost:8000` — no scheme —
    // would produce two tools that throw on every call, and the boot log is
    // where that should be found rather than the first time somebody recites
    // their blood pressure.
    if (!isHttpUrl(apiBase)) {
      log("error", "vitals NOT registered — VITALS_API_BASE is not an http(s) URL", {
        given: apiBase,
        effect: "readings the user says out loud are heard and not kept",
      });
      return notRegistered(VITALS_CAPABILITY, { vitals: false });
    }

    const client = new ElderguardClient({
      apiBase,
      apiKey,
      fetch: nodeFetch(),
      timeoutMs: cfg.vitals.timeoutMs,
    });

    const watcher = new AlertWatcher({
      feed: client,
      escalations,
      capability: VITALS_CAPABILITY,
      intervalMs: cfg.vitals.pollSeconds * 1000,
      now,
      log,
    });

    const deps: VitalsDeps = {
      sink: client,
      // A reading the person just recited raised an alert. Poll now rather than
      // wait up to thirty seconds: the difference is being asked "are you all
      // right?" while the sentence is still in the air, or a minute later for
      // no visible reason.
      onAlerted: () => void watcher.poll().catch(() => {}),
      log,
    };
    const specs = [createLogVital(deps), createRecentVitals(deps)];
    for (const spec of specs) registry.register(spec);
    watcher.start();

    const { contacts } = parseContacts(cfg.emergency.contacts);
    const transport = buildTransport(cfg);
    const notifier = transport ? new Notifier({ channels: transport.channels }) : null;
    const canEscalate = notifier !== null && contacts.length > 0;
    const recipients: Recipient[] = contacts.map((c) => ({ name: c.name, email: c.email }));

    const escalation: EscalationHandler = {
      ladder: {
        nudgeAfterMinutes: cfg.vitals.nudgeAfterMinutes,
        escalateAfterMinutes: cfg.vitals.escalateAfterMinutes,
        abandonAfterMinutes: cfg.vitals.abandonAfterMinutes,
      },

      speak: async (record, stage) => {
        const session = sessions.reach(record.uid);
        if (!session) return { spoken: false, reason: "no_session" };

        const keys = copyKeysFor(alertKind(record));
        const result = await session.speakProactively({
          reason: `vitals_${alertKind(record)}_${stage}`,
          // ⚠ NO NUMBER IS EVER PASSED IN. The record holds the metric and the
          // value; the sentence holds neither. Telling somebody on their own
          // that their pulse was 195 is a device frightening a person about a
          // reading it cannot interpret, from a band that may have slipped.
          text: (language) =>
            t(VITALS_COPY, stage === "reminded" ? keys.ask : keys.nudge, language),
        });
        if (!result.spoken) return { spoken: false, reason: result.reason };

        return {
          spoken: true,
          payload: { askedAt: { sid: session.sid, turn: session.state.turn_no } },
        };
      },

      /**
       * The same one bit as the daily check-in: has this conversation moved on
       * since we asked.
       *
       * Right for the same reason and more strongly. "Theek hoon", "kaun hai"
       * and a complaint about the strap are all somebody answering a question
       * about whether they are all right, and no tool call could represent
       * that — least of all one the model has to remember while a person is
       * possibly on the floor.
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

        const notice = vitalsNotice({
          kind: alertKind(record),
          observedAt: observedAt(record),
          timezone: cfg.defaultTimezone,
          readings: readingsOf(record),
          attempts: record.attempts,
          everSpoken: record.stage !== "pending",
        });

        const outcome = await notifier.send({
          // NOT `emergency`, even for a fall. Consumer fall detection is wrong
          // often enough that waking a phone at three in the morning on the
          // strength of one would teach the recipient to mute it — which is the
          // channel being spent on the wrong night.
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

      /**
       * Close the alert where it was raised.
       *
       * WITHOUT THIS THE WATCHER WOULD FIND IT AGAIN on the next poll and ask
       * the same question for as long as the row stayed open. `acknowledged`
       * when somebody answered, `resolved` otherwise — the second is what stops
       * the service's own cooldown suppressing the NEXT reading, which after an
       * abandoned ladder is exactly what should not happen.
       */
      settled: async (record) => {
        const id = record.payload["alert_id"];
        if (typeof id !== "string") return;
        await client.settle(
          record.uid,
          id,
          record.stage === "acknowledged" ? "acknowledged" : "resolved",
        );
      },
    };

    log("info", "vitals ARMED", {
      // Host only. A base URL is configuration and generally safe to print,
      // but this one is pasted by hand next to a key, `http://user:pass@host`
      // is a thing people write, and boot logs get shipped.
      service: redactUrl(apiBase),
      stores: "nothing locally — the safety service owns every reading",
      // Said at boot because it is the promise the design rests on, and an
      // operator reading this line is the person who would notice it breaking.
      never: "the device does not say whether a reading is high, low or normal",
      watching: `open alerts every ${cfg.vitals.pollSeconds}s — falls and out-of-range readings, never an SOS`,
      ladder: `ask, again after ${cfg.vitals.nudgeAfterMinutes}m, tell somebody after a further ${cfg.vitals.escalateAfterMinutes}m, stop at ${cfg.vitals.abandonAfterMinutes}m`,
      alerts_to: canEscalate ? contacts.map((c) => c.name) : [],
      unreviewed_languages: [...new Set(pendingVitalsReview().map((e) => e.language))],
      residency: "our own service, wherever this deployment put it (docs/05 Q14)",
      ...(canEscalate
        ? {}
        : {
            effect: "the device asks, and nobody is told when there is no answer",
            ...transportGaps(cfg),
            hint: "set EMERGENCY_CONTACTS and a mail transport to arm the alert",
          }),
    });

    return {
      name: VITALS_CAPABILITY,
      registered: true,
      tools: specs.map((s) => s.name),
      detail: { vitals: canEscalate ? "log+read+alerts" : "log+read, alerts unreported" },
      dispose: () => watcher.stop(),
      escalation,
    };
  },
};

/** Which pair of sentences this record uses. Anything unrecognised reads as a reading. */
function alertKind(record: Escalation): "fall" | "anomaly" {
  return record.payload["alert_type"] === "fall" ? "fall" : "anomaly";
}

function observedAt(record: Escalation): Date {
  const at = record.payload["observed_at"];
  const parsed = typeof at === "string" ? new Date(at) : new Date(record.dueAt);
  return Number.isNaN(parsed.getTime()) ? new Date(record.dueAt) : parsed;
}

/**
 * The out-of-range values, as the safety service described them.
 *
 * Defensive because this crossed a network and a language boundary: the family
 * message is the last thing that should throw, and a malformed entry costs a
 * line of detail rather than the whole notice.
 */
function readingsOf(record: Escalation): ObservedReading[] {
  const raw = record.payload["readings"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is ObservedReading =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as ObservedReading).metric === "string" &&
      typeof (r as ObservedReading).value === "number",
  );
}

/** Where the question was asked. The same mark the daily check-in makes. */
type AskedAt = { sid: string; turn: number };

function askedAt(record: Escalation): AskedAt | null {
  const mark = record.payload["askedAt"];
  if (typeof mark !== "object" || mark === null) return null;
  const { sid, turn } = mark as Partial<AskedAt>;
  return typeof sid === "string" && typeof turn === "number" ? { sid, turn } : null;
}
