/**
 * What is playing on the device, and the four things that can change it.
 *
 * Split out of Session, where the state lived as a `#media` field poked from
 * seven places. It is a real boundary rather than a cosmetic one: the whole of
 * media control needs exactly three things from the outside — a way to send a
 * control frame, a starting volume, and a log — where the ASR and TTS lifecycles
 * next door each touch a dozen pieces of Session's state and were deliberately
 * left where they are.
 *
 * NOTHING HERE TOUCHES AUDIO. The device fetches and plays the stream; the
 * server only ever sends it a control frame. See the protocol note at the top of
 * src/server.ts for why a four-minute track must not travel as PCM.
 */

import type { MediaRequest } from "../tools/types.ts";

type Playing = { title: string; startedAt: number; volume: number };

export type MediaControllerDeps = {
  sendControl: (msg: Record<string, unknown>) => void;
  /** Where a track starts. There is no ducking — see `start`. */
  defaultVolume: number;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

export class MediaController {
  #now: Playing | null = null;
  readonly #d: MediaControllerDeps;

  constructor(deps: MediaControllerDeps) {
    this.#d = deps;
  }

  /** True while a station or track is playing on the device. */
  get playing(): boolean {
    return this.#now !== null;
  }

  start(req: MediaRequest): void {
    // Replaces whatever was playing. Two stations at once is the one
    // outcome nobody could recover from by talking.
    if (this.#now) this.stop("replaced");
    this.#now = { title: req.title, startedAt: Date.now(), volume: this.#d.defaultVolume };
    // Volume travels with the request: there is no ducking, so the ONE
    // chance to make the microphone's job possible is at start.
    this.#d.sendControl({ type: "play_media", volume: this.#now.volume, ...req });
    this.#d.log("info", "media started", { source: req.source, title: req.title });
  }

  /**
   * Stop media and tell the device. Idempotent — `end_conversation`, a barge-in
   * and an explicit "stop" can all arrive for the same track.
   */
  stop(reason: string): void {
    if (!this.#now) return;
    const { title, startedAt } = this.#now;
    this.#now = null;
    this.#d.sendControl({ type: "stop_media" });
    this.#d.log("info", "media stopped", { title, reason, played_ms: Date.now() - startedAt });
  }

  /**
   * Louder or quieter, in steps.
   *
   * Steps rather than a number for the same reason `set_speaking_pace` uses
   * them: "sixty percent" is not a thing anyone says out loud. Clamped, and the
   * floor is deliberately above zero — silent-but-playing is indistinguishable
   * from broken to someone listening, and they would have said "stop" if they
   * meant stop.
   */
  adjustVolume(direction: "quieter" | "louder"): void {
    if (!this.#now) return;
    const before = this.#now.volume;
    const next = Math.max(15, Math.min(100, before + (direction === "louder" ? 20 : -20)));
    this.#now.volume = next;
    this.#d.sendControl({ type: "set_media_volume", volume: next });
    this.#d.log("info", "media volume", {
      direction,
      before,
      after: next,
      at_limit: next === before,
    });
  }

  /**
   * The device reports playback finished on its own — the stream ended, dropped,
   * or every fallback URL failed.
   *
   * WITHOUT THIS THE SESSION GOES DEAF. `#onFinal` returns early while media is
   * playing, so a track that ends without telling us leaves the flag stuck and
   * every later transcript is swallowed. The user talks and nothing happens,
   * indefinitely, and the only escape is guessing that "stop" still works.
   */
  endedOnDevice(): void {
    if (!this.#now) return;
    const { title, startedAt } = this.#now;
    this.#now = null;
    this.#d.log("info", "media ended on device", { title, played_ms: Date.now() - startedAt });
  }
}
