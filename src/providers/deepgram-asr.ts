/**
 * Deepgram Flux — the ASR standby. Slice 8.
 *
 * SCOPE, STATED UP FRONT SO NOBODY REACHES FOR THIS BY MISTAKE: this covers
 * `hi-IN` and `en-IN` and nothing else in our set. Flux Multilingual is ten
 * languages of which exactly one is Indic
 * ([language prompting](https://developers.deepgram.com/docs/flux/language-prompting.md)).
 * Nine of our eleven speakable languages have no second ASR. See
 * src/domain/asr-failover.ts, which is where that gets decided; this file is only
 * the client.
 *
 * Deepgram's TTS is irrelevant to us — Aura-2 has no Indic voice at all
 * ([TTS models](https://developers.deepgram.com/docs/tts-models-languages-overview.md)) —
 * so this is a hearing-only standby. We can keep listening in Hindi through a
 * Sarvam ASR outage; we cannot say a word through a Sarvam TTS outage.
 *
 * WHAT THIS PATH GIVES US THAT THE DEFAULT DOES NOT: `word.confidence`
 * ([quickstart](https://developers.deepgram.com/docs/flux/quickstart.md)). The
 * low-ASR-confidence reprompt in the original architecture is implementable here
 * and nowhere else (docs/05-open-questions.md Q4).
 *
 * WHAT IT COSTS: Sarvam's `codemix` formatting, which renders Hinglish with Indic
 * words in Devanagari and English words in Latin. Flux code-switches natively at
 * the recognition level but formats to a single script. For a Hinglish product
 * that is a real, if survivable, downgrade — hence `asr_failover_active` is a
 * logged degradation and not a silent swap.
 *
 * VERIFIED AGAINST A LIVE KEY, 2026-09-01, with `npm run verify:asr`. The auth
 * header is Deepgram's standard `Authorization: Token <key>` — flagged here as
 * unverified until that run, since it was never captured in the Phase-1 research
 * tables (docs/00-provider-research.md), and now confirmed correct.
 *
 * ⚠ What the same run found instead: the frame discriminant was read one level
 * too high, and the standby had therefore never emitted a single word since the
 * day it was written. See the note on `#onMessage` and D11 in
 * docs/07-defect-register.md. Nothing on this page should be trusted because it
 * looks reasonable; run the verifier.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Config } from "../config/env.ts";
import type { AsrClient, AsrEvents, AsrTranscript } from "./asr-client.ts";

export type DeepgramAsrOptions = {
  /**
   * Bare primary subtag ("hi"), never "hi-IN". Flux biases toward the hint; with
   * no hint at all it auto-detects.
   */
  languageHint?: string | undefined;
  /** 0.5–1.0, default 0.7. Higher = waits longer before calling the turn over. */
  eotThreshold?: number | undefined;
  /** 500–60000, default 5000. */
  eotTimeoutMs?: number | undefined;
};

export class DeepgramAsr extends EventEmitter<AsrEvents> implements AsrClient {
  readonly provider = "deepgram" as const;
  #ws: WebSocket | null = null;
  readonly #cfg: Config;
  #opts: DeepgramAsrOptions;

  constructor(cfg: Config, opts: DeepgramAsrOptions = {}) {
    super();
    this.#cfg = cfg;
    this.#opts = opts;
  }

