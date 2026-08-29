/**
 * Device-facing WebSocket server.
 *
 * Protocol (device <-> server):
 *   device -> server   binary  : linear16 PCM @ ASR_SAMPLE_RATE, mono
 *   device -> server   json    : { type: "hello", uid, locale_hint? }
 *   server -> device   binary  : linear16 PCM @ TTS_SAMPLE_RATE, mono
 *   server -> device   json    : { type: "clear_audio" }        -- flush playback NOW
 *                                { type: "ready", sid }
 *                                { type: "session_closed", reason }
 *
 * `clear_audio` is the barge-in signal. The server decides; the device executes.
 * Buffered audio lives on the device, so only the device can actually drop it.
 * See docs/adr/0007-audio-front-end.md
 */

import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config/env.ts";
import { assertMatrixIntegrity, SPEAKABLE } from "./domain/languages.ts";
import { pendingNativeReview } from "./copy/refusals.ts";
import { Session } from "./orchestrator/session.ts";
import { MemorySessionStore } from "./store/memory-store.ts";
import { RedisSessionStore } from "./store/redis-store.ts";
import type { SessionStore } from "./store/session-store.ts";

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export function start(): WebSocketServer {
  // Fail fast on a malformed matrix. A typo here becomes a user hearing nothing,
  // which is the one failure this whole subsystem exists to prevent.
  assertMatrixIntegrity();

  const cfg = loadConfig();

  const pending = pendingNativeReview();
  if (pending.length > 0) {
    log("warn", "refusal copy pending native review — do not ship to users", {
      count: pending.length,
      languages: [...new Set(pending.map((p) => p.language))],
    });
  }

  const store: SessionStore = cfg.redisUrl
    ? new RedisSessionStore(cfg.redisUrl)
    : new MemorySessionStore();

  if (!cfg.redisUrl) {
    log("warn", "no REDIS_URL — using in-process working memory", {
      note: "sessions will not survive a restart and cannot be shared across replicas",
    });
  }

  const wss = new WebSocketServer({ port: cfg.port });
  log("info", "listening", {
    port: cfg.port,
    speakable: SPEAKABLE.length,
    asrRate: cfg.asrSampleRate,
    ttsRate: cfg.ttsSampleRate,
    store: cfg.redisUrl ? "redis" : "memory",
  });

  wss.on("connection", (ws: WebSocket) => {
    let session: Session | null = null;

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session?.pushAudio(data);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log("warn", "device sent non-JSON control frame");
        return;
      }

      if (msg["type"] === "hello" && session === null) {
        session = new Session({
          cfg,
          store,
          uid: String(msg["uid"] ?? "anonymous"),
          // A device reconnecting with its previous sid resumes that thread,
          // provided the idle window has not lapsed.
          sid: typeof msg["sid"] === "string" ? msg["sid"] : undefined,
          localeHint: typeof msg["locale_hint"] === "string" ? msg["locale_hint"] : undefined,
          log,
          device: {
            sendAudio: (pcm) => {
              if (ws.readyState === ws.OPEN) ws.send(pcm, { binary: true });
            },
            sendControl: (m) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
            },
            close: () => ws.close(),
          },
        });
        ws.send(JSON.stringify({ type: "ready", sid: session.sid }));
        void session.start();
      }
    });

    ws.on("close", () => session?.close("device_disconnected"));
    ws.on("error", (err) => log("error", "device socket", { err: err.message }));
  });

  return wss;
}

// Only auto-run when executed directly, so tests can drive start() themselves.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const wss = start();
  const shutdown = () => {
    log("info", "shutting down");
    wss.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
