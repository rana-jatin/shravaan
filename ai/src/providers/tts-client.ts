/**
 * The shared TTS surface.
 *
 * Unlike ASR, this interface does NOT exist because there are two providers.
 * There is one, and there will be one: no Indic TTS failover exists anywhere in
 * the stack (docs/adr/0005-tts-provider-split.md), which is exactly why Bulbul is
 * recorded as the system's accepted single point of failure.
 *
 * It exists so the orchestrator can be constructed against something other than a
 * live WebSocket. `Session` owns the barge-in path, the filler policy and the
 * echo-guard lifecycle, and until this interface existed none of that could be
 * tested without opening a socket to Sarvam — see docs/07-defect-register.md §9.
 *
 * Scope is deliberately the orchestrator's vocabulary, not Bulbul's. `connected`
 * and the reconnect budget stay inside the concrete client, because a fake that
 * had to model them would be modelling the wrong thing.
 */

import type { EventEmitter } from "node:events";

export type TtsOptions = {
  languageCode: string;
  speaker: string;
  pace?: number;
};

export interface TtsEvents {
  open: [];
  audio: [Buffer];
  /** Emitted when the server signals the current utterance is complete. */
  done: [];
  error: [Error];
  close: [{ code: number; reason: string }];
  /** A transparent reconnect is under way. Informational — not yet a failure. */
  reconnecting: [{ attempt: number; delayMs: number }];
  /** Reconnect exhausted its budget. The system now has no voice at all. */
  unavailable: [Error];
  /** Speech was queued during an outage and discarded for being too old. */
  dropped: [{ chars: number; ageMs: number }];
}

export interface TtsClient extends EventEmitter<TtsEvents> {
  connect(): void;
  speak(text: string): void;
  /** Force synthesis of whatever is buffered, ignoring min_buffer_size. */
  flush(): void;
  /** Switch voice/language without reconnecting. */
  reconfigure(opts: Partial<TtsOptions>): void;
  /**
   * Abandon queued speech — barge-in, or a turn the orchestrator gave up on.
   *
   * On the interface rather than only on the concrete client on purpose: it is
   * currently called from nowhere, and D2 (audio from an interrupted reply still
   * reaching the device) is the defect that needs it.
   */
  clearQueue(): void;
  close(): void;
}
