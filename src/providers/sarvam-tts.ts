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
 * ─────────────────────────────────────────────────────────────────────────────
 * SLICE 8 — RECONNECT, AND THE THING THAT IS EASY TO GET WRONG.
 *
 * An idle close is EXPECTED, not an incident: the keepalive misses one beat while
 * the user is quiet and the socket goes. Reconnecting transparently before the
 * next chunk is the whole answer, and that part is routine.
 *
 * The part that is not routine: **queued speech goes stale.** The obvious
 * implementation buffers whatever could not be sent and replays it on reconnect.
 * In a live conversation that produces a bot which is silent for eight seconds
 * and then delivers an answer to a question the user has already given up on and
 * moved past. So the queue has an age limit, and text older than it is DROPPED
 * rather than spoken late. Silence that the orchestrator can see and apologise
 * for beats a monologue arriving out of time.
 *
 * When reconnect exhausts its budget the client emits `unavailable`, which is the
 * accepted single point of failure becoming real. The session answers that with
 * pre-rendered audio and a graceful close (src/audio/holding-audio.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ UNVERIFIED: socket path, auth header and message field names — see
 * sarvam-asr.ts header and docs/05-open-questions.md Q12.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Config } from "../config/env.ts";
import { SOCKET_RECONNECT, delayFor, type BackoffPolicy } from "../domain/backoff.ts";
import type { TtsClient, TtsEvents, TtsOptions } from "./tts-client.ts";

// The surface the orchestrator holds lives on the interface now
// (./tts-client.ts), so `Session` can be built against a fake. Re-exported here
// so every existing importer keeps its current import line.
export type { TtsClient, TtsEvents, TtsOptions } from "./tts-client.ts";

/** Sarvam's documented idle close is ~60s; ping well inside it. */
const KEEPALIVE_MS = 25_000;
const MAX_TEXT_CHARS = 2500;

/**
 * Text queued while the socket is down is dropped past this age. A reply spoken
 * three seconds late still lands in the conversation; one spoken ten seconds late
 * answers a question nobody is still asking.
 */
const QUEUE_MAX_AGE_MS = 3000;
/** Belt and braces on the age limit, for a pathological burst. */
const QUEUE_MAX_ITEMS = 24;

/** @deprecated Use `TtsEvents`. Kept so older imports keep resolving. */
export type SarvamTtsEvents = TtsEvents;

export class SarvamTts extends EventEmitter<TtsEvents> implements TtsClient {
  #ws: WebSocket | null = null;
  #keepalive: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #configured = false;
  #intentionallyClosed = false;
  #attempt = 0;
  #queue: Array<{ text: string; at: number }> = [];
  readonly #cfg: Config;
  readonly #policy: BackoffPolicy;
  #opts: TtsOptions;

