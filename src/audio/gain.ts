/**
 * Sample-level gain, with a ramp.
 *
 * The only DSP in this product, and it exists because of ducking: the music has
 * to drop under a voice at the start of every utterance, and `ffplay -volume`
 * is fixed at spawn. See MediaPlayer in scripts/device-client.ts.
 *
 * Lives here rather than inside that script so it can be TESTED. A fault in
 * these twenty lines is silence, or a crack at full scale played next to
 * somebody's ear, and neither is something to find out about on hardware.
 */

/** Full-scale bounds for signed 16-bit PCM. */
const INT16_MIN = -32768;
const INT16_MAX = 32767;

export type GainResult = {
  /** The scaled samples. A fresh buffer; the input is never modified. */
  out: Buffer;
  /** Where the ramp reached, to be passed back in as `from` next call. */
  gain: number;
};

/**
 * Scale one buffer of little-endian int16 samples, ramping `from` toward `to`.
 *
 * ⚠ RAMPED, NOT STEPPED. A gain that jumps from 0.55 to 0.15 between adjacent
 * samples is a step discontinuity — a click, at every duck and every release,
 * so twice per sentence. `perSample` is how much the gain may move per sample;
 * derive it from the ramp length you want:
 *
 *     perSample = 1 / (rampSeconds * sampleRate * channels)
 *
 * An odd trailing byte is dropped rather than read past the end: ffmpeg emits
 * whatever the pipe delivers, and a chunk boundary can land mid-sample.
 */
export function applyGain(chunk: Buffer, from: number, to: number, perSample: number): GainResult {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return { out: Buffer.alloc(0), gain: from };

  const out = Buffer.allocUnsafe(samples * 2);
  const step = Math.abs(perSample);
  let g = from;

  for (let i = 0; i < samples; i++) {
    if (g !== to) {
      g = g < to ? Math.min(to, g + step) : Math.max(to, g - step);
    }
    // Clamped. A gain above 1 is never asked for here, but a wrapped int16 is
    // a full-scale crack rather than a slightly loud note.
    const scaled = Math.round(chunk.readInt16LE(i * 2) * g);
    out.writeInt16LE(
      scaled < INT16_MIN ? INT16_MIN : scaled > INT16_MAX ? INT16_MAX : scaled,
      i * 2,
    );
  }
  return { out, gain: g };
}

/** How much gain may move per sample to cover a full 0→1 ramp in `ms`. */
export function rampPerSample(ms: number, sampleRate: number, channels: number): number {
  return 1 / ((ms / 1000) * sampleRate * channels);
}

/** Root-mean-square of a little-endian int16 buffer. Used to detect a voice. */
export function rms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = chunk.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}
