/**
 * Laptop device client — the other half of the slice 1 demo.
 *
 * `src/server.ts` is device-facing, but nothing in this repo has ever been the
 * device. This is that: microphone in, speaker out, speaking the protocol
 * documented at the top of the server.
 *
 *   device -> server   binary  : linear16 PCM @ ASR_SAMPLE_RATE, mono
 *   device -> server   json    : { type: "hello", uid, sid?, locale_hint? }
 *   server -> device   binary  : linear16 PCM @ TTS_SAMPLE_RATE, mono
 *   server -> device   json    : ready | notice | clear_audio | session_closed
 *                                play_media | stop_media
 *
 * Audio is moved by ffmpeg (capture) and ffplay (playback) rather than a native
 * binding, so this runs on a stock laptop with no build step.
 *
 * USE HEADPHONES. There is no AEC here — the device half of slice 2 is the part
 * that needs real hardware (docs/04-milestones.md). On open-air playback the bot
 * hears itself; the server's echo guard is a second layer of defence, not a
 * substitute for the first, and it was tuned assuming AEC exists. Testing
 * barge-in on laptop speakers measures the wrong thing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { applyGain, rampPerSample, rms } from "../src/audio/gain.ts";
import { WebSocket } from "ws";

type Args = {
  url: string;
  mic: string | null;
  /** Replay an audio file as the microphone, for a turn that repeats exactly. */
  file: string | null;
  fileRate: number;
  uid: string;
  sid: string | null;
  locale: string | null;
  asrRate: number;
  ttsRate: number;
  frameMs: number;
  /** Turns a YouTube id into a playable URL. See MediaPlayer.playVideo. */
  mediaResolver: string;
  /** Level the music drops to under a voice, 0-100. See DUCKING below. */
  duckVolume: number;
  listDevices: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags.set(m[1]!, m[2] ?? "true");
  }
  const num = (name: string, envName: string, fallback: number): number => {
    const raw = flags.get(name) ?? process.env[envName];
    const n = raw ? Number(raw) : fallback;
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`);
    return n;
  };

  const port = process.env["PORT"]?.trim() || "8080";
  return {
    url: flags.get("url") ?? `ws://127.0.0.1:${port}`,
    duckVolume: Number(flags.get("duck-volume") ?? process.env["MUSIC_DUCK_VOLUME"] ?? 15),
    mediaResolver:
      flags.get("media-resolver") ??
      process.env["MEDIA_RESOLVER"] ??
      "yt-dlp -f bestaudio -g",
    mic: flags.get("mic") ?? null,
    file: flags.get("file") ?? null,
    // Raw .pcm carries no header, so its rate has to be asserted. Defaults to
    // the TTS rate because the obvious file to replay is something we rendered.
    fileRate: num("file-rate", "TTS_SAMPLE_RATE", 24000),
    uid: flags.get("uid") ?? "laptop-dev",
    sid: flags.get("sid") ?? null,
    locale: flags.get("locale") ?? null,
    // The rates are the server's, not ours to pick: it decodes what we send at
    // ASR_SAMPLE_RATE and encodes what it sends at TTS_SAMPLE_RATE. Reading the
    // same .env is what keeps the two ends agreeing.
    asrRate: num("asr-rate", "ASR_SAMPLE_RATE", 16000),
    ttsRate: num("tts-rate", "TTS_SAMPLE_RATE", 24000),
    frameMs: num("frame-ms", "DEVICE_FRAME_MS", 80),
    listDevices: flags.has("list-devices"),
  };
}

