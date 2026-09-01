/**
 * The speakability gate.
 *
 * Stops the pipeline from reasoning its way to a reply it has no voice to speak.
 * Every other failure in this system announces itself; this one does not. Saaras
 * transcribes 22 Indian languages accurately, Bulbul speaks 10, and without this
 * check the ASR succeeds, the LLM succeeds, and the user hears silence.
 *
 * Fires at THREE points, not one — with auto-detection we do not know the
 * language at session open, we learn it from the first utterance.
 *
 * Spec: docs/06-speakability-gate.md
 */

import {
  SWITCH_CONFIRM_TURNS,
  isSpeakable,
  normalizeLanguage,
  resolveRespondIn,
  speakabilityOf,
} from "./languages.ts";
import type { GateDecision, LanguageCode, SessionState } from "@sp-i/shared/domain/types.ts";

export type SeedInput = {
  /** user:{uid}:profile.preferred_language */
  profileLanguage?: LanguageCode | undefined;
  /** JsonContext.identity.locale_hint */
  localeHint?: LanguageCode | undefined;
  /** Configured default, used when nothing else is known. */
  fallback: LanguageCode;
};

/**
 * Resolve the seed language. Ordered, first hit wins.
 *
 * The seed is a HINT for the ASR and an input to Gate 1 only. Once Gate 2 has a
 * detected language, that value wins.
 */
export function resolveSeedLanguage(input: SeedInput): {
  code: LanguageCode;
  source: "profile" | "context" | "default";
} {
  if (input.profileLanguage) {
    return { code: normalizeLanguage(input.profileLanguage)!, source: "profile" };
  }
  if (input.localeHint) {
    return { code: normalizeLanguage(input.localeHint)!, source: "context" };
  }
  return { code: input.fallback, source: "default" };
}

/**
 * GATE 1 — pre-connect.
 *
 * Runs before the ASR socket is created. Refusing here costs nothing and saves a
 * socket against a 20-connection concurrency ceiling.
 */
export function gate1PreConnect(seed: LanguageCode): GateDecision {
  const verdict = speakabilityOf(seed);

  if (verdict.status === "speakable") {
    return { verdict, gate: 1, action: "proceed", respond_in: verdict.code };
  }

  // No detection has happened yet, so an unknown seed is treated the same as a
  // known-unspeakable one: we have nothing to talk to the user with.
  return {
    verdict,
    gate: 1,
    action: "refuse_pre_connect",
    respond_in: resolveRespondIn({}),
    message_key: "gate.unsupported_language",
  };
}

/**
 * GATE 2 — first detected language.
 *
 * MUST run before the LLM dispatch. Not merely for latency: Sarvam-105B is
 * capped at 40 req/min on Starter and that ceiling is the system's binding
 * concurrency constraint. Spending a request to generate a reply that can never
 * be spoken burns the scarcest resource in the stack to produce nothing.
 */
export function gate2FirstDetection(args: {
  detected: string | null | undefined;
  confidence?: number | undefined;
  seed: LanguageCode;
  profileLanguage?: LanguageCode | undefined;
}): GateDecision {
  const verdict = speakabilityOf(args.detected, args.confidence);

  switch (verdict.status) {
    case "speakable":
      return { verdict, gate: 2, action: "proceed", respond_in: verdict.code };

    case "uncertain": {
      // Never refuse on doubt. Fall back to the seed if we can speak it,
      // otherwise ask the user to repeat themselves.
      const action = isSpeakable(args.seed) ? "fallback_to_seed" : "reprompt";
      return {
        verdict,
        gate: 2,
        action,
        respond_in: resolveRespondIn({ preferred: args.profileLanguage, previous: args.seed }),
      };
    }

    case "heard_not_speakable":
    case "out_of_scope":
      return {
        verdict,
        gate: 2,
        action: "refuse_and_close",
        respond_in: resolveRespondIn({ preferred: args.profileLanguage, previous: args.seed }),
        message_key: "gate.unsupported_language",
      };
  }
}

/**
 * GATE 3 — mid-session language switch.
 *
 * MUST NOT end the session. A user switching into Urdu at turn nine has not made
 * an error — they are mid-conversation with something they have been talking to
 * for weeks. Decline the switch, acknowledge once, carry on in the previous
 * language.
 *
 * Requires SWITCH_CONFIRM_TURNS consecutive detections before declining: a
 * single off-set turn inside a Hindi conversation is far more likely a detection
 * artefact than a real switch.
 *
 * Returns the decision plus the mutated switch-tracking fields, so the caller can
 * persist them without this function touching state itself.
 */
export function gate3Switch(args: {
  detected: string | null | undefined;
  confidence?: number | undefined;
  state: Pick<SessionState, "language" | "switch_declined_acknowledged" | "pending_switch">;
  profileLanguage?: LanguageCode | undefined;
}): {
  decision: GateDecision;
  pending_switch: SessionState["pending_switch"];
  acknowledge: boolean;
} {
  const { state } = args;
  const verdict = speakabilityOf(args.detected, args.confidence);
  const current = state.language;

  const respond_in = resolveRespondIn({
    preferred: args.profileLanguage,
    previous: current,
  });

  // Speakable — including the same language, and including Hindi <-> English
  // code-mixing, which must never be treated as a decline.
  if (verdict.status === "speakable") {
    return {
      decision: { verdict, gate: 3, action: "proceed", respond_in: verdict.code },
      pending_switch: undefined,
      acknowledge: false,
    };
  }

  // Doubtful read: stay where we are, clear any pending switch. No user-visible
  // effect at all.
  if (verdict.status === "uncertain") {
    return {
      decision: { verdict, gate: 3, action: "fallback_to_seed", respond_in: current },
      pending_switch: undefined,
      acknowledge: false,
    };
  }

  // Confidently unspeakable. Require persistence before acting on it.
  const code = verdict.code;
  const consecutive =
    state.pending_switch?.code === code ? state.pending_switch.consecutive + 1 : 1;

  if (consecutive < SWITCH_CONFIRM_TURNS) {
    return {
      decision: { verdict, gate: 3, action: "fallback_to_seed", respond_in: current },
      pending_switch: { code, consecutive },
      acknowledge: false,
    };
  }

  // Confirmed. Decline the switch — acknowledging only the first time, so we do
  // not repeat the apology every time an Urdu phrase appears.
  const acknowledge = !state.switch_declined_acknowledged;
  return {
    decision: {
      verdict,
      gate: 3,
      action: "decline_switch",
      respond_in,
      ...(acknowledge ? { message_key: "gate.switch_declined" as const } : {}),
    },
    pending_switch: { code, consecutive },
    acknowledge,
  };
}

/** True when a decision means the turn must not reach the LLM. */
export function blocksLlm(decision: GateDecision): boolean {
  return (
    decision.action === "refuse_pre_connect" ||
    decision.action === "refuse_and_close" ||
    decision.action === "reprompt"
  );
}

/** True when a decision ends the session. Gate 3 never does. */
export function endsSession(decision: GateDecision): boolean {
  return decision.action === "refuse_pre_connect" || decision.action === "refuse_and_close";
}
