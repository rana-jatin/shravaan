/**
 * Shared test doubles.
 *
 * Not a `*.test.ts` file on purpose: `npm test` globs that pattern, and
 * importing one test file from another would register its suites twice.
 *
 * The provider fakes below are what make `Session` constructible without a
 * network. Everything here is push-driven and synchronous: a test emits an ASR
 * transcript, the session runs a turn against a scripted LLM, and the words it
 * chose to say land in an array. No sockets, no credentials, no real clocks.
 */

import { EventEmitter } from "node:events";
import { loadConfig, type Config } from "../src/config/env.ts";
import type { AsrClient, AsrEvents } from "../src/providers/asr-client.ts";
import type { AsrProviderName } from "../src/domain/asr-failover.ts";
import type { AsrSpec } from "../src/providers/factories.ts";
import type {
  ChatMessage,
  LlmClient,
  StreamChunk,
  StreamOptions,
} from "../src/providers/llm-client.ts";
import type { TtsClient, TtsEvents, TtsOptions } from "../src/providers/tts-client.ts";
import { Session, type DeviceLink, type SessionDeps } from "../src/orchestrator/session.ts";
import type { SessionToolHost, ToolDefinition } from "../src/tools/types.ts";

/** A SessionToolHost that records rather than acts. */
export function fakeHost(over: Partial<SessionToolHost> = {}): SessionToolHost {
  return {
    lastAgentReply: () => null,
    requestLanguage: (code) => ({ switched: true, language: code }),
    pace: () => 1.0,
    setPace: (p) => p,
    requestEnd: () => {},
    rememberFact: () => {},
    forgetFacts: async () => ({ forgotten: 0, texts: [] }),
    recallFacts: async () => [],
    recentMood: async () => null,
    timezone: () => "Asia/Kolkata",
    playMedia: () => {},
    stopMedia: () => {},
    ...over,
  };
}

