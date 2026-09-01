/**
 * Sample-level gain and the voice detector behind ducking.
 *
 * These twenty lines are the difference between a companion that can be
 * interrupted while music plays and one that appears to have stopped listening
 * — which is the bug they were written for. A fault here is silence, a click at
 * every duck, or a crack at full scale next to somebody's ear, and none of
 * those is something to discover on hardware.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyGain, rampPerSample, rms } from "../src/audio/gain.ts";

/** A buffer of `n` identical samples. */
function tone(value: number, n: number): Buffer {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(value, i * 2);
  return b;
}

const samples = (b: Buffer): number[] => {
  const out: number[] = [];
  for (let i = 0; i < b.length / 2; i++) out.push(b.readInt16LE(i * 2));
  return out;
};

describe("applyGain", () => {
  it("halves a signal at gain 0.5", () => {
    // perSample 0 pins the gain, so this is the steady-state case.
    const { out } = applyGain(tone(1000, 4), 0.5, 0.5, 0);
    assert.deepEqual(samples(out), [500, 500, 500, 500]);
  });

  it("silences at gain 0", () => {
    const { out } = applyGain(tone(20000, 4), 0, 0, 0);
    assert.deepEqual(samples(out), [0, 0, 0, 0]);
  });

  it("leaves the input buffer untouched", () => {
    // The same chunk is not reused downstream today, but a scaler that mutates
    // its input is a trap for whoever adds a second consumer.
    const input = tone(1000, 4);
    applyGain(input, 0.1, 0.1, 0);
    assert.deepEqual(samples(input), [1000, 1000, 1000, 1000]);
  });

  it("ramps toward the target rather than jumping", () => {
    // The click this prevents happens twice a sentence once ducking is on.
    const { out, gain } = applyGain(tone(10000, 5), 1, 0, 0.1);
    const got = samples(out);
    assert.deepEqual(got, [9000, 8000, 7000, 6000, 5000]);
    assert.ok(Math.abs(gain - 0.5) < 1e-9, `gain landed at ${gain}`);
  });

  it("stops exactly at the target and does not overshoot", () => {
    const { out, gain } = applyGain(tone(10000, 10), 1, 0.8, 0.1);
    assert.equal(gain, 0.8);
    // Never below the target, however many samples remain.
    assert.ok(Math.min(...samples(out)) >= 8000);
  });

  it("ramps upward as well as down", () => {
    const { gain } = applyGain(tone(100, 5), 0.2, 1, 0.1);
    assert.ok(Math.abs(gain - 0.7) < 1e-9, `gain landed at ${gain}`);
  });

  it("clamps rather than wrapping", () => {
    // A wrapped int16 is a full-scale crack, not a slightly loud note.
    const { out } = applyGain(tone(30000, 2), 2, 2, 0);
    assert.deepEqual(samples(out), [32767, 32767]);
    const { out: neg } = applyGain(tone(-30000, 2), 2, 2, 0);
    assert.deepEqual(samples(neg), [-32768, -32768]);
  });

  it("survives a chunk that ends mid-sample", () => {
    // ffmpeg emits whatever the pipe delivers; a boundary can land on an odd
    // byte, and reading past the end would throw inside the audio path.
    const odd = Buffer.concat([tone(1000, 2), Buffer.from([0x11])]);
    const { out } = applyGain(odd, 1, 1, 0);
    assert.equal(out.length, 4, "the trailing byte is dropped, not read");
  });

  it("handles an empty chunk", () => {
    const { out, gain } = applyGain(Buffer.alloc(0), 0.5, 0.2, 0.1);
    assert.equal(out.length, 0);
    assert.equal(gain, 0.5, "an empty chunk does not advance the ramp");
  });
});

describe("rampPerSample", () => {
  it("covers a full 0 to 1 ramp in the time asked for", () => {
    const per = rampPerSample(40, 48000, 2);
    const samplesInRamp = (40 / 1000) * 48000 * 2;
    assert.ok(Math.abs(per * samplesInRamp - 1) < 1e-9);
  });

  it("is short enough to be inaudible but long enough not to click", () => {
    // 40 ms at 48k stereo is 3840 samples — a ramp, not a step.
    assert.ok(1 / rampPerSample(40, 48000, 2) > 1000);
  });
});

describe("rms — the voice detector behind ducking", () => {
  it("is zero for silence", () => {
    assert.equal(rms(Buffer.alloc(160)), 0);
  });

  it("equals the amplitude of a constant signal", () => {
    assert.equal(rms(tone(1000, 50)), 1000);
  });

  it("rises when a voice is added over steady music", () => {
    // THE WHOLE MECHANISM: music at the mic is a fairly steady level, and a
    // person talking near it is a rise above that. Ducking triggers on the
    // ratio, so what matters is that the ratio actually moves.
    const music = rms(tone(800, 100));
    const musicPlusVoice = rms(tone(2600, 100));
    assert.ok(musicPlusVoice / music > 2.2, `ratio was ${musicPlusVoice / music}`);
  });

  it("handles an odd trailing byte", () => {
    assert.equal(rms(Buffer.concat([tone(1000, 2), Buffer.from([0x7f])])), 1000);
  });
});
