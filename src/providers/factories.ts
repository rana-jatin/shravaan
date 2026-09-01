/**
 * How a session gets its provider clients.
 *
 * This module exists to be the ONLY place outside `src/server.ts` that names a
 * concrete provider class. `Session` used to build all three itself — an ASR in
 * `#openAsr`, a TTS in `#openTts`, an LLM in the constructor — which meant
 * constructing a `Session` opened live WebSockets to Sarvam, which meant the turn
 * loop, barge-in, the filler policy and the echo-guard lifecycle had no tests at
 * all (docs/07-defect-register.md §9).
 *
 * These are the defaults. `SessionDeps.makeAsr` / `makeTts` / `makeLlm` override
 * them, and nothing but a test should.
 *
 * NOTE the shape of `AsrSpec`: a discriminated union rather than a bare options
 * object. Two reasons, both load-bearing. The default factory narrows on
 * `provider` without a cast, since the two clients take genuinely different
 * options. And a fake is TOLD which provider it is standing in for — which is
 * what a test of the failover ladder has to assert on, since the whole point of
 * D4 is that the standby needs telling about a language switch and the default
 * provider must not be.
 */

import type { Config } from "../config/env.ts";
import type { AsrClient } from "./asr-client.ts";
import { DeepgramAsr, type DeepgramAsrOptions } from "./deepgram-asr.ts";
import { SarvamAsr, type AsrOptions } from "./sarvam-asr.ts";
import type { LlmClient } from "./llm-client.ts";
import { SarvamLlm } from "./sarvam-llm.ts";
import type { TtsClient, TtsOptions } from "./tts-client.ts";
import { SarvamTts } from "./sarvam-tts.ts";

export type AsrSpec =
  | { provider: "sarvam"; opts: AsrOptions }
  | { provider: "deepgram"; opts: DeepgramAsrOptions };

export type AsrFactory = (cfg: Config, spec: AsrSpec) => AsrClient;
export type TtsFactory = (cfg: Config, opts: TtsOptions) => TtsClient;
export type LlmFactory = (cfg: Config) => LlmClient;

export const createAsr: AsrFactory = (cfg, spec) =>
  spec.provider === "deepgram" ? new DeepgramAsr(cfg, spec.opts) : new SarvamAsr(cfg, spec.opts);

export const createTts: TtsFactory = (cfg, opts) => new SarvamTts(cfg, opts);

export const createLlm: LlmFactory = (cfg) => new SarvamLlm(cfg);
