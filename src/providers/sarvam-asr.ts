/**
 * Sarvam realtime STT client — raw WebSocket, not the SDK.
 *
 * WHY NOT THE SDK: Sarvam's own docs state that the JavaScript SDK "silently
 * drops" the `mode` parameter, so every connection runs as plain `transcribe`
 * regardless of what you ask for. Since `codemix` mode is directly relevant to a
 * Hinglish product, we speak the protocol ourselves.
 * See docs/adr/0006-asr-provider-under-free-switching.md
 *
 * ⚠ UNVERIFIED: the exact socket path, auth header name and message field names
 * below come from Sarvam's guide pages. The API-reference pages that would
 * confirm them returned 404 during research (docs/05-open-questions.md Q12).
 * Slice 0 must validate this against a live key before anything is built on it.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Config } from "../config/env.ts";
import type { AsrClient, AsrEvents, AsrTranscript } from "./asr-client.ts";

export type AsrMode = "transcribe" | "translate" | "verbatim" | "translit" | "codemix";

export type AsrOptions = {
  /** BCP-47 code, or the auto-detect token. */
  languageCode: string;
  mode?: AsrMode;
  vad?: {
    threshold?: number;
    silence_duration_ms?: number;
    min_speech_duration_ms?: number;
  };
  returnTimestamps?: boolean;
};

/**
 * Shared with the Deepgram standby — see src/providers/asr-client.ts.
 *
 * Note the asymmetry that survives into the type: the `confidence` field there is
 * NEVER populated on this path. Sarvam documents `language_probability`, a
 * detection score, and no ASR confidence anywhere (docs/05-open-questions.md Q4).
 */
export type TranscriptEvent = AsrTranscript;
export type SarvamAsrEvents = AsrEvents;

export class SarvamAsr extends EventEmitter<AsrEvents> implements AsrClient {
  readonly provider = "sarvam" as const;
  #ws: WebSocket | null = null;
  readonly #cfg: Config;
  readonly #opts: AsrOptions;

  constructor(cfg: Config, opts: AsrOptions) {
    super();
    this.#cfg = cfg;
    this.#opts = opts;
  }

  connect(): void {
    const url = new URL("/speech-to-text-realtime/ws", this.#cfg.wsBase);
    url.searchParams.set("model", this.#cfg.asrModel);
    url.searchParams.set("language_code", this.#opts.languageCode);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(this.#cfg.asrSampleRate));
    if (this.#opts.mode) url.searchParams.set("mode", this.#opts.mode);
    if (this.#opts.returnTimestamps) url.searchParams.set("return_timestamps", "true");

    const ws = new WebSocket(url, {
      // ⚠ Header name unverified — see file header.
      headers: { "api-subscription-key": this.#cfg.sarvamApiKey },
    });
    this.#ws = ws;

    ws.on("open", () => this.emit("open"));
    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("error", (err) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
    ws.on("close", (code, reason) => {
      const detail = reason.toString().trim();
      // Sarvam's guide documents 4000 as "unsupported sample rate", and the
      // first version of this handler asserted that reading. Against a live key
      // it produced a message that contradicted itself — "sample rate 16000 is
      // not accepted. Only 8000 and 16000 are supported" — because the socket
      // also closes 4000 on a rejected key, a wrong path or a bad query param,
      // and the guide is the same unverified source as the path and header
      // above. Report what the close frame actually said, plus the parameters
      // that could have caused it. docs/05-open-questions.md Q12.
      if (code === 4000) {
        this.emit(
          "error",
          new Error(
            `Sarvam closed the ASR socket with code 4000` +
              (detail ? `: ${detail}` : ` and an empty reason`) +
              ` — sent sample_rate=${this.#cfg.asrSampleRate}, model=${this.#cfg.asrModel}, ` +
              `language_code=${this.#opts.languageCode}, path=${url.pathname}`,
          ),
        );
      }
      this.emit("close", { code, reason: detail });
    });
  }

  #onMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      this.emit("error", new Error(`ASR sent non-JSON frame: ${raw.toString().slice(0, 120)}`));
      return;
    }

    // Sarvam keys these frames on `event`, not `type` — confirmed against a
    // live socket, which greets us with:
    //   {"event":"session.begin","request_id":"…","config":{…}}
    // Reading `type` matched nothing, so every ASR frame fell through to the
    // default branch and was dropped in silence: no transcripts, no VAD, no
    // errors, and a connection that looks healthy throughout. `type` is kept as
    // a fallback only because the guide claimed it and costs nothing to accept.
    //
    // The event NAMES below are still guide-sourced. `session.begin` is now
    // confirmed; the vad.* and transcript.* names need audio through a live
    // socket to verify. docs/05-open-questions.md Q12
    const type = String(msg["event"] ?? msg["type"] ?? "");
    switch (type) {
      case "session.begin":
      case "config.updated":
      case "pong":
        return;
      case "vad.speech_start":
        this.emit("speech_start");
        return;
      case "vad.speech_end":
        this.emit("speech_end");
        return;
      case "transcript.partial":
        this.emit("partial", toTranscript(msg));
        return;
      case "transcript.final":
        this.emit("final", toTranscript(msg));
        return;
      case "session.end":
        return;
      case "error":
        this.emit("error", new Error(String(msg["message"] ?? "ASR error")));
        return;
      default:
        return;
    }
  }

  /**
   * Send a raw PCM frame. Caller supplies linear16 at the configured rate.
   *
   * BINARY, not base64 in JSON. This sent `{type:"audio_input", audio:"<b64>"}`,
   * which Sarvam accepts without complaint and ignores completely: the socket
   * stays open, the session looks healthy, and no VAD or transcript event ever
   * arrives. Verified against a live socket — `audio_input`, `audio_data` and
   * `input_audio_buffer.append` all produce the same silence, while binary
   * frames transcribe immediately. A wrong guess here is invisible rather than
   * loud, which is what made it expensive. docs/05-open-questions.md Q12
   */
  sendAudio(pcm: Buffer): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(pcm, { binary: true });
  }

  /**
   * Change language mid-stream without reconnecting. This is what makes free
   * per-turn language switching possible at all.
   */
  updateLanguage(languageCode: string): void {
    this.#send({ type: "config.update", language_code: languageCode });
  }

  flush(): void {
    this.#send({ type: "flush" });
  }

  ping(): void {
    this.#send({ type: "ping" });
  }

  close(): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#send({ type: "end" });
    this.#ws?.close();
    this.#ws = null;
  }

  #send(payload: Record<string, unknown>): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(payload));
  }
}

function toTranscript(msg: Record<string, unknown>): TranscriptEvent {
  const out: TranscriptEvent = { text: String(msg["transcript"] ?? msg["text"] ?? "") };
  if (typeof msg["language"] === "string") out.language = msg["language"];
  if (typeof msg["language_probability"] === "number") {
    out.languageProbability = msg["language_probability"];
  }
  if (typeof msg["start_s"] === "number") out.startS = msg["start_s"];
  if (typeof msg["end_s"] === "number") out.endS = msg["end_s"];
  return out;
}
