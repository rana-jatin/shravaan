/**
 * Sarvam Bulbul TTS client — streaming WebSocket.
 *
 * Bulbul is the ONLY voice in this system. There is no failover for any
 * language — see docs/adr/0005-tts-provider-split.md. Treat every failure here
 * as user-visible.
 *
 * TWO NON-OBVIOUS PROTOCOL FACTS, both documented by Sarvam and both load-bearing:
 *   1. The socket auto-closes after ~1 minute idle. A companion pauses far longer
 *      than that, so the keepalive below is a correctness requirement, not a
 *      nicety. It is also a latency measure: Sarvam states time-to-first-audio is
 *      "lowest on a warm connection".
 *   2. Text messages are capped at 2500 characters, with under 500 recommended
 *      for streaming. The clause chunker upstream keeps us well below both.
 *
 * ⚠ UNVERIFIED: socket path, auth header and message field names — see
 * sarvam-asr.ts header and docs/05-open-questions.md Q12.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Config } from "../config/env.ts";

/** Sarvam's documented idle close is ~60s; ping well inside it. */
const KEEPALIVE_MS = 25_000;
const MAX_TEXT_CHARS = 2500;

export type TtsOptions = {
  languageCode: string;
  speaker: string;
  pace?: number;
};

export interface SarvamTtsEvents {
  open: [];
  audio: [Buffer];
  /** Emitted when the server signals the current utterance is complete. */
  done: [];
  error: [Error];
  close: [{ code: number; reason: string }];
}

export class SarvamTts extends EventEmitter<SarvamTtsEvents> {
  #ws: WebSocket | null = null;
  #keepalive: NodeJS.Timeout | null = null;
  #configured = false;
  readonly #cfg: Config;
  #opts: TtsOptions;

  constructor(cfg: Config, opts: TtsOptions) {
    super();
    this.#cfg = cfg;
    this.#opts = opts;
  }

  connect(): void {
    const url = new URL("/text-to-speech/ws", this.#cfg.wsBase);
    url.searchParams.set("model", this.#cfg.ttsModel);

    const ws = new WebSocket(url, {
      headers: { "api-subscription-key": this.#cfg.sarvamApiKey },
    });
    this.#ws = ws;

    ws.on("open", () => {
      this.#sendConfig();
      this.#startKeepalive();
      this.emit("open");
    });
    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("error", (err) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
    ws.on("close", (code, reason) => {
      this.#stopKeepalive();
      this.#configured = false;
      this.emit("close", { code, reason: reason.toString() });
    });
  }

  #sendConfig(): void {
    this.#send({
      type: "config",
      speaker: this.#opts.speaker,
      language_code: this.#opts.languageCode,
      pace: this.#opts.pace ?? this.#cfg.ttsPace,
      output_audio_codec: "linear16",
      // Bulbul streaming is capped at 24 kHz; env validation enforces this.
      sample_rate: this.#cfg.ttsSampleRate,
      send_completion_event: true,
    });
    this.#configured = true;
  }

  /**
   * Switch voice/language without reconnecting. Used when a user switches
   * between two speakable languages mid-conversation.
   *
   * ⚠ Whether a given speaker sounds like the SAME PERSON across languages is
   * undocumented by Sarvam and unresolved — docs/05-open-questions.md Q2. For a
   * companion this is a product risk, not a cosmetic one.
   */
  reconfigure(opts: Partial<TtsOptions>): void {
    this.#opts = { ...this.#opts, ...opts };
    if (this.#ws?.readyState === WebSocket.OPEN) this.#sendConfig();
  }

  speak(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    if (trimmed.length > MAX_TEXT_CHARS) {
      this.emit(
        "error",
        new Error(
          `TTS text of ${trimmed.length} chars exceeds Sarvam's ${MAX_TEXT_CHARS} limit. ` +
            `The clause chunker should have prevented this.`,
        ),
      );
      return;
    }
    if (!this.#configured) this.#sendConfig();
    this.#send({ type: "text", text: trimmed });
  }

  /** Force synthesis of whatever is buffered, ignoring min_buffer_size. */
  flush(): void {
    this.#send({ type: "flush" });
  }

  close(): void {
    this.#stopKeepalive();
    this.#ws?.close();
    this.#ws = null;
  }

  #onMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      this.emit("error", new Error("TTS sent non-JSON frame"));
      return;
    }

    const type = String(msg["type"] ?? "");
    if (type === "audio" || msg["audio"] !== undefined) {
      const b64 = msg["audio"] ?? (msg["data"] as unknown);
      if (typeof b64 === "string") this.emit("audio", Buffer.from(b64, "base64"));
      return;
    }
    if (type === "error") {
      this.emit("error", new Error(String(msg["message"] ?? "TTS error")));
      return;
    }
    if (msg["event_type"] === "final" || type === "done") {
      this.emit("done");
    }
  }

  #startKeepalive(): void {
    this.#stopKeepalive();
    this.#keepalive = setInterval(() => this.#send({ type: "ping" }), KEEPALIVE_MS);
    this.#keepalive.unref();
  }

  #stopKeepalive(): void {
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;
  }

  #send(payload: Record<string, unknown>): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(payload));
  }
}
