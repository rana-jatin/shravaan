/**
 * What a Session is handed, and the numbers that bound it.
 *
 * Split out of session.ts, which opened with 160 lines of declaration before
 * reaching the class they describe. Nothing here has behaviour: it is the
 * contract between server.ts, which builds a Session, and the turn loop, which
 * runs it — plus the five bounds that loop obeys.
 *
 * The optional-everything shape is deliberate and is what makes the turn loop
 * testable at all: a test supplies fake ASR, TTS and LLM clients through
 * makeAsr/makeTts/makeLlm and never opens a socket. See providers/factories.ts
 * and docs/07-defect-register.md section 9.
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import type { JsonContext, LanguageCode, Profile } from "@sp-i/shared/domain/types.ts";
import type { SessionStore } from "../store/session-store.ts";
import type { MemWriteStream } from "../memory/stream.ts";
import type { LongTermStore } from "../memory/long-term-store.ts";
import type { HoldingAudio } from "../audio/holding-audio.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { EmergencyAlerter } from "../tools/emergency.ts";
import type { AsrFactory, LlmFactory, TtsFactory } from "../providers/factories.ts";

export type DeviceLink = {
  sendAudio(pcm: Buffer): void;
  sendControl(msg: Record<string, unknown>): void;
  close(reason: string): void;
};

export type SessionDeps = {
  cfg: Config;
  device: DeviceLink;
  uid: string;
  /** Resume an existing session within its idle window. Omit to start fresh. */
  sid?: string | undefined;
  store?: SessionStore | undefined;
  /** Fire-and-forget memory writes. Omit to run without long-term memory. */
  memStream?: MemWriteStream | undefined;
  profile?: Profile | undefined;
  localeHint?: LanguageCode | undefined;
  /** Tools this deployment offers. Entitlement-filtered per user at offer time. */
  tools?: ToolRegistry | undefined;
  /**
   * Long-term memory, for the two tools that read it (`recall`, `forget_this`).
   * The turn path still never queries it on its own — see #3.9. Omit and those
   * tools report an empty memory rather than failing.
   */
  longTerm?: LongTermStore | undefined;
  /** Fetches JSON context from our backend. Read-only to the agent. */
  fetchContext?: ((uid: string) => Promise<JsonContext | null>) | undefined;
  /**
   * Pre-rendered apology audio for a TTS outage — the one message that cannot be
   * synthesised, because synthesis is what broke (slice 8).
   */
  holdingAudio?: HoldingAudio | undefined;
  /**
   * Emergency contacts. Omit and the alarm path is inert — both the local
   * matcher and the `raise_alarm` tool — because a companion that recognises
   * "help" and has nowhere to send it is worse than one that does not listen
   * for it: it would say help is coming when nothing is.
   */
  alerter?: EmergencyAlerter | undefined;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;

  /**
   * The provider seam. Defaults to the real clients; tests pass fakes.
   *
   * Without these, constructing a `Session` opens live WebSockets to Sarvam, and
   * the most intricate logic in the system — the turn loop, barge-in, the filler
   * policy, the echo-guard lifecycle — can only be exercised by hand. See
   * docs/07-defect-register.md §9.
   */
  makeAsr?: AsrFactory | undefined;
  makeTts?: TtsFactory | undefined;
  makeLlm?: LlmFactory | undefined;
  /**
   * Clock and jitter for the LLM retry path. Real time and `Math.random` by
   * default.
   *
   * Injected because `LLM_RETRY` uses full jitter, so the first delay is uniform
   * over [0, 250 ms) — and the retry filler fires only once
   * `elapsedMs + delayMs` crosses LLM_FILLER_AFTER_MS. Against real jitter that
   * is a coin toss, so "says one thing after 600 ms of silence" is not otherwise
   * assertable without both waiting and flaking. `withBackoff` already takes all
   * three (shared/src/domain/backoff.ts); this is only a way to reach them.
   */
  clock?:
    | {
        now?: (() => number) | undefined;
        sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
        rand?: (() => number) | undefined;
      }
    | undefined;
};

