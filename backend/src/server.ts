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
 *                                { type: "play_media", source, ... } -- start music
 *                                { type: "stop_media" }              -- stop it
 *
 * MEDIA IS NOT SPEECH, and does not travel as PCM. `play_media` carries a
 * `source` of "radio" (with `urls`, best first — stations rot, so the device
 * tries the next) or "youtube" (with `video_id`). The DEVICE fetches and plays
 * it; the server never touches those bytes. Same reason `clear_audio` exists:
 * buffered audio lives on the device. A four-minute track is that rule at its
 * most extreme — streaming it server-side would put ~11 MB of PCM per song on
 * this socket alongside TTS. See src/tools/music.ts.
 *
 * `clear_audio` is the barge-in signal. The server decides; the device executes.
 * Buffered audio lives on the device, so only the device can actually drop it.
 * See docs/adr/0007-audio-front-end.md
 */

import { WebSocketServer, type WebSocket } from "ws";

import { loadConfig } from "@sp-i/shared/config/env.ts";
import { assertMatrixIntegrity, SPEAKABLE } from "@sp-i/ai/domain/languages.ts";
import { redundancyProfile } from "@sp-i/ai/domain/asr-failover.ts";
import { pendingNativeReview } from "@sp-i/ai/copy/refusals.ts";
import { pendingCopyReview } from "@sp-i/ai/copy/fillers.ts";
import { Session } from "@sp-i/ai/orchestrator/session.ts";
import { HoldingAudio } from "@sp-i/ai/audio/holding-audio.ts";
import { buildMemory } from "./composition/memory.ts";
import { externalSummary, registerCapabilities } from "./composition/tools.ts";

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}
`);
}

export type ServerHandle = {
  wss: WebSocketServer;
  /** Stops the memory worker too — otherwise it keeps the process alive. */
  shutdown(): void;
};

/**
 * Boot order, and it is an order rather than a list.
 *
 * The matrix check comes first because a typo there is the one failure this
 * whole subsystem exists to prevent, and it is cheaper to find before anything
 * has opened a socket. Config next, since every builder below takes it. Then
 * memory, then the capabilities — one loop over `ai/src/capabilities`, each
 * reporting what it registered rather than leaving server.ts to recompute it
 * from config.
 *
 * This function was 500 lines of the same sequence written inline. The steps
 * have not changed; they are just nameable now, and reachable from a test
 * without a WebSocket server.
 */
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

  const { store, memStream, longTerm, worker } = buildMemory(cfg, log);

  // One loop over ai/src/capabilities. This used to be three calls into three
  // differently-shaped composition modules, and the log below recomputed what
  // they had done from six config flags — so it could disagree with what was
  // actually registered. Each capability reports its own line now.
  const capabilities = registerCapabilities(cfg, log);
  const { tools } = capabilities;

  log("info", "tools registered", {
    count: tools.all().length,
    names: tools.all().map((t) => t.name),
    external: externalSummary(capabilities.reports, { weatherEnabled: cfg.weather.enabled }),
    note: "sarvam-105b tool-calling verified 2026-08-29 — npm run verify:tools",
  });

  // The apology for a Bulbul outage, rendered ahead of time — the one message
  // that cannot be synthesised, because synthesis is what broke.
  const holdingAudio = new HoldingAudio({
    dir: cfg.holdingAudioDir,
    expectedSampleRate: cfg.audio.ttsSampleRate,
    log,
  });
  holdingAudio.load();

  // State the availability profile at boot rather than during an incident.
  const redundancy = redundancyProfile(SPEAKABLE.map((l) => l.code));
  log(cfg.asrFailover.enabled ? "info" : "warn", "asr failover", {
    enabled: cfg.asrFailover.enabled,
    key_present: cfg.deepgram.apiKey !== null,
    redundant_languages: redundancy.redundant,
    single_vendor_languages: redundancy.singleVendor.length,
    tts_failover: "none, for any language — docs/adr/0005-tts-provider-split.md",
    residency: cfg.asrFailover.enabled
      ? "ENABLED: a failover sends audio to Deepgram, which publishes no India region"
      : "disabled by default; enabling relocates audio out of India (docs/05 Q14)",
  });

  const wss = new WebSocketServer({ port: cfg.port });
  log("info", "listening", {
    port: cfg.port,
    speakable: SPEAKABLE.length,
    asrRate: cfg.audio.asrSampleRate,
    ttsRate: cfg.audio.ttsSampleRate,
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

      // Playback finished on the device. The session gates listening on a media
      // flag, so a track that ends without reporting it leaves the user unheard.
      if (msg["type"] === "media_ended") {
        session?.mediaEnded();
        return;
      }

      if (msg["type"] === "hello" && session === null) {
        session = new Session({
          cfg,
          store,
          memStream,
          tools,
          longTerm,
          holdingAudio,
          // Absent when unconfigured, which leaves the alarm path inert rather
          // than half-working. See the boot log above.
          ...capabilities.contributions,
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
      // Capability-owned timers — the radio catalogue refresh is the only one
      // today. Unreferenced, so it never held the process open, but a test that
      // starts two servers would otherwise leave the first one's interval live.
      capabilities.dispose();
      // One last drain attempt. A buffered backlog dies with the process — that
      // is what "bounded in-process buffer" means, and it is stated plainly in
      // docs/adr/0008-degradation-policy.md rather than discovered.
      void memStream.close().catch(() => {});
      // Redis holds live sockets, and closing the WSS does not touch them. Without
      // this the event loop never empties: `REDIS_URL=… npm test` hangs on
      // server.test.ts until the runner kills it, and the direct-run path below
      // only escapes because it force-exits on a timer.
      void store.close().catch(() => {});
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
