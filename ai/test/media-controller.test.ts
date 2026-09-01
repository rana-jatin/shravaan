/**
 * Media control, now that it is reachable without a Session.
 *
 * The behaviours worth pinning are the ones whose failure is silent or
 * unrecoverable-by-talking: two streams at once, a volume floor of zero, and a
 * stuck playing-flag that makes the companion go deaf.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MediaController } from "../src/orchestrator/media-controller.ts";
import type { MediaRequest } from "../src/tools/types.ts";

function controller(defaultVolume = 70) {
  const sent: Array<Record<string, unknown>> = [];
  const logs: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
  const c = new MediaController({
    sendControl: (m) => sent.push(m),
    defaultVolume,
    log: (level, msg, extra) => logs.push({ level, msg, ...(extra ? { extra } : {}) }),
  });
  return { c, sent, logs };
}

const radio: MediaRequest = {
  source: "radio",
  title: "Vividh Bharati",
  language: "hi-IN",
  urls: ["https://a.example/1", "https://a.example/2"],
};
const song: MediaRequest = {
  source: "youtube",
  title: "Lag Ja Gale",
  artist: "Lata Mangeshkar",
  video_id: "abc123",
};

describe("MediaController", () => {
  it("is not playing until something starts", () => {
    const { c } = controller();
    assert.equal(c.playing, false);
  });

  it("sends play_media with the volume attached, because there is no ducking", () => {
    const { c, sent } = controller(70);

    c.start(radio);

    assert.equal(c.playing, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!["type"], "play_media");
    assert.equal(sent[0]!["volume"], 70);
    assert.deepEqual(sent[0]!["urls"], radio.urls);
  });

  it("stops the previous track before starting a new one — never two at once", () => {
    // Two stations at once is the one outcome nobody can recover from by talking.
    const { c, sent } = controller();

    c.start(radio);
    c.start(song);

    assert.deepEqual(
      sent.map((m) => m["type"]),
      ["play_media", "stop_media", "play_media"],
    );
  });

  it("stop is idempotent — barge-in, end_conversation and 'stop' can all arrive", () => {
    const { c, sent } = controller();

    c.start(radio);
    c.stop("user_asked");
    c.stop("session_closed");
    c.stop("emergency");

    assert.equal(c.playing, false);
    assert.equal(sent.filter((m) => m["type"] === "stop_media").length, 1);
  });

  it("ignores a stop when nothing is playing", () => {
    const { c, sent } = controller();
    c.stop("nothing to do");
    assert.deepEqual(sent, []);
  });

  it("steps volume up and down by 20", () => {
    const { c, sent } = controller(50);

    c.start(radio);
    c.adjustVolume("louder");
    c.adjustVolume("quieter");

    const volumes = sent.filter((m) => m["type"] === "set_media_volume").map((m) => m["volume"]);
    assert.deepEqual(volumes, [70, 50]);
  });

  it("floors volume at 15, never 0 — silent-but-playing reads as broken", () => {
    // Someone who wanted silence would have said stop.
    const { c, sent } = controller(20);

    c.start(radio);
    c.adjustVolume("quieter");
    c.adjustVolume("quieter");

    const last = sent.filter((m) => m["type"] === "set_media_volume").at(-1);
    assert.equal(last!["volume"], 15);
  });

  it("caps volume at 100", () => {
    const { c, sent } = controller(95);

    c.start(radio);
    c.adjustVolume("louder");
    c.adjustVolume("louder");

    const last = sent.filter((m) => m["type"] === "set_media_volume").at(-1);
    assert.equal(last!["volume"], 100);
  });

  it("reports hitting a limit rather than silently doing nothing", () => {
    const { c, logs } = controller(100);

    c.start(radio);
    c.adjustVolume("louder");

    const line = logs.find((l) => l.msg === "media volume");
    assert.equal(line!.extra!["at_limit"], true);
  });

  it("ignores a volume change when nothing is playing", () => {
    const { c, sent } = controller();
    c.adjustVolume("louder");
    assert.deepEqual(sent, []);
  });

  it("clears the playing flag when the device reports the track ended", () => {
    // WITHOUT THIS THE SESSION GOES DEAF: #onFinal returns early while media
    // plays, so a stuck flag swallows every later transcript.
    const { c, sent } = controller();

    c.start(radio);
    c.endedOnDevice();

    assert.equal(c.playing, false);
    assert.equal(
      sent.filter((m) => m["type"] === "stop_media").length,
      0,
      "the device told us it ended; telling it to stop would be noise",
    );
  });

  it("ignores an end report when nothing is playing", () => {
    const { c, logs } = controller();
    c.endedOnDevice();
    assert.deepEqual(logs, []);
  });
});