/**
 * Bounded so a model that keeps calling tools cannot hold a live conversation
 * open indefinitely. The user is waiting in real time.
 */
export const MAX_TOOL_ROUNDS = 3;

/**
 * How long a retrying turn may stay silent before we say something. Below this
 * the retry is invisible and a filler would only make a fast turn feel slow;
 * above it the user is sitting in dead air wondering if we are still here.
 */
export const LLM_FILLER_AFTER_MS = 600;

/** Consecutive ASR socket failures before we stop reconnecting and admit it. */
export const MAX_ASR_REOPENS = 4;

/**
 * Consecutive turns that produce nothing before we stop claiming to be a
 * conversation. Three, not one: a 429 is per-account and transient, and closing
 * a companion session over one unlucky minute is its own failure.
 */
export const MAX_LLM_TURN_FAILURES = 3;

/**
 * Time for the closing message to actually reach the device before teardown.
 * Generous on purpose: cutting our own apology off mid-word to save three
 * seconds is the exact failure this whole slice exists to avoid.
 */
export const GOODBYE_DRAIN_MS = 4000;

/**
 * The stable prefix. Kept byte-identical across turns so Sarvam's cached-input
 * tier applies — see #profileBlock, which appends to it rather than editing it.
 *
 * THE LAST TWO LINES ARE LOAD-BEARING AND WERE ARRIVED AT BY MEASUREMENT.
 *
 * A tool call that streams no text leaves the user in silence until the result
 * arrives. The model answering that itself is strictly better than our filler:
 * it is specific to what was asked, and it is fluent in all eleven languages
 * where nine of our own progress lines are still placeholder text.
 *
 * Getting it took more than asking politely. Measured, preamble rate over runs
 * that actually called a tool:
 *
 *   no instruction at all                        0/9
 *   polite instruction, mid-prompt               0/3
 *   forceful imperative alone                    1/3
 *   few-shot priming messages alone              0/3
 *   few-shot priming + forceful imperative       6/8
 *   forceful imperative + inline example         7/9   ← this
 *
 * Two findings worth keeping. Describing the behaviour does almost nothing;
 * describing it forcefully AND showing it works. And the example does not need
 * to be a real priming message — an inline one performs the same and avoids
 * putting an invented exchange into the conversation history, where the model
 * could later refer back to a day that never happened.
 *
 * At ~78% this is an improvement, not a guarantee. Roughly one tool turn in four
 * still starts in silence, which is why the filler floor in `speakFiller`
 * remains and must not be removed on the strength of this.
 *
 * ⚠ EVERY FIGURE ABOVE WAS MEASURED ON `sarvam-105b`, WHICH WE NO LONGER RUN.
 *
 * Re-measured twice on `sarvam-105b-conversations` with this exact prompt and
 * the same nine asks: **2/9 — 22%**, identical across both runs. Both preambles
 * were the Hindi asks; all five English asks called silently. The prompt is
 * tuned to a model we replaced, and re-tuning it against this one is open work.
 *
 * It matters much less than the inversion suggests, because the silence it
 * covers collapsed with it: an un-preambled tool turn is now quiet for a median
 * of 1.05 s (0.64–1.73) against ~12.8 s before. The filler floor still stands —
 * it is now carrying four tool turns in five rather than one in five.
 */
export const SYSTEM_PROMPT = [
  "You are a warm, attentive companion. Keep replies short and conversational —",
  "one or two sentences unless asked for more. You are being spoken aloud, so",
  "avoid lists, markdown, and anything that only works on a page.",
  "Reply in the same language the user is speaking. If they mix languages,",
  "mix them back naturally.",
  "IMPORTANT: never call a tool silently. Before every tool call you must first",
  "write one short spoken sentence telling the user what you are about to do,",
  "then make the call. For example, asked what day it is, you would say",
  '"Let me have a look." and call get_time in the same turn — the sentence',
  "first, then the call.",
].join(" ");
