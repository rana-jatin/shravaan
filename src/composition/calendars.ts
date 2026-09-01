/**
 * Calendars: two backends, one tool.
 *
 * Registered only where a calendar is configured — the same rule every other
 * external tool follows (see composition/tools.ts).
 *
 * Extracted from src/server.ts. The three-way gate on writing is the part worth
 * reading: a credential that CAN write, a calendar id, and an explicitly named
 * target. A guess about which diary an appointment belongs in is not a default
 * worth having.
 */

import { readFileSync } from "node:fs";

import type { Config } from "../config/env.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  createAddAppointment,
  createGetAppointments,
  googleSource,
  icalSource,
  type CalendarSource,
} from "../tools/calendar.ts";
import { GoogleCalendar, parseServiceAccount } from "../providers/google-calendar.ts";
import type { Log } from "./types.ts";
import { isHttpUrl, redactUrl } from "./url.ts";

export type CalendarWiring = {
  /** Labels of every calendar that ended up readable. */
  sources: string[];
  /** True where add_appointment was registered, not merely where it could be. */
  writable: boolean;
};

export function registerCalendars(tools: ToolRegistry, cfg: Config, log: Log): CalendarWiring {
  // Calendars. Two backends, one tool — see src/tools/calendar.ts. Registered
  // only where a calendar is configured, same rule as every other external tool.
  const calendarSources: CalendarSource[] = [];

  for (const [label, url] of Object.entries(cfg.calendarFeeds)) {
    if (!isHttpUrl(url)) {
      log("error", "CALENDAR_FEEDS entry is not a usable http(s) URL — dropped", {
        label,
        url: redactUrl(url),
      });
      continue;
    }
    calendarSources.push(icalSource(label, url));
  }
  if (cfg.calendarFeedsDropped.length > 0) {
    log("error", "CALENDAR_FEEDS has unreadable segments — a URL is likely truncated", {
      dropped: cfg.calendarFeedsDropped,
      hint: "percent-encode a literal comma as %2C",
    });
  }

  // The API path. A service account outranks an API key where both are set,
  // because a key cannot read a private calendar OR write at all.
  let googleCalendar: GoogleCalendar | null = null;
  try {
    const account = parseServiceAccount(cfg.googleServiceAccountJson, (p) =>
      readFileSync(p, "utf8"),
    );
    if (account) {
      googleCalendar = new GoogleCalendar({
        auth: { mode: "service_account", ...account },
      });
      log("info", "google calendar: service account", { client_email: account.clientEmail });
    } else if (cfg.googleCalendarApiKey) {
      googleCalendar = new GoogleCalendar({
        auth: { mode: "api_key", key: cfg.googleCalendarApiKey },
      });
      // Said at boot, once, in the place someone will actually look — rather
      // than left to surface as a 401 in the middle of a conversation.
      log("warn", "google calendar: API KEY ONLY — public calendars, read-only", {
        cannot: ["read a private calendar", "create or change any event"],
        fix: "share the calendar with a service account, then set GOOGLE_SERVICE_ACCOUNT_JSON",
      });
    }
  } catch (err) {
    log("error", "google calendar credential unusable — API path disabled", {
      error: String(err instanceof Error ? err.message : err),
    });
  }

  if (googleCalendar) {
    if (Object.keys(cfg.googleCalendarIds).length === 0) {
      log("error", "a Google credential is set but GOOGLE_CALENDAR_IDS is empty", {
        hint: "label=calendarId pairs; a personal calendar's id is its email address",
      });
    }
    for (const [label, id] of Object.entries(cfg.googleCalendarIds)) {
      calendarSources.push(googleSource(label, id, googleCalendar));
    }
  }
  if (cfg.googleCalendarIdsDropped.length > 0) {
    log("error", "GOOGLE_CALENDAR_IDS has unreadable segments", {
      dropped: cfg.googleCalendarIdsDropped,
      hint: "percent-encode a literal comma as %2C",
    });
  }

  if (calendarSources.length > 0) {
    tools.register(
      createGetAppointments({ sources: calendarSources, limit: cfg.calendarEventLimit }),
    );
  }

  // Writing. Gated three ways: a credential that CAN write, a calendar id, and
  // an explicitly named target — never a guess about which diary an appointment
  // belongs in.
  if (googleCalendar?.canWrite) {
    const target = cfg.calendarWriteTarget;
    const ids = cfg.googleCalendarIds;
    const only = Object.keys(ids).length === 1 ? Object.keys(ids)[0]! : null;
    const label = target ?? only;

    if (label && ids[label]) {
      tools.register(
        createAddAppointment({ client: googleCalendar, calendarId: ids[label], label }),
      );
    } else if (label) {
      log("error", "CALENDAR_WRITE_TARGET names a calendar that is not configured", {
        target: label,
        known: Object.keys(ids),
      });
    } else if (Object.keys(ids).length > 1) {
      log("warn", "add_appointment not registered: several calendars, no write target named", {
        known: Object.keys(ids),
        hint: "set CALENDAR_WRITE_TARGET to one of them",
      });
    }
  }

  return {
    sources: calendarSources.map((s) => s.label),
    writable: googleCalendar?.canWrite ?? false,
  };
}