/** An invocation context for calling a tool handler directly. */
export function invocation(
  over: Partial<Parameters<NonNullable<ToolDefinition["handler"]>>[1]> = {},
) {
  return {
    uid: "u1",
    sid: "s1",
    language: "hi-IN",
    jsonContext: null,
    signal: new AbortController().signal,
    host: fakeHost(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * A real `Config`, built hermetically.
 *
 * `loadConfig()` rather than a hand-written literal so the shape cannot drift
 * from what the session actually reads — and with the environment swapped out
 * for the duration of the call, so a developer who happens to have
 * `ASR_FAILOVER_ENABLED` or a real API key exported does not get a different
 * test run from CI. Every value is the documented default unless a test says
 * otherwise.
 */
export function testConfig(over: Partial<Config> = {}): Config {
  const saved = process.env;
  try {
    process.env = { SARVAM_API_KEY: "test-key-never-used-no-sockets-are-opened" };
    return { ...loadConfig(), ...over };
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// Provider fakes
// ---------------------------------------------------------------------------

/**
 * An ASR client that records what it was told and emits what a test tells it to.
 *
 * Carries the `spec` it was built from, because which provider a socket is
 * standing in for is load-bearing: the failover ladder relocates a user's audio
 * out of India, and the standby is the only one that needs telling about a
 * language switch.
 */
export class FakeAsr extends EventEmitter<AsrEvents> implements AsrClient {
  readonly provider: AsrProviderName;
  readonly spec: AsrSpec;
  readonly sent: Buffer[] = [];
  readonly languageUpdates: string[] = [];
  connects = 0;
  flushes = 0;
  closes = 0;

  constructor(spec: AsrSpec) {
    super();
    this.spec = spec;
    this.provider = spec.provider;
  }

  connect(): void {
    this.connects += 1;
  }
  sendAudio(pcm: Buffer): void {
    this.sent.push(pcm);
  }
  updateLanguage(languageCode: string): void {
    this.languageUpdates.push(languageCode);
  }
  flush(): void {
    this.flushes += 1;
  }
  close(): void {
    this.closes += 1;
  }

  // --- drive it --------------------------------------------------------------
  open(): void {
    this.emit("open");
  }
  speechStart(): void {
    this.emit("speech_start");
  }
  partial(text: string): void {
    this.emit("partial", { text });
  }
  final(text: string, language?: string, languageProbability?: number): void {
    this.emit("final", {
      text,
      ...(language !== undefined ? { language } : {}),
      ...(languageProbability !== undefined ? { languageProbability } : {}),
    });
  }
  /**
   * A whole utterance the way a real provider delivers one: the VAD trigger
   * first, then the transcript.
   *
   * Use this wherever the turn PHASE matters. A bare `final()` leaves the state
   * machine in `listening`, where `speech_end` is not a legal event — so the
   * turn never reaches `speaking` and `agent_speaking` stays false. That is the
   * machine working as specified, not a defect, but it makes a bare final a
   * misleading way to open a turn.
   */
  utterance(text: string, language?: string, languageProbability?: number): void {
    this.speechStart();
    this.final(text, language, languageProbability);
  }
  /** The socket died. `stable` decides whether it counts as a fresh incident. */
  dropSocket(code = 1006, reason = "test"): void {
    this.emit("close", { code, reason });
  }
}

/**
 * A TTS client that collects the words instead of synthesising them.
 *
 * `speak()` does NOT emit audio on its own. Arming the echo guard is a separate
 * act here on purpose — the guard's window opens when sound leaves for the
 * device, not when text is queued, and conflating the two would hide exactly the
 * ordering the barge-in tests are checking.
 */
export class FakeTts extends EventEmitter<TtsEvents> implements TtsClient {
  readonly opts: TtsOptions;
  readonly spoken: string[] = [];
  readonly reconfigures: Array<Partial<TtsOptions>> = [];
  connects = 0;
  flushes = 0;
  cleared = 0;
  closes = 0;

  constructor(opts: TtsOptions) {
    super();
    this.opts = opts;
  }

  connect(): void {
    this.connects += 1;
  }
  speak(text: string): void {
    const trimmed = text.trim();
    if (trimmed !== "") this.spoken.push(trimmed);
  }
  flush(): void {
    this.flushes += 1;
  }
  reconfigure(opts: Partial<TtsOptions>): void {
    this.reconfigures.push(opts);
  }
  clearQueue(): void {
    this.cleared += 1;
  }
  close(): void {
    this.closes += 1;
  }

  /** Everything said since the last call, as one string. */
  said(): string {
    return this.spoken.join(" ");
  }

  // --- drive it --------------------------------------------------------------
  emitAudio(bytes = 4): void {
    this.emit("audio", Buffer.alloc(bytes, 1));
  }
  /** Bulbul signalled the utterance is complete. NOTE: synthesis, not playback. */
  emitDone(): void {
    this.emit("done");
  }
  emitUnavailable(err = new Error("bulbul unreachable")): void {
    this.emit("unavailable", err);
  }
  emitDropped(chars = 40, ageMs = 5000): void {
    this.emit("dropped", { chars, ageMs });
  }
}

/** One LLM round: the chunks to yield, or the failure to raise. */
export type LlmStep = StreamChunk[] | Error;

/** Sugar for the common case — a round that is nothing but prose. */
export function says(...text: string[]): StreamChunk[] {
  return text.map((t) => ({ type: "text", text: t }));
}

/** Sugar for a round that calls one tool. */
export function callsTool(
  name: string,
  args: Record<string, unknown> = {},
  id = `call-${name}`,
): StreamChunk[] {
  return [{ type: "tool_call", id, name, args }];
}

/**
 * A scripted LLM.
 *
 * One step per `stream()` call, which is one per tool round AND one per retry —
 * an `Error` step is raised on the first pull, exactly where the real client
 * surfaces a 429, so it reaches `withBackoff` the same way. Past the end of the
 * script the stream is empty, which ends the turn rather than looping.
 */
export class FakeLlm implements LlmClient {
  readonly script: LlmStep[];
  readonly calls: Array<{ messages: ChatMessage[]; opts: StreamOptions }> = [];
  /**
   * Called before each chunk is yielded. The seam a test needs to interrupt a
   * reply mid-sentence: it runs inside the generator, so a barge-in raised here
   * lands between two chunks the way a real one does.
   */
  beforeChunk: ((index: number, chunk: StreamChunk) => void | Promise<void>) | null = null;

  #next = 0;

  /**
   * Empty by default, and deliberately not a friendly "Hello there." — a
   * pre-seeded step would be consumed as round one, so every test that pushed
   * its own script would silently assert against the greeting instead.
   */
  constructor(script: LlmStep[] = []) {
    this.script = script;
  }

  /** How many rounds the session actually asked for. */
  get rounds(): number {
    return this.calls.length;
  }

  async *stream(messages: ChatMessage[], opts: StreamOptions = {}): AsyncGenerator<StreamChunk> {
    // Copied, not held: the turn loop pushes tool results into the same array.
    this.calls.push({ messages: [...messages], opts });

    const step = this.script[this.#next];
    this.#next += 1;
    if (step === undefined) return;
    if (step instanceof Error) throw step;

    for (let i = 0; i < step.length; i++) {
      const chunk = step[i]!;
      if (this.beforeChunk) await this.beforeChunk(i, chunk);
      if (opts.signal?.aborted) return;
      yield chunk;
    }
  }
}

/** A DeviceLink that records rather than writes to a socket. */
export function recordingDevice(): DeviceLink & {
  audio: Buffer[];
  control: Array<Record<string, unknown>>;
  closed: string | null;
} {
  const audio: Buffer[] = [];
  const control: Array<Record<string, unknown>> = [];
  return {
    audio,
    control,
    closed: null,
    sendAudio(pcm) {
      audio.push(pcm);
    },
    sendControl(msg) {
      control.push(msg);
    },
    close(reason) {
      this.closed = reason;
    },
  };
}

/**
 * Virtual time for the LLM retry path.
 *
 * `sleep` advances the clock and resolves immediately, so a test asserting "says
 * something after 600 ms of silence" costs no wall-clock time. `rand` returns 1
 * by default — full jitter is uniform over [0, raw), so 1 is the top of the
 * range and makes the retry schedule the deterministic worst case.
 */
export function manualClock(rand = () => 1): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  elapsed: () => number;
} {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    rand,
    elapsed: () => t,
  };
}

// ---------------------------------------------------------------------------
// Session assembly
// ---------------------------------------------------------------------------

export type LogLine = { level: string; msg: string; extra: Record<string, unknown> };

export type SessionHarness = {
  session: Session;
  device: ReturnType<typeof recordingDevice>;
  llm: FakeLlm;
  clock: ReturnType<typeof manualClock>;
  /** Everything the session logged. Some behaviour is only observable here. */
  logs: LogLine[];
  /** Every ASR opened, in order. A failover opens a second one. */
  asrs: FakeAsr[];
  /** Every TTS opened, in order. A gate-1 refusal opens one to apologise. */
  ttss: FakeTts[];
  /** The live ASR. Throws rather than returning undefined — a missing one is the bug. */
  asr: () => FakeAsr;
  tts: () => FakeTts;
};

/**
 * A `Session` wired to fakes.
 *
 * The echo guard's suppression window defaults to 0 here. It is real wall-clock
 * time inside `EchoGuard`, so a 400 ms window would put a real sleep in front of
 * every barge-in assertion — and what the window does is already covered
 * exhaustively in echo-guard.test.ts. These tests are about the wiring.
 */
export function makeSession(over: Partial<SessionDeps> = {}): SessionHarness {
  const device = over.device ?? recordingDevice();
  const llm = new FakeLlm();
  const clock = manualClock();
  const asrs: FakeAsr[] = [];
  const ttss: FakeTts[] = [];

  const cfg =
    over.cfg ??
    testConfig({
      echoGuard: {
        suppressionWindowMs: 0,
        requireTranscript: true,
        selfEchoThreshold: 0.6,
        halfDuplex: false,
      },
    });

  const logs: LogLine[] = [];

  const session = new Session({
    cfg,
    uid: "u1",
    log: (level, msg, extra) => void logs.push({ level, msg, extra: extra ?? {} }),
    makeAsr: (_cfg, spec) => {
      const asr = new FakeAsr(spec);
      asrs.push(asr);
      return asr;
    },
    makeTts: (_cfg, opts) => {
      const tts = new FakeTts(opts);
      ttss.push(tts);
      return tts;
    },
    makeLlm: () => llm,
    clock,
    ...over,
    // `device` is resolved above so the harness can hand back the recorder it
    // actually wired, whether or not the caller supplied one.
    device,
  });

  return {
    session,
    device: device as ReturnType<typeof recordingDevice>,
    llm,
    clock,
    logs,
    asrs,
    ttss,
    asr: () => {
      const a = asrs.at(-1);
      if (!a) throw new Error("no ASR was opened");
      return a;
    },
    tts: () => {
      const t = ttss.at(-1);
      if (!t) throw new Error("no TTS was opened");
      return t;
    },
  };
}

/**
 * Let pending work drain.
 *
 * A transcript arrives on an event emitter and the turn it starts is async, so
 * there is nothing to await at the call site. `setImmediate` rather than a sleep
 * so real timers set to 0 — the tool filler threshold, for one — still fire.
 */
export async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Drain until `predicate` holds, or fail loudly naming what never happened.
 *
 * A real 1 ms timer per tick, not `setImmediate`: some of what a turn waits on
 * is a genuine timer — a tool's own latency, the filler threshold — and an
 * immediate-only spin completes hundreds of iterations inside a single
 * millisecond, timing out on work that was about to finish. Returns on the tick
 * the predicate holds, so the common case still costs ~1 ms.
 */
export async function waitFor(
  predicate: () => boolean,
  label = "condition",
  ticks = 300,
): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`waitFor timed out waiting for ${label}`);
}

/**
 * A `fetch` that answers every call with the same JSON body.
 *
 * Typed as the real `fetch` because that is what the Google client takes, but
 * only the four members it actually touches are implemented — `ok`, `status`,
 * `json` and `text`. Anything else would be scaffolding nobody reads.
 */
export function jsonFetch(body: unknown, status = 200): typeof globalThis.fetch {
  const calls: string[] = [];
  const f = (async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof globalThis.fetch & { calls: string[] };
  f.calls = calls;
  return f;
}