  connect(): void {
    if (!this.#cfg.deepgram.apiKey) {
      this.emit("error", new Error("DEEPGRAM_API_KEY is unset — the standby cannot connect"));
      return;
    }

    const url = new URL("/v2/listen", this.#cfg.deepgram.wsBase);
    url.searchParams.set("model", this.#cfg.deepgram.asrModel);
    url.searchParams.set("encoding", "linear16");
    // Flux accepts 8000/16000/24000/44100/48000, so our 16 kHz device rate passes
    // through unchanged and no resampling is needed on the failover path.
    url.searchParams.set("sample_rate", String(this.#cfg.audio.asrSampleRate));
    if (this.#opts.languageHint) url.searchParams.set("language_hint", this.#opts.languageHint);
    if (this.#opts.eotThreshold !== undefined) {
      url.searchParams.set("eot_threshold", String(this.#opts.eotThreshold));
    }
    if (this.#opts.eotTimeoutMs !== undefined) {
      url.searchParams.set("eot_timeout_ms", String(this.#opts.eotTimeoutMs));
    }

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.#cfg.deepgram.apiKey}` },
    });
    this.#ws = ws;

    ws.on("open", () => this.emit("open"));
    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("error", (err) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err))),
    );
    ws.on("close", (code, reason) => this.emit("close", { code, reason: reason.toString() }));
  }

  #onMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      this.emit("error", new Error("Deepgram sent a non-JSON frame"));
      return;
    }

    // ⚠ THE DISCRIMINANT IS NESTED. Flux puts the turn lifecycle one level down:
    // every turn event arrives as `{"type":"TurnInfo","event":"Update"}`, and only
    // the connection-level frames (Connected, Error) carry their name in `type`.
    //
    // Switching on `type` alone — which this file did until 2026-09-01 — sends
    // EVERY transcript to the default arm. The socket opens, audio flows, the
    // provider bills, and not one word is emitted. Verified against a live key
    // with `npm run verify:asr`; see D11 in docs/07-defect-register.md.
    const kind = String((msg["type"] === "TurnInfo" ? msg["event"] : msg["type"]) ?? "");

    switch (kind) {
      case "StartOfTurn":
        // Deepgram's own guidance: this is "more reliable than an external VAD"
        // for barge-in. It maps onto Sarvam's vad.speech_start exactly.
        this.emit("speech_start");
        return;

      case "Update":
        // ~0.25s cadence. The interim transcript, which is what the echo guard
        // correlates against our own outgoing text.
        this.emit("partial", toTranscript(msg));
        return;

      case "EagerEndOfTurn":
        // A speculative end-of-turn, retractable by TurnResumed. We deliberately
        // do NOT dispatch the LLM on it: a retracted dispatch on the standby path
        // means paying rate limit for a turn that did not happen, and the standby
        // is already the degraded path. Treated as one more partial.
        this.emit("partial", toTranscript(msg));
        return;

      case "TurnResumed":
        // The eager guess was wrong. Nothing to undo, precisely because we did
        // not act on it.
        return;

      case "EndOfTurn": {
        const t = toTranscript(msg);
        this.emit("speech_end");
        if (t.text.trim() !== "") this.emit("final", t);
        return;
      }

      case "Error":
        this.emit(
          "error",
          new Error(String(msg["description"] ?? msg["message"] ?? "Deepgram error")),
        );
        return;

      default:
        // Connected / Metadata / anything added later. Ignoring unknown frames
        // beats crashing a session that is already running degraded.
        return;
    }
  }

  /** Raw binary frames — Deepgram does not wrap audio in JSON the way Sarvam does. */
  sendAudio(pcm: Buffer): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(pcm, { binary: true });
  }

  /** Hints are updatable mid-stream, so a language switch needs no reconnect. */
  updateLanguage(languageCode: string): void {
    const hint = languageCode.split("-")[0]!;
    this.#opts = { ...this.#opts, languageHint: hint };
    this.#send({ type: "Configure", language_hint: hint });
  }

  /** Flux's manual end-of-turn. Its `trigger` field will read "manual". */
  flush(): void {
    this.#send({ type: "ForceEndTurn" });
  }

  close(): void {
    this.#ws?.close();
    this.#ws = null;
  }

  #send(payload: Record<string, unknown>): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(payload));
  }
}

function toTranscript(msg: Record<string, unknown>): AsrTranscript {
  const out: AsrTranscript = { text: String(msg["transcript"] ?? "") };

  // `languages`, plural and an array — Flux lists every language it heard in the
  // window, dominant first. There is no singular `language` field on this
  // endpoint, so the previous read resolved to undefined on every frame and the
  // standby never reported a language at all.
  const langs = msg["languages"];
  if (Array.isArray(langs) && typeof langs[0] === "string") out.language = langs[0];

  // The field Sarvam does not have. Mean word confidence stands in for an
  // utterance score; absent means absent, never a default of 1.0 — a fabricated
  // confidence would make the reprompt rule silently never fire.
  const words = msg["words"];
  if (Array.isArray(words) && words.length > 0) {
    const scores = words
      .map((w) => (w as { confidence?: unknown }).confidence)
      .filter((c): c is number => typeof c === "number");
    if (scores.length > 0) {
      out.confidence = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    const first = words[0] as { start?: unknown };
    const last = words[words.length - 1] as { end?: unknown };
    if (typeof first.start === "number") out.startS = first.start;
    if (typeof last.end === "number") out.endS = last.end;
  }

  return out;
}
