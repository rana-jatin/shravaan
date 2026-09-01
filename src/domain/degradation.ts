/**
 * The degradation ledger — slice 8.
 *
 * Every dependency in this system can fail, and the design has an answer for each
 * one. What it did not have, until here, is a single place that says WHICH answer
 * is currently in force and whether the session is still worth holding open.
 * Scattering that across a dozen boolean flags is how a system ends up "degraded"
 * in nine ways at once and nobody notices.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT MATTERS: ONLY ANNOUNCE WHAT ENDS THE SESSION.
 *
 * A companion that says "my long-term memory is currently unavailable" is worse
 * than one that is simply a little shallower for an evening. Users do not want an
 * operations report; they want a conversation. So `shallow` degradations are
 * silent to the user and loud in the logs, and only a `mute` degradation — one
 * where we genuinely cannot continue — is ever spoken aloud.
 *
 * The inverse failure is worse still: going quiet without saying why. That is the
 * exact bug the speakability gate exists to prevent (docs/06-speakability-gate.md),
 * and a TTS outage is the same failure arriving from a different direction. Hence
 * pre-rendered audio: the one message you cannot synthesise is the one that says
 * synthesis is broken.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Spec: docs/01-architecture.md section 6, docs/adr/0008-degradation-policy.md
 */

import type { MessageKey } from "./types.ts";

export type DegradationKey =
  | "store_unavailable"
  | "context_unavailable"
  | "long_term_memory_unavailable"
  | "mem_writes_dropped"
  | "asr_failover_active"
  | "asr_unavailable"
  | "tts_unavailable"
  | "llm_retrying"
  | "llm_unavailable"
  | "tools_unavailable";

/**
 * `shallow` — the companion loses depth. The conversation continues, silently.
 * `mute`    — we can no longer hold a conversation. Say so, then close.
 */
export type Severity = "shallow" | "mute";

export type DegradationSpec = {
  severity: Severity;
  /** What the user actually loses. Written for a human reading an incident. */
  lost: string;
  /** Spoken key, present only where severity is `mute`. */
  message_key?: MessageKey;
  /** Can the audio for the message be synthesised, or must it be pre-rendered? */
  requires_prerendered_audio?: boolean;
};

export const DEGRADATIONS: Record<DegradationKey, DegradationSpec> = {
  store_unavailable: {
    severity: "shallow",
    lost: "turn window and profile — every turn becomes standalone, resume stops working",
  },
  context_unavailable: {
    severity: "shallow",
    lost: "JSON context — entitlement-gated tools are withheld rather than offered unverified",
  },
  long_term_memory_unavailable: {
    severity: "shallow",
    lost: "continuity across days; today's conversation is unaffected",
  },
  mem_writes_dropped: {
    severity: "shallow",
    lost: "some of today's turns will never reach long-term memory — a permanent hole, not a delay",
  },
  asr_failover_active: {
    severity: "shallow",
    lost: "Sarvam's codemix transcript formatting; Hinglish comes back in Latin script",
  },
  asr_unavailable: {
    severity: "mute",
    lost: "hearing. Nothing the user says reaches the system",
    message_key: "degraded.hearing_unavailable",
    // TTS is by definition still up on this path, so we can say it ourselves.
    requires_prerendered_audio: false,
  },
  tts_unavailable: {
    severity: "mute",
    lost: "voice. The accepted single point of failure — no Indic TTS failover exists",
    message_key: "degraded.voice_unavailable",
    // The one message that cannot be synthesised, because synthesis is what broke.
    requires_prerendered_audio: true,
  },
  llm_retrying: {
    severity: "shallow",
    lost: "nothing yet — retrying within the turn budget",
  },
  llm_unavailable: {
    severity: "mute",
    lost: "the ability to compose a reply at all",
    message_key: "degraded.thinking_unavailable",
    requires_prerendered_audio: false,
  },
  tools_unavailable: {
    severity: "shallow",
    lost: "actions on the world; the conversation itself is unaffected",
  },
};

export type Survivability = {
  level: "ok" | "degraded" | "mute";
  /** Present only at level `mute` — the first fatal key, in insertion order. */
  fatal?: DegradationKey;
};

export function survivability(keys: Iterable<DegradationKey>): Survivability {
  let any = false;
  for (const k of keys) {
    any = true;
    if (DEGRADATIONS[k]?.severity === "mute") return { level: "mute", fatal: k };
  }
  return { level: any ? "degraded" : "ok" };
}

/**
 * Records what is currently broken.
 *
 * Idempotent by construction: a flapping dependency that fails on every turn must
 * not push the same key onto the list twenty times, because `degraded` is
 * serialised into session state and read by humans during an incident.
 */
export class DegradationLedger {
  readonly #active = new Set<DegradationKey>();
  readonly #onChange: ((keys: DegradationKey[]) => void) | undefined;

  constructor(initial: readonly string[] = [], onChange?: (keys: DegradationKey[]) => void) {
    for (const k of initial) {
      if (isDegradationKey(k)) this.#active.add(k);
    }
    this.#onChange = onChange;
  }

  /** Returns true only on the transition, so callers can log once, not per turn. */
  mark(key: DegradationKey): boolean {
    if (this.#active.has(key)) return false;
    this.#active.add(key);
    this.#onChange?.(this.list());
    return true;
  }

  /** A dependency came back. Recovery is as reportable as failure. */
  clear(key: DegradationKey): boolean {
    if (!this.#active.delete(key)) return false;
    this.#onChange?.(this.list());
    return true;
  }

  has(key: DegradationKey): boolean {
    return this.#active.has(key);
  }

  list(): DegradationKey[] {
    return [...this.#active];
  }

  get survivability(): Survivability {
    return survivability(this.#active);
  }

  /** Everything the user is currently losing without being told. For logs. */
  silentLosses(): Array<{ key: DegradationKey; lost: string }> {
    return this.list()
      .filter((k) => DEGRADATIONS[k].severity === "shallow")
      .map((k) => ({ key: k, lost: DEGRADATIONS[k].lost }));
  }
}

export function isDegradationKey(v: string): v is DegradationKey {
  return Object.prototype.hasOwnProperty.call(DEGRADATIONS, v);
}
