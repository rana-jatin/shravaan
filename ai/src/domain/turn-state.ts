/**
 * Turn state machine. Pure — provider events in, phase transitions out.
 *
 * Normalises Sarvam's VAD events and Deepgram's Flux events into one internal
 * model so the rest of the pipeline is provider-agnostic.
 *
 * Spec: docs/01-architecture.md section 4
 */

import type { TurnEvent, TurnPhase } from "@sp-i/shared/domain/types.ts";

/**
 * `speaking -> interrupted` is the barge-in edge, and it is the one that depends
 * on acoustic echo cancellation working. If the canceller leaks, our own audio
 * triggers speech_start and the agent interrupts itself in a loop.
 * See docs/adr/0007-audio-front-end.md
 */
const TRANSITIONS: Record<TurnPhase, Partial<Record<TurnEvent["type"], TurnPhase>>> = {
  idle: { session_open: "listening" },
  listening: { speech_start: "user_speaking", idle_timeout: "idle" },
  user_speaking: { partial: "user_speaking", speech_end: "thinking" },
  thinking: { first_clause_ready: "speaking", tool_dispatched: "tool_wait" },
  tool_wait: { tool_result: "speaking", first_clause_ready: "speaking" },
  speaking: { speech_start: "interrupted", playback_drained: "listening" },
  interrupted: { speech_start: "user_speaking", partial: "user_speaking" },
};

export type TransitionResult = {
  phase: TurnPhase;
  changed: boolean;
  /** Set when the transition requires flushing queued device audio. */
  flushPlayback: boolean;
};

export function transition(phase: TurnPhase, event: TurnEvent): TransitionResult {
  const next = TRANSITIONS[phase][event.type];

  if (next === undefined) {
    // Unhandled events are ignored rather than throwing. Providers emit events
    // out of order under load, and a crashed session is worse than a dropped
    // event.
    return { phase, changed: false, flushPlayback: false };
  }

  return {
    phase: next,
    changed: next !== phase,
    flushPlayback: phase === "speaking" && next === "interrupted",
  };
}

export function isBargeIn(phase: TurnPhase, event: TurnEvent): boolean {
  return phase === "speaking" && event.type === "speech_start";
}

/** The agent is producing audio — used to gate the barge-in edge. */
export function isAgentSpeaking(phase: TurnPhase): boolean {
  return phase === "speaking";
}
