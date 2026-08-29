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
import { InMemoryMemWriteStream } from "./memory/stream.ts";
import { InMemoryLongTermStore } from "./memory/in-memory-long-term-store.ts";
import { HashingEmbedder } from "./memory/long-term-store.ts";
import { LlmDistiller } from "./memory/distiller.ts";
import { MemoryWorker } from "./memory/worker.ts";
import { SarvamLlm } from "./providers/sarvam-llm.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { pendingCopyReview } from "./copy/fillers.ts";

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export type ServerHandle = {
  wss: WebSocketServer;
  /** Stops the memory worker too — otherwise it keeps the process alive. */
  shutdown(): void;
};

export function start(): ServerHandle {
  // Fail fast on a malformed matrix. A typo here becomes a user hearing nothing,
  // which is the one failure this whole subsystem exists to prevent.
  assertMatrixIntegrity();

  const cfg = loadConfig();

  const pending = [
    ...pendingNativeReview().map((p) => p.language),
    ...pendingCopyReview().map((p) => p.language),
  ];
  if (pending.length > 0) {
    log("warn", "spoken copy pending native review — do not ship to users", {
      entries: pending.length,
      languages: [...new Set(pending)],
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

  // Long-term memory. In-process by default; ADR 0004 (Postgres + pgvector) is
  // still Proposed, so the durable backend is deliberately not wired yet.
  const memStream = new InMemoryMemWriteStream();
  const longTerm = new InMemoryLongTermStore(new HashingEmbedder());
  const worker = new MemoryWorker({
    stream: memStream,
    longTerm,
    sessions: store,
    distiller: new LlmDistiller(new SarvamLlm(cfg)),
    options: { log, blockMs: 1000 },
  });
  void worker.start();

  log("warn", "long-term memory is in-process and NOT durable", {
    note: "facts and episodes are lost on restart; see docs/adr/0004-vector-store.md",
    embedder: "HashingEmbedder (lexical only — no cross-lingual matching)",
  });

  // Tools are deployment-specific. Register them here; entitlement filtering and
  // deadlines are handled by the registry and executor. An empty registry means
  // the model is simply offered no tools.
  const tools = new ToolRegistry();

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
          memStream,
          tools,
          // fetchContext: wire your backend here. Without it, entitlement-gated
          // tools are withheld rather than offered unverified.
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

  return {
    wss,
    shutdown() {
      worker.stop();
      wss.close();
    },
  };
}

// Only auto-run when executed directly, so tests can drive start() themselves.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const handle = start();
  const shutdown = () => {
    log("info", "shutting down");
    handle.shutdown();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
