/**
 * The shared ASR surface.
 *
 * Exists so the orchestrator can fail over between Sarvam and Deepgram without
 * knowing which one it is holding. The two protocols are genuinely different —
 * Sarvam takes base64 audio inside JSON frames and emits `vad.speech_start`,
 * Deepgram takes raw binary and emits `StartOfTurn` — and none of that difference
 * belongs in session.ts.
 *
 * ONE FIELD IS ASYMMETRIC AND IT MATTERS: `confidence`.
 *
 * Deepgram Flux publishes per-word confidence
 * ([quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)). Sarvam
 * documents `language_probability` — a *detection* score — and no ASR confidence
 * field anywhere (docs/05-open-questions.md Q4). So the "low ASR confidence →
 * targeted reprompt" rule in the original architecture is implementable on the
 * standby and NOT on the default provider. The field is optional here rather than
 * faked, because a fabricated 1.0 would make that rule silently never fire.
 */

import type { EventEmitter } from "node:events";
import type { AsrProviderName } from "../domain/asr-failover.ts";

export type AsrTranscript = {
  text: string;
  /** Present when auto-detection is active. */
  language?: string;
  /** Sarvam's `language_probability` — how sure it is of the LANGUAGE, not the words. */
  languageProbability?: number;
  /** Mean word confidence. Deepgram only; absent on the Sarvam path by design. */
  confidence?: number;
  startS?: number;
  endS?: number;
};

export interface AsrEvents {
  open: [];
  /**
   * Barge-in trigger. Both providers say to drive interruption off this and never
   * off a final transcript — Sarvam via `vad.speech_start`, Deepgram via
   * `StartOfTurn` ("more reliable than an external VAD").
   */
  speech_start: [];
  speech_end: [];
  partial: [AsrTranscript];
  final: [AsrTranscript];
  error: [Error];
  close: [{ code: number; reason: string }];
}

export interface AsrClient extends EventEmitter<AsrEvents> {
  readonly provider: AsrProviderName;
  connect(): void;
  /** linear16 PCM at the configured sample rate. */
  sendAudio(pcm: Buffer): void;
  /** Change language mid-stream without reconnecting. */
  updateLanguage(languageCode: string): void;
  flush(): void;
  close(): void;
}