function log(msg: string, extra: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), src: "device", msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** DirectShow names are per-machine and not guessable. Print them, do not assume. */
function listDevices(): void {
  const p = spawn("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  // ffmpeg prints the device list on stderr and always exits non-zero here,
  // because "dummy" is not a real input. Expected, not a failure.
  p.stderr.on("data", (d: Buffer) => process.stderr.write(d));
  p.on("close", () => process.exit(0));
}

class Player {
  readonly #rate: number;
  #proc: ChildProcess | null = null;

  constructor(rate: number) {
    this.#rate = rate;
  }

  write(pcm: Buffer): void {
    if (this.#proc === null) this.#spawn();
    // Write failures are handled on the pipe itself, in #spawn. This callback
    // does not absorb them, whatever it looks like.
    this.#proc?.stdin?.write(pcm, () => {});
  }

  /**
   * Barge-in. Buffered audio lives on the device, so only the device can drop
   * it — killing the player is the bluntest way to do that, and it is honest
   * about the cost: the next chunk pays ffplay's start-up again. Real hardware
   * drops from a ring buffer instead, and this method goes away.
   */
  flush(): void {
    this.#proc?.kill();
    this.#proc = null;
  }

  #spawn(): void {
    const proc = spawn(
      "ffplay",
      [
        "-hide_banner", "-loglevel", "error",
        "-nodisp", "-autoexit",
        // Play what arrives rather than waiting to fill a buffer. The defaults
        // add hundreds of milliseconds to a budget with none to spare
        // (docs/03-latency-budget.md).
        "-probesize", "32", "-analyzeduration", "0",
        "-fflags", "nobuffer", "-flags", "low_delay",
        "-f", "s16le", "-ar", String(this.#rate), "-ac", "1",
        "-i", "pipe:0",
      ],
      { stdio: ["pipe", "ignore", "inherit"] },
    );
    this.#proc = proc;
    proc.on("error", (err) => log("ffplay failed — is ffmpeg on PATH?", { err: err.message }));

    // ⚠ THE BARGE-IN PATH ENDS HERE OR IT ENDS THE PROCESS. flush() kills the
    // player with PCM still queued in this pipe, and those queued writes fail
    // with EPIPE. The callback in write() does NOT swallow that: node invokes
    // it AND emits 'error' on the stream, and an unhandled 'error' event is
    // fatal — measured, twice, as the whole device dying mid-conversation and
    // the server closing the session as device_disconnected.
    proc.stdin?.on("error", () => {});

    // ffplay can also exit on its own: a decode error, or -autoexit. Only
    // flush() ever cleared the field, so without this it keeps pointing at a
    // corpse and every later write walks into the same dead pipe. Guarded on
    // identity because a flush-and-respawn races the old process's exit.
    proc.on("exit", () => {
      if (this.#proc === proc) this.#proc = null;
    });
  }
}

/** Media is decoded to this, scaled, and handed to the player. */
const MEDIA_RATE = 48000;
const MEDIA_CHANNELS = 2;

/**
 * Below this, a stream is considered dead rather than finished. See the exit
 * handler in #attempt for why a duration and not an exit code.
 */
const DEAD_STATION_MS = 4000;

/** Ramp a gain change over this long, so ducking does not click. */
const RAMP_MS = 40;

/**
 * Music playback: decode → GAIN → play, as three stages we control.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT SIMPLY `ffplay -volume`.
 *
 * It used to be exactly that, and the volume was fixed at spawn, because ffplay
 * exposes no runtime volume control under -nodisp. Changing it meant killing
 * the process and starting again: about a second of silence, and for live radio
 * a jump back to the live edge.
 *
 * That is survivable for "turn it down", which happens once. It is NOT
 * survivable for DUCKING, which has to happen at the start of every single
 * thing the user says. Restarting the stream per utterance would make the music
 * unlistenable — so ducking was never built, and the result is the bug this
 * replaces: with the music at any real volume, the microphone hears the speaker
 * rather than the person, the ASR never reports speech, and the companion
 * appears to have stopped listening.
 *
 * So ffmpeg decodes to raw PCM, WE multiply the samples, and ffplay plays the
 * result. Volume becomes a number in this process — instant, sample-accurate,
 * no restart and no lost audio. mpv with --input-ipc-server is the other
 * answer; this one needs nothing that is not already installed for the mic.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Still a SECOND player, separate from `Player`. That one is a PCM sink tuned
 * for minimum latency because it carries speech; this one is left to run for
 * four minutes. Sharing a process would mean either the song's buffering
 * applies to speech, or every reply kills the music.
 */
class MediaPlayer {
  #decoder: ChildProcess | null = null;
  #sink: ChildProcess | null = null;
  /** Told when playback ends on its own, so the server can leave media mode. */
  onEnded: (() => void) | null = null;
  /** Rejects a late exit from a player we already replaced. */
  #generation = 0;
  #resolverCmd: string;

  /** What the user asked for, 0-100. Ducking never overwrites this. */
  #volume = 100;
  /** Where the gain is heading, and where it is now. Ramped between samples. */
  #targetGain = 1;
  #gain = 1;
  #ducked = false;
  readonly #duckLevel: number;

  constructor(resolverCmd: string, duckLevel = 20) {
    this.#resolverCmd = resolverCmd;
    this.#duckLevel = duckLevel;
  }

  get playing(): boolean {
    return this.#decoder !== null;
  }

  get ducked(): boolean {
    return this.#ducked;
  }

  /** Radio: try each URL until one plays. */
  playUrls(urls: string[], title: string, volume = 100): void {
    this.stop("replaced");
    this.#resetVolume(volume);
    const generation = ++this.#generation;
    this.#attempt(urls, 0, title, generation);
  }

  #resetVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(100, volume));
    this.#ducked = false;
    this.#targetGain = this.#volume / 100;
    this.#gain = this.#targetGain; // no ramp into a fresh stream
  }

  #attempt(urls: string[], index: number, title: string, generation: number): void {
    if (generation !== this.#generation) return;
    const url = urls[index];
    if (url === undefined) {
      log("every station URL failed", { title, tried: urls.length });
      this.onEnded?.();
      return;
    }

    const startedAt = Date.now();
    log("playing", { title, url: url.slice(0, 60), attempt: index + 1, volume: this.#volume });

    // Stage 1: decode anything to raw PCM. The reconnect flags belong here and
    // not on the sink, because this is the stage that touches the network.
    const decoder = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-i", url,
        "-f", "s16le", "-acodec", "pcm_s16le",
        "-ar", String(MEDIA_RATE), "-ac", String(MEDIA_CHANNELS),
        "-",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    // Stage 3: a dumb sink. No decoding, no network, nothing that can stall.
    const sink = spawn(
      "ffplay",
      [
        "-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit",
        "-f", "s16le", "-ar", String(MEDIA_RATE), "-ac", String(MEDIA_CHANNELS),
        "-i", "pipe:0",
      ],
      { stdio: ["pipe", "ignore", "inherit"] },
    );

    this.#decoder = decoder;
    this.#sink = sink;

    // Stage 2: us. The whole point of the pipeline.
    decoder.stdout?.on("data", (chunk: Buffer) => {
      if (generation !== this.#generation) return;
      const ok = sink.stdin?.write(this.#applyGain(chunk));
      // Backpressure: ffplay's buffer is full, so stop reading until it drains.
      // Without this the decoder races ahead of playback and memory grows for
      // the length of the song.
      if (ok === false) {
        decoder.stdout?.pause();
        sink.stdin?.once("drain", () => decoder.stdout?.resume());
      }
    });

    decoder.on("error", (err) => log("ffmpeg failed — is it on PATH?", { err: err.message }));
    sink.on("error", (err) => log("ffplay failed — is it on PATH?", { err: err.message }));
    // A closed pipe when the sink goes first must not crash the device; the
    // decoder's exit is the authority on whether the song ended.
    sink.stdin?.on("error", () => {});

    decoder.on("exit", (code) => {
      if (generation !== this.#generation) return;
      this.#decoder = null;
      try {
        sink.stdin?.end();
      } catch {
        // Already gone.
      }
      const livedMs = Date.now() - startedAt;

      // ⚠ DURATION, NOT EXIT CODE. A dead URL exits 0 with nothing played —
      // measured: an unresolvable host, and an HTML page served instead of
      // audio, both did. Keying the fallback on the exit code meant it never
      // fired, and the first broken station silently ended playback.
      if (livedMs < DEAD_STATION_MS) {
        log("station failed, trying the next", { title, code, livedMs });
        this.#attempt(urls, index + 1, title, generation);
        return;
      }
      log("media ended", { title, livedMs });
      // MUST reach the server. It holds a media flag that gates listening, and
      // a stream that dies without saying so leaves the session deaf.
      this.onEnded?.();
    });
  }

  /**
   * Scale one buffer toward the target gain, keeping the ramp position.
   *
   * The maths is in src/audio/gain.ts so it can be tested — a fault here is
   * silence, or a crack at full scale played next to somebody's ear.
   */
  #applyGain(chunk: Buffer): Buffer {
    const { out, gain } = applyGain(
      chunk,
      this.#gain,
      this.#targetGain,
      rampPerSample(RAMP_MS, MEDIA_RATE, MEDIA_CHANNELS),
    );
    this.#gain = gain;
    return out;
  }

  /**
   * YouTube: a video id is not a playable URL, so an external resolver turns it
   * into one. Kept as a COMMAND rather than built in, because how a device
   * obtains that audio is exactly the decision that should stay swappable — an
   * official embedded player, or a licensed source, replaces this one string.
   */
  playVideo(videoId: string, title: string, volume = 100): void {
    this.stop("replaced");
    this.#resetVolume(volume);
    const generation = ++this.#generation;

    const [cmd, ...rest] = this.#resolverCmd.split(" ");
    if (!cmd) {
      log("no media resolver configured — cannot play a video", { videoId });
      return;
    }
    const resolver = spawn(cmd, [...rest, `https://www.youtube.com/watch?v=${videoId}`], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    let out = "";
    resolver.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    resolver.on("error", (err) =>
      log("media resolver failed to start", {
        cmd,
        err: err.message,
        hint: "install it, or pass --media-resolver",
      }),
    );
    resolver.on("exit", (code) => {
      if (generation !== this.#generation) return;
      const url = out.trim().split("\n")[0] ?? "";
      if (code !== 0 || url === "") {
        log("could not resolve a playable URL", { videoId, code });
        return;
      }
      this.#attempt([url], 0, title, generation);
    });
  }

  /**
   * What the user asked for. Instant now: no restart, no gap, no lost audio.
   *
   * If the stream is currently ducked the new level is remembered and takes
   * effect when the duck lifts, so "turn it up" mid-sentence does not shout
   * over the sentence that asked for it.
   */
  setVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(100, volume));
    if (!this.#ducked) this.#targetGain = this.#volume / 100;
    log("volume changed", { volume: this.#volume, ducked: this.#ducked });
  }

  /**
   * Drop under a voice, and come back after it.
   *
   * This is the whole reason for the pipeline above. It runs at the start of
   * every utterance, so it has to be free — a number changing, not a process
   * restarting.
   */
  duck(): void {
    if (this.#ducked || !this.playing) return;
    this.#ducked = true;
    this.#targetGain = this.#duckLevel / 100;
  }

  unduck(): void {
    if (!this.#ducked) return;
    this.#ducked = false;
    this.#targetGain = this.#volume / 100;
  }

  stop(reason: string): void {
    if (!this.#decoder && !this.#sink) return;
    // Invalidate first: the exit handler must not treat a deliberate kill as a
    // dead station and start walking the fallback list.
    this.#generation++;
    this.#decoder?.kill();
    this.#sink?.kill();
    this.#decoder = null;
    this.#sink = null;
    this.#ducked = false;
    log("media stopped", { reason });
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.listDevices) return listDevices();

  const bytesPerFrame = Math.round((args.asrRate * 2 * args.frameMs) / 1000);
  const player = new Player(args.ttsRate);
  const media = new MediaPlayer(args.mediaResolver, args.duckVolume);
  // Playback ending is a fact only the device has. Without it the server never
  // leaves media mode and stops answering the user entirely.
  media.onEnded = () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "media_ended" }));
  };

  // ───────────────────────────────────────────────────────────────────────────
  // DUCKING — why this lives on the DEVICE and not on the server.
  //
  // The bug it fixes: with the music at any real volume, the microphone hears
  // the loudspeaker rather than the person. Sarvam's VAD never reports speech,
  // no transcript is ever produced, and the companion looks like it has stopped
  // listening. Turning the music down by hand fixes it, which is not a fix.
  //
  // The server cannot solve this, and not because of latency. It is a
  // CHICKEN-AND-EGG: the server only learns that someone is speaking from the
  // ASR, and the ASR is the thing that cannot hear them. Whatever the round
  // trip cost, the trigger never arrives.
  //
  // The device can, because it knows something the server does not — what it is
  // playing. Music through a loudspeaker is a fairly steady level at the mic;
  // a person talking near the mic is a RISE above it. So we track the quiet
  // baseline and duck on the rise, which is a far more sensitive test than "is
  // this speech", and it is the only one available before the ASR can hear.
  //
  // Both voices duck the music: the user's, so they can be heard, and the
  // companion's own, so its reply can be heard. At volume 55 the second was
  // just as broken as the first — the reply was being spoken underneath the
  // song.
  // ───────────────────────────────────────────────────────────────────────────

  /** How long the music stays down after the last sign of a voice. */
  const DUCK_HOLD_MS = 1200;
  /** Longer after our own speech: TTS arrives in bursts with gaps between. */
  const TTS_DUCK_HOLD_MS = 1500;
  /** Mic energy this far above the quiet baseline is taken as a voice. */
  const SPEECH_RISE = 2.2;
  /** Absolute floor, so room noise in a silent room can never trigger. */
  const SPEECH_FLOOR_RMS = 260;
  /** Baseline follows the music slowly, so a voice cannot drag it upward. */
  const BASELINE_ALPHA = 0.02;

  let unduckTimer: NodeJS.Timeout | null = null;
  const duckFor = (ms: number): void => {
    if (!media.playing) return;
    media.duck();
    if (unduckTimer) clearTimeout(unduckTimer);
    unduckTimer = setTimeout(() => {
      media.unduck();
      unduckTimer = null;
    }, ms);
  };

  let baselineRms = 0;

  /** Called for every mic frame while media plays. */
  const watchForVoice = (frame: Buffer): void => {
    if (!media.playing) {
      baselineRms = 0;
      return;
    }
    const level = rms(frame);
    if (baselineRms === 0) {
      baselineRms = level;
      return;
    }
    const speaking = level > SPEECH_FLOOR_RMS && level > baselineRms * SPEECH_RISE;
    if (speaking) {
      duckFor(DUCK_HOLD_MS);
      // Do NOT fold a voice into the baseline — that is how a ducking gate
      // slowly deafens itself over a long conversation.
      return;
    }
    baselineRms += (level - baselineRms) * BASELINE_ALPHA;
  };
  const ws = new WebSocket(args.url);
  let mic: ChildProcess | null = null;

  const shutdown = (reason: string): void => {
    log("shutting down", { reason });
    mic?.kill();
    player.flush();
    if (ws.readyState === ws.OPEN) ws.close();
    setTimeout(() => process.exit(0), 100).unref();
  };

  ws.on("open", () => {
    log("connected", { url: args.url });
    ws.send(
      JSON.stringify({
        type: "hello",
        uid: args.uid,
        // Reconnecting with a previous sid resumes that thread if the idle
        // window has not lapsed — the continuity slice 4 built.
        ...(args.sid ? { sid: args.sid } : {}),
        ...(args.locale ? { locale_hint: args.locale } : {}),
      }),
    );

    // Either a real microphone, or a file replayed in its place. The file path
    // exists so a turn can be repeated exactly: the same utterance, the same
    // timings, every run. `-re` paces it at wall-clock speed, because feeding a
    // VAD three seconds of speech in one burst tells you nothing about how the
    // VAD behaves on speech.
    // A file ends the instant the speech does. Sarvam's VAD closes an utterance
    // on silence_duration_ms of SILENCE, not on the audio stopping, so an
    // unpadded replay produces endless partials and no final — the turn never
    // completes. A real microphone always keeps sending; `apad` emulates that.
    const filePad = ["-af", "apad=pad_dur=2"];
    const input = args.file
      ? ["-re", "-f", "s16le", "-ar", String(args.fileRate), "-ac", "1", "-i", args.file, ...filePad]
      : [
          "-f", "dshow",
          // dshow's default capture buffer is a latency floor we would never
          // see in the budget, because it is spent before our first line of code.
          "-audio_buffer_size", "50",
          "-i", `audio=${args.mic ?? "default"}`,
        ];

    mic = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        ...input,
        "-ac", "1", "-ar", String(args.asrRate),
        "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    mic.on("error", (err) => log("ffmpeg failed — is ffmpeg on PATH?", { err: err.message }));
    mic.on("close", (code) => {
      if (code !== 0) {
        log("microphone capture stopped", {
          code,
          hint: 'run with --list-devices, then pass --mic="<name>"',
        });
      }
    });

    // The server expects DEVICE_FRAME_MS frames. ffmpeg hands us whatever the
    // pipe happens to deliver, so re-cut it: an ASR socket fed ragged frames
    // reports timings that belong to the pipe, not to the speaker.
    let pending: Buffer = Buffer.alloc(0);
    mic.stdout?.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= bytesPerFrame) {
        const frame = pending.subarray(0, bytesPerFrame);
        pending = pending.subarray(bytesPerFrame);
        // Before sending, not after: ducking has to start while the user is
        // still speaking, or the rest of the sentence is lost too.
        watchForVoice(frame);
        if (ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
      }
    });

    log(args.file ? "replaying file as microphone" : "listening — speak when ready, and use headphones", {
      source: args.file ?? `mic: ${args.mic ?? "default"}`,
      frame_bytes: bytesPerFrame,
      asr_rate: args.asrRate,
      tts_rate: args.ttsRate,
    });
  });

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Our own voice ducks the music too. Without this the reply is spoken
      // underneath the song and the user hears neither properly.
      duckFor(TTS_DUCK_HOLD_MS);
      player.write(data);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      log("server sent a non-JSON control frame");
      return;
    }
    switch (msg["type"]) {
      case "clear_audio":
        // Speech only. A barge-in interrupts the REPLY, not the music — the
        // user talking over a song is not asking for the song to stop, and the
        // server sends stop_media when they actually are.
        player.flush();
        log("barge-in — playback dropped");
        break;
      case "play_media": {
        const title = String(msg["title"] ?? "music");
        const volume = Number(msg["volume"] ?? 100);
        if (msg["source"] === "radio") {
          media.playUrls((msg["urls"] as string[]) ?? [], title, volume);
        } else if (msg["source"] === "youtube") {
          media.playVideo(String(msg["video_id"] ?? ""), title, volume);
        } else {
          log("unknown media source", { source: msg["source"] });
        }
        break;
      }
      case "set_media_volume":
        media.setVolume(Number(msg["volume"] ?? 100));
        break;
      case "stop_media":
        media.stop("server_asked");
        break;
      case "ready":
        // Worth printing: passing it back as --sid is how resume gets tested.
        log("session ready", { sid: msg["sid"] });
        break;
      case "notice":
        log("notice", { key: msg["key"], language: msg["language"] });
        break;
      case "session_closed":
        log("session closed by server", { reason: msg["reason"] });
        media.stop("session_closed");
        shutdown("session_closed");
        break;
      default:
        log("unhandled control message", { type: msg["type"] });
    }
  });

  ws.on("close", () => shutdown("socket_closed"));
  ws.on("error", (err: Error) => log("socket error", { err: err.message }));
  process.on("SIGINT", () => shutdown("sigint"));
}

main();
