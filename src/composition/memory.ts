/**
 * The memory stack: session store, the mem:writes stream, long-term storage,
 * and the worker that drains one into the other.
 *
 * Extracted from src/server.ts, where it was the first ~70 lines of a 500-line
 * start(). It is a function rather than inline code so the boot sequence reads
 * as a table of contents, and so the degraded shapes here — no Redis, no care
 * signals — can be reached in a test without opening a WebSocket server.
 */

import type { Config } from "../config/env.ts";
import { MemorySessionStore } from "../store/memory-store.ts";
import { RedisSessionStore } from "../store/redis-store.ts";
import { GuardedSessionStore } from "../store/guarded-store.ts";
import type { SessionStore } from "../store/session-store.ts";
import { InMemoryMemWriteStream } from "../memory/stream.ts";
import { BufferedMemWriteStream } from "../memory/buffered-stream.ts";
import { InMemoryLongTermStore } from "../memory/in-memory-long-term-store.ts";
import { HashingEmbedder, type LongTermStore } from "../memory/long-term-store.ts";
import { LlmDistiller } from "../memory/distiller.ts";
import { MemoryWorker } from "../memory/worker.ts";
import {
  createCareSignalsAnalyser,
  type SignalsAnalyser,
} from "../memory/care-signals-analyser.ts";
import { SarvamLlm } from "../providers/sarvam-llm.ts";
import { DeepgramRead } from "../providers/deepgram-read.ts";
import type { Log } from "./types.ts";

export type MemoryStack = {
  store: SessionStore;
  memStream: BufferedMemWriteStream;
  longTerm: LongTermStore;
  worker: MemoryWorker;
};

export function buildMemory(cfg: Config, log: Log): MemoryStack {
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
  //
  // NOTE the asymmetry with `store` above, which DOES switch on cfg.redisUrl:
  // the stream is in-process even when Redis is available, so `mem:writes` does
  // not survive a restart and cannot be shared across replicas. That contradicts
  // docs/02 section 3, which specifies it as a Redis Stream.
  // `RedisMemWriteStream` implements that spec and is ready; swapping it in here
  // is the whole change. Left unwired deliberately — see the note on the class.
  const memStream = new BufferedMemWriteStream(new InMemoryMemWriteStream(), {
    capacity: cfg.memWriteBufferCapacity,
    log,
    onStateChange: (buffering) =>
      log(buffering ? "warn" : "info", "mem:writes buffering", { buffering }),
  });
  const longTerm = new InMemoryLongTermStore(new HashingEmbedder());

  // Retrospective wellbeing analysis of closed sessions (ADR 0009). Wired into
  // the WORKER and nowhere else: nothing on the voice path calls Deepgram for
  // this, on any turn. Off unless the deployment turned it on — see the config
  // block in src/config/env.ts for the three reasons why that is the default.
  let signals: SignalsAnalyser | null = null;
  if (cfg.careSignalsEnabled) {
    signals = createCareSignalsAnalyser(new DeepgramRead(cfg), {
      deadlineMs: cfg.careSignalsDeadlineMs,
      intentConfidence: cfg.careSignalsIntentConfidence,
      log,
    });
    log("warn", "care signals ON — English sessions are sent to Deepgram after close", {
      endpoint: `${cfg.deepgramReadBase}/v1/read`,
      note: "transcripts leave India; ten of eleven languages are never analysed",
      intent_confidence_floor: cfg.careSignalsIntentConfidence,
      unverified: "field names reconstructed from docs — run npm run verify:care",
    });
  }

  const worker = new MemoryWorker({
    stream: memStream,
    longTerm,
    sessions: store,
    distiller: new LlmDistiller(new SarvamLlm(cfg)),
    ...(signals ? { signals } : {}),
    options: { log, blockMs: 1000 },
  });
  void worker.start();

  log("warn", "long-term memory is in-process and NOT durable", {
    note: "facts and episodes are lost on restart; see docs/adr/0004-vector-store.md",
    embedder: "HashingEmbedder (lexical only — no cross-lingual matching)",
  });

  return { store, memStream, longTerm, worker };
}
