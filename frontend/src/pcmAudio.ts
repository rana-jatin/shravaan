/**
 * Browser-side mic capture and PCM playback, matching the rates the server
 * defaults to (ASR_SAMPLE_RATE=16000, TTS_SAMPLE_RATE=24000,
 * DEVICE_FRAME_MS=80 — see .env.example). If a deployment overrides those,
 * override the constants below to match: the server decodes what it's told
 * to expect, not what actually arrives.
 *
 * This is the browser equivalent of ai/scripts/device-client.ts's ffmpeg
 * capture / Player class — same framing and barge-in-by-flush behaviour,
 * done with Web Audio instead of a subprocess.
 */

export const ASR_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;
export const DEVICE_FRAME_MS = 80;

const CAPTURE_BUFFER_SAMPLES = 2048;

function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(input.length * 2);
  const view = new DataView(out);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * Captures the mic, re-cuts whatever the browser hands us into
 * DEVICE_FRAME_MS frames (same reason as the TS device client: a server fed
 * ragged frames reports timings that belong to the browser's buffer size, not
 * the speaker), and calls onFrame for each one.
 */
export class MicStreamer {
  #audioCtx: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #processor: ScriptProcessorNode | null = null;
  #pending: Int16Array = new Int16Array(0);
  readonly #bytesPerFrame = Math.round((ASR_SAMPLE_RATE * 2 * DEVICE_FRAME_MS) / 1000);

  async start(onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new AudioContext({ sampleRate: ASR_SAMPLE_RATE });
    this.#audioCtx = audioCtx;

    const source = audioCtx.createMediaStreamSource(this.#stream);
    const processor = audioCtx.createScriptProcessor(CAPTURE_BUFFER_SAMPLES, 1, 1);
    this.#processor = processor;

    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(floatTo16BitPcm(channel));
      const merged = new Int16Array(this.#pending.length + pcm.length);
      merged.set(this.#pending);
      merged.set(pcm, this.#pending.length);
      this.#pending = merged;

      const samplesPerFrame = this.#bytesPerFrame / 2;
      let offset = 0;
      while (this.#pending.length - offset >= samplesPerFrame) {
        onFrame(this.#pending.slice(offset, offset + samplesPerFrame).buffer);
        offset += samplesPerFrame;
      }
      this.#pending = this.#pending.slice(offset);
    };

    // Some browsers only fire onaudioprocess while the node is in the graph
    // reaching a destination. Route through a silent gain so capture doesn't
    // also play the mic back and cause feedback.
    const silence = audioCtx.createGain();
    silence.gain.value = 0;
    source.connect(processor);
    processor.connect(silence);
    silence.connect(audioCtx.destination);
  }

  stop(): void {
    this.#processor?.disconnect();
    this.#processor = null;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    void this.#audioCtx?.close();
    this.#audioCtx = null;
    this.#pending = new Int16Array(0);
  }
}

/** Queues incoming PCM16 chunks back-to-back so playback has no gaps. */
export class PcmPlayer {
  #audioCtx: AudioContext | null = null;
  #nextStartTime = 0;
  #activeSources: AudioBufferSourceNode[] = [];

  #ctx(): AudioContext {
    if (!this.#audioCtx) {
      this.#audioCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
      this.#nextStartTime = this.#audioCtx.currentTime;
    }
    return this.#audioCtx;
  }

  write(pcm: ArrayBuffer): void {
    const ctx = this.#ctx();
    const int16 = new Int16Array(pcm);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = (int16[i] ?? 0) / 0x8000;
    }
    const buffer = ctx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.#nextStartTime);
    source.start(startAt);
    this.#nextStartTime = startAt + buffer.duration;

    this.#activeSources.push(source);
    source.onended = () => {
      this.#activeSources = this.#activeSources.filter((s) => s !== source);
    };
  }

  /** Barge-in: drop whatever is queued or playing, same as Player.flush() in
   * ai/scripts/device-client.ts. */
  flush(): void {
    for (const source of this.#activeSources) {
      try {
        source.stop();
      } catch {
        // Already finished — fine.
      }
    }
    this.#activeSources = [];
    if (this.#audioCtx) this.#nextStartTime = this.#audioCtx.currentTime;
  }

  close(): void {
    this.flush();
    void this.#audioCtx?.close();
    this.#audioCtx = null;
  }
}
