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
import { BufferedMemWriteStream } from "./memory/buffered-stream.ts";
import { InMemoryLongTermStore } from "./memory/in-memory-long-term-store.ts";
import { HashingEmbedder } from "./memory/long-term-store.ts";
import { LlmDistiller } from "./memory/distiller.ts";
import { MemoryWorker } from "./memory/worker.ts";
import { SarvamLlm } from "./providers/sarvam-llm.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { pendingCopyReview } from "./copy/fillers.ts";
import { GuardedSessionStore } from "./store/guarded-store.ts";
import { HoldingAudio } from "./audio/holding-audio.ts";
import { redundancyProfile } from "./domain/asr-failover.ts";

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

  // Behind a circuit breaker so a Redis outage costs one round trip, not one per
  // call per turn. The degraded path was always specified; the breaker is what
  // makes it arrive on time. See src/store/guarded-store.ts
  const store: SessionStore = new GuardedSessionStore(
    cfg.redisUrl ? new RedisSessionStore(cfg.redisUrl) : new MemorySessionStore(),
    { log },
  );

  if (!cfg.redisUrl) {
    log("warn", "no REDIS_URL — using in-process working memory", {
      note: "sessions will not survive a restart and cannot be shared across replicas",
    });
  }

  // Long-term memory. In-process by default; ADR 0004 (Postgres + pgvector) is
  // still Proposed, so the durable backend is deliberately not wired yet.
  //
  // The buffer resolves the decision docs/02 section 6 left open: bounded, drops
  // the oldest low-priority event on overflow, and counts every drop.
  const memStream = new BufferedMemWriteStream(new InMemoryMemWriteStream(), {
    capacity: cfg.memWriteBufferCapacity,
    log,
    onStateChange: (buffering) =>
      log(buffering ? "warn" : "info", "mem:writes buffering", { buffering }),
  });
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

  // The apology for a Bulbul outage, rendered ahead of time — the one message
  // that cannot be synthesised, because synthesis is what broke.
  const holdingAudio = new HoldingAudio({
    dir: cfg.holdingAudioDir,
    expectedSampleRate: cfg.ttsSampleRate,
    log,
  });
  holdingAudio.load();

  // State the availability profile at boot rather than during an incident.
  const redundancy = redundancyProfile(SPEAKABLE.map((l) => l.code));
  log(cfg.asrFailoverEnabled ? "info" : "warn", "asr failover", {
    enabled: cfg.asrFailoverEnabled,
    key_present: cfg.deepgramApiKey !== null,
    redundant_languages: redundancy.redundant,
    single_vendor_languages: redundancy.singleVendor.length,
    tts_failover: "none, for any language — docs/adr/0005-tts-provider-split.md",
    residency: cfg.asrFailoverEnabled
      ? "ENABLED: a failover sends audio to Deepgram, which publishes no India region"
      : "disabled by default; enabling relocates audio out of India (docs/05 Q14)",
  });

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
          holdingAudio,
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
      // One last drain attempt. A buffered backlog dies with the process — that
      // is what "bounded in-process buffer" means, and it is stated plainly in
      // docs/adr/0008-degradation-policy.md rather than discovered.
      void memStream.close().catch(() => {});
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