  constructor(cfg: Config, opts: TtsOptions, policy: BackoffPolicy = SOCKET_RECONNECT) {
    super();
    this.#cfg = cfg;
    this.#opts = opts;
    this.#policy = policy;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.#intentionallyClosed = false;
    const url = new URL("/text-to-speech/ws", this.#cfg.sarvam.wsBase);
    url.searchParams.set("model", this.#cfg.sarvam.ttsModel);

    const ws = new WebSocket(url, {
      headers: { "api-subscription-key": this.#cfg.sarvam.apiKey },
    });
    this.#ws = ws;

    ws.on("open", () => {
      this.#attempt = 0;
      this.#sendConfig();
      this.#startKeepalive();
      this.#drainQueue();
      this.emit("open");
    });
    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("error", (err) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
    ws.on("close", (code, reason) => {
      this.#stopKeepalive();
      this.#configured = false;
      this.emit("close", { code, reason: reason.toString() });
      if (!this.#intentionallyClosed) this.#scheduleReconnect(code);
    });
  }

  /**
   * Reconnect on backoff. Note the budget is checked against attempts here rather
   * than wall clock: an idle close during a long pause has no user waiting on it,
   * so the only thing bounding retries is whether Sarvam is actually reachable.
   */
  #scheduleReconnect(closeCode: number): void {
    if (this.#reconnectTimer) return;

    if (this.#attempt >= this.#policy.maxAttempts) {
      this.emit(
        "unavailable",
        new Error(
          `Bulbul unreachable after ${this.#attempt} reconnect attempts (last close ${closeCode}). ` +
            `There is no TTS failover for any Indic language — see docs/adr/0005-tts-provider-split.md`,
        ),
      );
      return;
    }

    const delayMs = delayFor(this.#attempt, this.#policy);
    this.#attempt += 1;
    this.emit("reconnecting", { attempt: this.#attempt, delayMs });

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#intentionallyClosed) this.connect();
    }, delayMs);
    this.#reconnectTimer.unref?.();
  }

  #sendConfig(): void {
    // Every frame on this socket is {type, data:{…}}. The flat version this
    // sent first was rejected against a live key with
    //   422 "Input parameters has to be a valid dictionary"
    // on every connect, so the socket opened, configured, failed and reconnected
    // in a loop without ever synthesising a word. Nesting the payload under
    // `data` gets through to field validation.
    //
    // `target_language_code`, not `language_code` — the nested frame is accepted
    // with the former. docs/05-open-questions.md Q12
    this.#send({
      type: "config",
      data: {
        speaker: this.#opts.speaker,
        target_language_code: this.#opts.languageCode,
        pace: this.#opts.pace ?? this.#cfg.audio.ttsPace,
        output_audio_codec: "linear16",
        // Bulbul streaming is capped at 24 kHz; env validation enforces this.
        sample_rate: this.#cfg.audio.ttsSampleRate,
        send_completion_event: true,
      },
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
    if (this.connected) this.#sendConfig();
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

    if (!this.connected) {
      this.#enqueue(trimmed);
      return;
    }
    if (!this.#configured) this.#sendConfig();
    this.#send({ type: "text", data: { text: trimmed } });
  }

  /** Force synthesis of whatever is buffered, ignoring min_buffer_size. */
  flush(): void {
    this.#send({ type: "flush" });
  }

  close(): void {
    this.#intentionallyClosed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopKeepalive();
    this.#queue = [];
    this.#ws?.close();
    this.#ws = null;
  }

  /** Abandon queued speech — barge-in, or a turn the orchestrator gave up on. */
  clearQueue(): void {
    this.#queue = [];
  }

  #enqueue(text: string): void {
    this.#queue.push({ text, at: Date.now() });
    if (this.#queue.length > QUEUE_MAX_ITEMS) {
      const dropped = this.#queue.shift();
      if (dropped) this.emit("dropped", { chars: dropped.text.length, ageMs: 0 });
    }
  }

  /**
   * Replay what is still fresh; discard what is not.
   *
   * The drop is the interesting half. Speaking stale text is the failure this
   * whole queue exists to avoid, so it is emitted as an event rather than
   * swallowed — the orchestrator needs to know the reply it composed was never
   * actually heard.
   */
  #drainQueue(): void {
    if (this.#queue.length === 0) return;
    const now = Date.now();
    const pending = this.#queue;
    this.#queue = [];

    let spoke = false;
    for (const item of pending) {
      const ageMs = now - item.at;
      if (ageMs > QUEUE_MAX_AGE_MS) {
        this.emit("dropped", { chars: item.text.length, ageMs });
        continue;
      }
      this.#send({ type: "text", data: { text: item.text } });
      spoke = true;
    }
    if (spoke) this.flush();
  }

  #onMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      this.emit("error", new Error("TTS sent non-JSON frame"));
      return;
    }

    // Bulbul wraps every frame's payload in `data`:
    //   {"type":"error","data":{"request_id":"…","message":"…","code":422}}
    // The original code read these fields at the top level, where they are not.
    // `data` was even consulted for the audio payload — as if it were the base64
    // string rather than the object containing it — so a correct audio frame
    // would have been dropped too. Look inside `data` first, and keep the flat
    // reads as a fallback. docs/05-open-questions.md Q12
    const type = String(msg["type"] ?? "");
    const data =
      typeof msg["data"] === "object" && msg["data"] !== null
        ? (msg["data"] as Record<string, unknown>)
        : {};

    if (type === "audio" || data["audio"] !== undefined || typeof msg["audio"] === "string") {
      const b64 = data["audio"] ?? msg["audio"];
      if (typeof b64 === "string") this.emit("audio", Buffer.from(b64, "base64"));
      return;
    }
    if (type === "error") {
      const detail = data["message"] ?? msg["message"] ?? data["error"] ?? msg["error"];
      const code = data["code"] ?? msg["code"];
      this.emit(
        "error",
        new Error(
          typeof detail === "string" && detail.trim() !== ""
            ? `${detail}${code !== undefined ? ` (code ${String(code)})` : ""}`
            : `TTS error frame with no recognised message field: ${raw.toString().slice(0, 300)}`,
        ),
      );
      return;
    }
    if (data["event_type"] === "final" || msg["event_type"] === "final" || type === "done") {
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
