/**
 * The safety service, from this side.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A CLIENT AND NOT A SECOND DATABASE. `elderguard-backend/` already owns
 * telemetry: it ingests from the band over MQTT, from a CSV a caregiver
 * uploads, and from the device's own stream, and it evaluates every reading
 * against the anomaly bands. A companion keeping its own vitals store would
 * mean two records of the same person's health that disagree, and the family
 * reading whichever one their dashboard happened to be pointed at.
 *
 * So this package stores nothing about a reading. It sends what the person
 * said, asks what is on file, and picks up alerts somebody else raised.
 *
 * THE INTERFACES ARE NARROW ON PURPOSE. A capability takes a `VitalsSink` or an
 * `AlertFeed`, not this class — the tools that write a reading cannot settle an
 * alert, and the watcher that settles alerts cannot write a reading. One
 * concrete client implements both because there is one service behind them;
 * that is an implementation fact and not something the callers should share.
 *
 * A NON-2XX IS NOT AUTOMATICALLY INFRASTRUCTURE HERE, which is the one place
 * this file departs from `getJson`'s rule. A 409 means the person has no paired
 * device and a 404 means the service does not know them: both are things the
 * companion should SAY, in reviewed copy, rather than throw and have narrated
 * as an upstream error. A 5xx, a timeout or unparseable JSON still throws.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { HttpFetch } from "@sp-i/shared/providers/http.ts";
import type { JsonContext } from "@sp-i/shared/domain/types.ts";
import type { Reading, StoredVital } from "../domain/vitals.ts";
import { toWirePayload } from "../domain/vitals.ts";

/** What the safety service calls an alert. Mirrors its `CompanionAlert`. */
export type RemoteAlert = {
  id: string;
  device_id: string;
  alert_type: "sos" | "fall" | "anomaly";
  status: "open" | "acknowledged" | "resolved";
  source: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type RecordOutcome =
  | { ok: true; alerted: boolean }
  /**
   * `not_paired` — nobody has paired a device for this person, so there is
   * nothing to attach the reading to. `unknown_user` — this deployment's uid
   * does not name anybody over there, which is the seam's weakest joint and is
   * documented at `get_elder` on the other side. `rejected` — the service
   * refused the values themselves, which should be unreachable because
   * `parseReading` holds the same bounds, and is caught rather than trusted.
   */
  | { ok: false; reason: "not_paired" | "unknown_user" | "rejected" };

/** Writing a reading somebody said out loud. */
export interface VitalsSink {
  record(uid: string, reading: Reading): Promise<RecordOutcome>;
  recent(uid: string, limit: number): Promise<StoredVital[]>;
}

/** An alert plus the person it belongs to. What the service-wide feed returns. */
export type OwnedAlert = RemoteAlert & { uid: string };

/** Alerts raised by readings this process never saw. */
export interface AlertFeed {
  /**
   * Every open alert the service holds, whoever it belongs to.
   *
   * THE ONE THE WATCHER POLLS, and it is service-wide rather than per-user for
   * a reason worth stating: this process has no list of users. It learns a uid
   * when a device says hello, so a per-uid feed could only ever surface alerts
   * for somebody already in a conversation — and the band that raised the alert
   * does not need the companion device switched on. The person nobody can reach
   * is exactly the one whose family should hear about it.
   */
  allOpen(): Promise<OwnedAlert[]>;
  open(uid: string): Promise<RemoteAlert[]>;
  settle(uid: string, alertId: string, status: "acknowledged" | "resolved"): Promise<void>;
}

export type ElderguardOptions = {
  /** `http://safety:8000/api/v1`, without a trailing slash. */
  apiBase: string;
  /** Matches COMPANION_API_KEY on the service. */
  apiKey: string;
  fetch: HttpFetch;
  /**
   * One round trip on a local network. Short, because a tool call is inside a
   * turn and a person is waiting in real time — and because the answer to "the
   * safety service is not responding" is to say so, not to wait for it.
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 4000;

export class ElderguardClient implements VitalsSink, AlertFeed {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: HttpFetch;
  readonly #timeoutMs: number;

  constructor(opts: ElderguardOptions) {
    this.#base = opts.apiBase.replace(/\/+$/, "");
    this.#key = opts.apiKey;
    this.#fetch = opts.fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async record(uid: string, reading: Reading): Promise<RecordOutcome> {
    const res = await this.#send(`/companion/vitals/${encodeURIComponent(uid)}`, {
      method: "POST",
      body: JSON.stringify(toWirePayload(reading)),
    });

    if (res.status === 409) return { ok: false, reason: "not_paired" };
    if (res.status === 404) return { ok: false, reason: "unknown_user" };
    if (res.status === 422) return { ok: false, reason: "rejected" };
    const body = await parse<{ stored: boolean; alerted: boolean }>(res, "safety service");
    return { ok: true, alerted: body.alerted === true };
  }

  async recent(uid: string, limit: number): Promise<StoredVital[]> {
    const res = await this.#send(
      `/companion/vitals/${encodeURIComponent(uid)}?limit=${Math.max(1, Math.min(100, limit))}`,
    );
    // Not an error and not an empty answer dressed up as one: a person this
    // service has never heard of has no readings, which is what the tool says.
    if (res.status === 404) return [];
    return parse<StoredVital[]>(res, "safety service");
  }

  async allOpen(): Promise<OwnedAlert[]> {
    const res = await this.#send("/companion/alerts");
    return parse<OwnedAlert[]>(res, "safety service");
  }

  async open(uid: string): Promise<RemoteAlert[]> {
    const res = await this.#send(`/companion/alerts/${encodeURIComponent(uid)}`);
    if (res.status === 404) return [];
    return parse<RemoteAlert[]>(res, "safety service");
  }

  async settle(uid: string, alertId: string, status: "acknowledged" | "resolved"): Promise<void> {
    const res = await this.#send(
      `/companion/alerts/${encodeURIComponent(uid)}/${encodeURIComponent(alertId)}/ack`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
    // A 404 here means somebody else already dealt with it, or the row is
    // gone. Neither is worth failing a sweep over — the ladder's own record is
    // what decides whether we keep asking.
    if (res.status === 404) return;
    await parse<unknown>(res, "safety service");
  }

  /**
   * `SessionDeps.fetchContext`, bound to this client.
   *
   * RETURNS NULL RATHER THAN THROWING on every failure, and that is the
   * contract the session already expects: context is an enrichment, and a
   * person whose safety service is unreachable should still be able to have a
   * conversation. `Session` logs the miss and carries on with no context, which
   * withholds entitlement-gated tools and nothing else.
   */
  async context(uid: string): Promise<JsonContext | null> {
    try {
      const res = await this.#send(`/companion/context/${encodeURIComponent(uid)}`);
      if (!res.ok) return null;
      const body = await parse<{
        uid: string;
        fetched_at: string;
        identity: { display_name: string; timezone?: string | null };
        entitlements: JsonContext["entitlements"];
      }>(res, "safety service");

      return {
        uid: body.uid,
        fetched_at: body.fetched_at,
        identity: {
          display_name: body.identity.display_name,
          ...(body.identity.timezone ? { timezone: body.identity.timezone } : {}),
        },
        entitlements: body.entitlements ?? [],
      };
    } catch {
      return null;
    }
  }

  #send(path: string, init: { method?: string; body?: string } = {}): ReturnType<HttpFetch> {
    return this.#fetch(`${this.#base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        "x-companion-key": this.#key,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  }
}

/**
 * The 2xx path, and the one place a status becomes an exception.
 *
 * Everything the caller wanted to handle as data has already returned above, so
 * anything reaching here is genuinely the service misbehaving — and it fails
 * the way every other provider in this package fails, naming who did it.
 */
async function parse<T>(res: Awaited<ReturnType<HttpFetch>>, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} returned HTTP ${res.status}`);
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} returned unparseable JSON`);
  }
}
