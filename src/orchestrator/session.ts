/**
 * One conversation session. Owns turn state, the speakability gates, streaming
 * and barge-in.
 *
 * SCOPE — slices 1, 2 (server half), 3, 4, 6 and 7. Deliberately NOT here:
 * device-side AEC, wake word.
 *
 * The session PRODUCES memory events and CONSUMES a distilled profile; it never
 * queries long-term memory itself. Distillation lives in the worker, off the turn
 * path (src/memory/worker.ts). See docs/04-milestones.md
 *
 * BARGE-IN follows Sarvam's own documented rule: trigger on vad.speech_start or
 * early partials, NEVER on transcript.final. Note their guidance assumes a
 * telephony leg where the carrier already cancelled echo — on an open-air device
 * that assumption evaporates and AEC is ours (docs/adr/0007-audio-front-end.md).
 */

import { randomUUID } from "node:crypto";
import { resolveCopy } from "../copy/refusals.ts";
import { resolveFallback, resolveFiller, resolveProgress } from "../copy/fillers.ts";
import {
  blocksLlm,
  endsSession,
  gate1PreConnect,
  gate2FirstDetection,
  gate3Switch,
} from "../domain/gate.ts";
import { ClauseChunker } from "../domain/clause-chunker.ts";
import { EchoGuard } from "../domain/echo-guard.ts";
import { isSpeakable, normalizeLanguage } from "../domain/languages.ts";
import { transition } from "../domain/turn-state.ts";
import { TURN_WINDOW } from "../domain/redis-keys.ts";
import { LLM_RETRY, withBackoff } from "../domain/backoff.ts";
import { DEGRADATIONS, DegradationLedger, type DegradationKey } from "../domain/degradation.ts";
import { standbyFor } from "../domain/asr-failover.ts";
import { moodTrend } from "../domain/care-signals.ts";
import { ASR_STABLE_MS, reopenDecision } from "../domain/asr-reopen.ts";
import type {
  FactKind,
  GateDecision,
  JsonContext,
  LanguageCode,
  MemWriteEvent,
  MessageKey,
  Profile,
  SessionState,
  Turn,
  TurnPhase,
} from "../domain/types.ts";
import type { AsrClient } from "../providers/asr-client.ts";
import { createAsr, createLlm, createTts, type AsrSpec } from "../providers/factories.ts";
import {
  RateLimitError,
  EmptyCompletionError,
  isRetryableTransport,
  type ChatMessage,
  type LlmClient,
  type StreamChunk,
  type ToolChoice,
} from "../providers/llm-client.ts";
import type { TtsClient } from "../providers/tts-client.ts";
import { NullSessionStore, type SessionStore } from "../store/session-store.ts";
import { matchMediaIntent } from "../copy/stop-intent.ts";
import { EMERGENCY_ACK, EMERGENCY_FAILED, matchEmergency } from "../copy/emergency-intent.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { SessionToolHost, ToolResult } from "../tools/types.ts";
import {
  GOODBYE_DRAIN_MS,
  LLM_FILLER_AFTER_MS,
  MAX_ASR_REOPENS,
  MAX_LLM_TURN_FAILURES,
  MAX_TOOL_ROUNDS,
  type SessionDeps,
} from "./session-deps.ts";
import { buildMessages } from "./prompt.ts";
import { MediaController } from "./media-controller.ts";

// Re-exported so server.ts, the tests and scripts/ keep importing these from
// the module they have always come from. Splitting the file is not a reason to
// break every caller.
export { SYSTEM_PROMPT } from "./session-deps.ts";
export type { DeviceLink, SessionDeps } from "./session-deps.ts";

export class Session {
  readonly sid: string;
  #phase: TurnPhase = "idle";
  #state: SessionState;
  /** Newest-first window, mirroring the Redis list. */
  #turns: Turn[] = [];
  #resumed = false;
  /** Warmed from the store at session open; the only long-term memory on the turn path. */
  #profile: Profile | null = null;
  #asr: AsrClient | null = null;
  #tts: TtsClient | null = null;
  readonly #llm: LlmClient;
  readonly #chunker = new ClauseChunker();
  readonly #echo: EchoGuard;
  readonly #store: SessionStore;
  readonly #tools: ToolRegistry | null;
  readonly #executor: ToolExecutor | null;
  /** Read-only backend data. NOT memory — see docs/01-architecture.md section 1. */
  #jsonContext: JsonContext | null = null;
  #fillerIndex = 0;
  /**
   * Has anything already been said in the current tool round — either by the
   * model preambling its own call, or by a filler that has already fired?
   * Reset per round; see `speakFiller` in the constructor.
   */
  #roundSpoke = false;
  #turnAbort: AbortController | null = null;
  #firstDetectionDone = false;
  #closed = false;
  /**
   * What is playing on the device, if anything. Not a TurnPhase yet — see the
   * note in #onFinal. A formal `media_playing` phase belongs in turn-state.ts,
   * but that file is shared and this lands first as session-local state.
   */
  readonly #media: MediaController;
  /** Live TTS pace, adjustable mid-conversation by the `set_speaking_pace` tool. */
  #pace: number;
  /**
   * `end_conversation` fired. Honoured after the reply drains, never mid-word —
   * the farewell is the last thing the user hears and cutting it is the failure
   * the whole goodbye path exists to avoid.
   */
  #endRequested: string | null = null;

  // --- slice 8 ---------------------------------------------------------------
  /** What is currently broken. Mirrored into state.degraded. */
  #ledger!: DegradationLedger;
  #asrReopens = 0;
  #asrReopenTimer: NodeJS.Timeout | null = null;
  /** Consecutive turns that produced no reply. Reset by any turn that works. */
  #llmFailures = 0;
  /** Set once a mute-severity failure has been announced, so we say it once. */
  #terminating = false;

  readonly #d: SessionDeps;

  constructor(deps: SessionDeps) {
    this.#d = deps;
    this.sid = deps.sid ?? randomUUID();
    this.#llm = (deps.makeLlm ?? createLlm)(deps.cfg);
    this.#echo = new EchoGuard(deps.cfg.echoGuard);
    this.#store = deps.store ?? new NullSessionStore();
    this.#tools = deps.tools ?? null;
    this.#pace = deps.cfg.ttsPace;
    this.#media = new MediaController({
      sendControl: (msg) => deps.device.sendControl(msg),
      defaultVolume: deps.cfg.musicVolume,
      log: (level, msg, extra) => this.#log(level, msg, extra),
    });
    this.#executor = this.#tools
      ? new ToolExecutor({
          registry: this.#tools,
          uid: deps.uid,
          sid: this.sid,
          host: this.#host(),
          speakFiller: (lang, progressKey) => {
            // ONE progress line per round, and none at all if something has
            // already been said in it.
            //
            // The round guard is the load-bearing half. Calls run concurrently
            // now (#runTools), so two slow tools reach their thresholds
            // independently and would speak two fillers back to back — "One
            // moment." "Let me check." — which sounds like a stutter rather
            // than patience.
            //
            // The already-spoke half carries most of the traffic. Under the
            // current prompt the model announces its own call about 78% of the
            // time (see SYSTEM_PROMPT), and that line is better than ours —
            // specific to the question, and fluent in the nine languages where
            // our progress copy is still placeholder. Following it with "one
            // moment" would be padding, so we stay quiet and let it stand.
            //
            // The remaining ~22% is why this is a floor and not a fallback.
            if (this.#roundSpoke) return;
            this.#roundSpoke = true;

            // Fillers rotate so a companion that waits often does not sound
            // like a loop. The tool's own line is used when it has one.
            this.#emitToTts(
              progressKey
                ? resolveProgress(progressKey, lang, this.#fillerIndex++)
                : resolveFiller(lang, this.#fillerIndex++),
            );
            this.#tts?.flush();
          },
          invalidateContext: async () => {
            await this.#store.invalidateContext(deps.uid);
          },
          ...(deps.log ? { log: deps.log } : {}),
        })
      : null;

    const now = new Date().toISOString();
    const seed = this.#resolveSeed();
    this.#state = {
      sid: this.sid,
      user_id: deps.uid,
      language: seed.code,
      language_source: seed.source,
      turn_no: 0,
      agent_speaking: false,
      last_tool: null,
      slots: {},
      started_at: now,
      last_activity_at: now,
      asr_provider: "sarvam",
      degraded: [],
      switch_declined_acknowledged: false,
    };

    // The ledger owns `degraded`; nothing else pushes to that array. Keeping one
    // writer is what stops the same key appearing four times in the incident log
    // of a session where Redis flapped four times.
    this.#ledger = new DegradationLedger([], (keys) => {
      this.#state.degraded = keys;
    });
  }

  /** What the session has lost, and whether it can still hold a conversation. */
  get degraded(): DegradationKey[] {
    return this.#ledger.list();
  }

  /** True when this session picked up an existing thread from the store. */
  get resumed(): boolean {
    return this.#resumed;
  }

  /** Newest-first, as stored. */
  get turns(): readonly Turn[] {
    return this.#turns;
  }

  get state(): Readonly<SessionState> {
    return this.#state;
  }
  get phase(): TurnPhase {
    return this.#phase;
  }

  /**
   * The session as a tool sees it — see SessionToolHost.
   *
   * Built once and handed to the executor. Every method is bound to this
   * session, so a tool cannot reach across to another conversation, and the
   * surface is narrow enough to read in one sitting: no socket, no ledger, no
   * turn window beyond the last reply.
   */
  #host(): SessionToolHost {
    return {
      lastAgentReply: () => {
        // #turns is newest-first, and the user's turn is recorded before the
        // reply is composed — so the most recent agent entry is the one before
        // the question currently being answered.
        const last = this.#turns.find((t) => t.role === "agent" && t.text.trim() !== "");
        return last?.text ?? null;
      },

      requestLanguage: (raw: string) => {
        const code = normalizeLanguage(raw);
        if (!code) {
          return {
            switched: false,
            language: this.#state.language,
            reason: "unknown_language" as const,
          };
        }
        if (code === this.#state.language) {
          return { switched: false, language: code, reason: "already_speaking_it" as const };
        }
        if (!isSpeakable(code)) {
          // Same answer gate 3 gives, in the same reviewed words. A tool must
          // not become a second, sloppier way to refuse a language.
          if (!this.#state.switch_declined_acknowledged) {
            this.#state.switch_declined_acknowledged = true;
            this.#speak(resolveCopy("gate.switch_declined", this.#state.language).text);
          }
          this.#log("info", "language switch declined via tool", { requested: code });
          return {
            switched: false,
            language: this.#state.language,
            reason: "not_speakable" as const,
          };
        }
        this.#setLanguage(code, "user_stated");
        return { switched: true, language: code };
      },

      pace: () => this.#pace,
      setPace: (next: number) => {
        // Bulbul's own range is undocumented; these bounds are about
        // intelligibility rather than the API. Below 0.6 the voice drags enough
        // to sound broken, above 1.4 it stops being restful, which is the point
        // of the product.
        const clamped = Math.min(1.4, Math.max(0.6, Math.round(next * 100) / 100));
        this.#pace = clamped;
        this.#tts?.reconfigure({ pace: clamped });
        this.#log("info", "speaking pace changed", { pace: clamped });
        return clamped;
      },

      requestEnd: (reason: string) => {
        this.#endRequested = reason;
      },

      rememberFact: (text: string, kind: FactKind) => {
        this.#emitMemWrite({
          kind: "explicit_recall",
          tid: this.#state.turn_no,
          user_text: text,
          language: this.#state.language,
          hints: { stated_preference: true, emotional_salience: "high" },
        });
        this.#log("info", "explicit memory write", { kind, chars: text.length });
      },

      forgetFacts: async (subject: string) => {
        const store = this.#d.longTerm;
        if (!store) return { forgotten: 0, texts: [] };

        const hits = await store.search(this.#d.uid, subject, 5);
        // Only what clearly matches. A vague "forget about my sister" must not
        // quietly take out five neighbouring facts — over-forgetting is
        // unrecoverable in a way that under-forgetting is not, and the user can
        // always ask again more precisely.
        const strong = hits.filter((h) => h.score >= 0.5);
        for (const h of strong) await store.softDelete(h.fact.id, "user_requested");
        this.#log("info", "facts forgotten at user request", {
          matched: hits.length,
          forgotten: strong.length,
        });
        return { forgotten: strong.length, texts: strong.map((h) => h.fact.text) };
      },

      recallFacts: async (query: string, limit: number) => {
        const store = this.#d.longTerm;
        if (!store) return [];
        const hits = await store.search(this.#d.uid, query, limit);
        return hits.map((h) => ({ text: h.fact.text, score: Math.round(h.score * 100) / 100 }));
      },

      recentMood: async (sessions: number) => {
        const store = this.#d.longTerm;
        if (!store) return null;
        // Episodes we already hold. The analysis that produced these ran in the
        // memory worker hours ago; nothing on this turn leaves the process.
        const episodes = await store.listEpisodes(this.#d.uid, sessions);
        return moodTrend(episodes);
      },

      timezone: () => this.#jsonContext?.identity.timezone ?? this.#d.cfg.defaultTimezone,

      playMedia: (req) => this.#media.start(req),

      stopMedia: (reason: string) => this.#media.stop(reason),
    };
  }

  /** True while a station or track is playing on the device. */
  get mediaPlaying(): boolean {
    return this.#media.playing;
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
  mediaEnded(): void {
    this.#media.endedOnDevice();
  }

  #resolveSeed() {
    const profileLang = this.#d.profile?.preferred_language;
    if (profileLang) return { code: normalizeLanguage(profileLang)!, source: "profile" as const };
    if (this.#d.localeHint) {
      return { code: normalizeLanguage(this.#d.localeHint)!, source: "context" as const };
    }
    return { code: this.#d.cfg.defaultSeedLanguage, source: "default" as const };
  }

  /**
   * Open the session. Runs GATE 1 before any socket is created — refusing here
   * costs nothing and saves a connection against a 20-socket ceiling.
   */
  async start(): Promise<void> {
    await this.#restore();

    const g1 = gate1PreConnect(this.#state.language);
    this.#log("info", "gate1", { seed: this.#state.language, action: g1.action });

    if (g1.action !== "proceed") {
      await this.#refuse(g1);
      return;
    }

    this.#openTts(this.#state.language);
    this.#openAsr();
    this.#apply({ type: "session_open" });
    await this.#persistState();
  }

  /**
   * Resume within the idle window, or start fresh.
   *
   * A store outage is NOT fatal here: we fall back to a clean stateless session
   * and mark it degraded. The companion becomes shallow but stays alive, which
   * is the specified trade (docs/01-architecture.md section 6).
   */
  async #restore(): Promise<void> {
    this.#profile = this.#d.profile ?? null;

    try {
      const ctx = await this.#store.loadForTurn(this.sid, this.#d.uid, TURN_WINDOW);
      if (ctx.profile) this.#profile = ctx.profile;

      // JSON context: cached copy first, backend on a miss. Fetched once at
      // session open and refreshed only when a tool mutates it.
      this.#jsonContext = await this.#store.loadContext(this.#d.uid);
      if (!this.#jsonContext) {
        this.#jsonContext = await this.#fetchContext();
        if (this.#jsonContext) await this.#store.saveContext(this.#jsonContext);
      }

      if (ctx.state) {
        this.#state = ctx.state;
        this.#turns = ctx.turns;
        this.#resumed = true;
        // A resumed session inherits whatever was still broken when it paused,
        // and the ledger takes the array over from here. Starting clean would
        // hide a degradation that has been running for an hour.
        this.#ledger = new DegradationLedger(ctx.state.degraded, (keys) => {
          this.#state.degraded = keys;
        });
        this.#firstDetectionDone = ctx.turns.length > 0;
        this.#log("info", "session resumed", {
          turns: ctx.turns.length,
          turn_no: ctx.state.turn_no,
          language: ctx.state.language,
        });
        return;
      }

      // No stored state, but a profile may still seed the language.
      if (this.#profile?.preferred_language) {
        const code = normalizeLanguage(this.#profile.preferred_language);
        if (code) {
          this.#state.language = code;
          this.#state.language_source = "profile";
        }
      }
    } catch (err) {
      this.#markStoreDegraded(err);
    }
  }

  async #persistState(): Promise<void> {
    try {
      this.#state.last_activity_at = new Date().toISOString();
      await this.#store.saveState(this.#state);
      await this.#store.touch(this.sid);
    } catch (err) {
      this.#markStoreDegraded(err);
    }
  }

  /**
   * Mark a degradation and log the transition ONCE.
   *
   * The "once" is the point. A flapping dependency logs on every turn otherwise,
   * and the line that says what the user is actually losing gets buried under a
   * thousand copies of itself.
   */
  #degrade(key: DegradationKey, extra: Record<string, unknown> = {}): void {
    if (!this.#ledger.mark(key)) return;
    const spec = DEGRADATIONS[key];
    this.#log(spec.severity === "mute" ? "error" : "warn", "degraded", {
      key,
      severity: spec.severity,
      lost: spec.lost,
      ...extra,
    });
  }

  #recover(key: DegradationKey): void {
    if (this.#ledger.clear(key)) this.#log("info", "recovered", { key });
  }

  #markStoreDegraded(err: unknown): void {
    this.#degrade("store_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  #openAsr(provider: "sarvam" | "deepgram" = "sarvam"): void {
    const spec: AsrSpec =
      provider === "deepgram"
        ? {
            provider,
            opts: {
              // Flux wants a bare primary subtag. Only reached for hi-IN / en-IN.
              languageHint: this.#state.language.split("-")[0]!,
            },
          }
        : {
            provider,
            // Auto-detect on the first turn so the user's actual language wins
            // over the seed. The token itself is unresolved in Sarvam's docs
            // (docs/05 Q1).
            opts: {
              languageCode: this.#d.cfg.asrAutodetectToken,
              mode: "codemix",
              returnTimestamps: true,
            },
          };

    const asr = (this.#d.makeAsr ?? createAsr)(this.#d.cfg, spec);

    // Opening proves nothing. Sarvam accepts the upgrade and only then rejects a
    // bad parameter, so a doomed socket fires `open` exactly like a healthy one.
    // Resetting the failure count here made both thresholds in #onAsrDown
    // unreachable — see src/domain/asr-reopen.ts for what that cost.
    let openedAt: number | null = null;
    asr.on("open", () => {
      openedAt = Date.now();
    });
    asr.on("speech_start", () => this.#onSpeechStart());
    asr.on("partial", (t) => this.#onPartial(t.text));
    asr.on("final", (t) => void this.#onFinal(t.text, t.language, t.languageProbability));
    asr.on("error", (e) => this.#log("error", "asr", { provider, err: e.message }));
    asr.on("close", ({ code }) => {
      if (this.#closed || this.#terminating) return;
      // Whether this socket ever worked is decided here, while we still know how
      // long it lived. A connection that carried a conversation for a while and
      // then dropped is a new incident; one rejected on connect is the same
      // incident continuing.
      const stable = openedAt !== null && Date.now() - openedAt >= ASR_STABLE_MS;
      this.#log("warn", "asr closed", { provider, code, stable });
      this.#onAsrDown(`socket closed with ${code}`, stable);
    });

    asr.connect();
    this.#asr = asr;
    this.#state.asr_provider = provider;
  }

  #openTts(language: LanguageCode): void {
    const tts = (this.#d.makeTts ?? createTts)(this.#d.cfg, {
      languageCode: language,
      speaker: this.#d.cfg.ttsSpeaker,
      pace: this.#d.cfg.ttsPace,
    });
    tts.on("audio", (buf) => {
      // First audio of a reply starts the echo suppression window — the clock
      // begins when sound leaves for the device, not when the LLM finished.
      if (!this.#echo.isSpeaking) this.#echo.onPlaybackStart();
      this.#d.device.sendAudio(buf);
    });
    tts.on("done", () => {
      this.#echo.onPlaybackEnd();
      this.#apply({ type: "playback_drained" });
    });
    tts.on("error", (e) => this.#log("error", "tts", { err: e.message }));

    // A reconnect is routine — Bulbul closes the socket after ~1 min idle and a
    // companion pauses for far longer than that. Logged, not degraded.
    tts.on("reconnecting", ({ attempt, delayMs }) =>
      this.#log("info", "tts reconnecting", { attempt, delayMs }),
    );

    // Speech that went stale while the socket was down. The reply was composed
    // and never heard, so the turn record above it is now a lie by omission —
    // worth a warning even though the conversation survives.
    tts.on("dropped", ({ chars, ageMs }) =>
      this.#log("warn", "tts dropped stale speech", {
        chars,
        ageMs,
        note: "spoken this late it would answer a question the user has moved past",
      }),
    );

    // The accepted single point of failure, arriving. No Indic TTS failover
    // exists anywhere in the stack — docs/adr/0005-tts-provider-split.md.
    tts.on("unavailable", (err) => this.#loseVoice(err));

    tts.connect();
    this.#tts = tts;
  }

  // ---------------------------------------------------------------------------
  // Slice 8 — what happens when a dependency goes.
  //
  // Three of these end the session. They all funnel through #terminate() so that
  // the closing message is said EXACTLY ONCE: a Bulbul outage takes the TTS
  // socket down, which drops the ASR reply path, which looks like a second
  // failure, and a naive implementation apologises three times on the way out.
  // ---------------------------------------------------------------------------

  /**
   * The ASR socket dropped.
   *
   * Note the deliberate reluctance to fail over on the first failure. Deepgram
   * publishes EU and AU endpoints and no India region, while Sarvam's pitch
   * includes India data residency — so a failover moves a user's voice out of the
   * country. Doing that in response to one transient socket close would be a
   * compliance decision made by a network blip. We reconnect first, and only
   * relocate if Sarvam genuinely will not come back.
   */
  #onAsrDown(reason: string, socketWasStable = false): void {
    if (this.#closed || this.#terminating || this.#asrReopenTimer) return;

    this.#asr?.close();
    this.#asr = null;

    const standby = standbyFor(this.#state.language, {
      configured: this.#d.cfg.asrFailoverEnabled && this.#d.cfg.deepgramApiKey !== null,
      current: this.#state.asr_provider,
    });

    const decision = reopenDecision({
      reopens: this.#asrReopens,
      socketWasStable,
      standbyAvailable: standby.available,
      maxReopens: MAX_ASR_REOPENS,
      // The reopen delay is a real timer, so its jitter is the one thing that
      // decides how long a test of the failover ladder actually takes.
      ...(this.#d.clock?.rand ? { rand: this.#d.clock.rand } : {}),
    });
    this.#asrReopens = decision.reopens;

    if (decision.action === "failover") {
      this.#degrade("asr_failover_active", {
        from: reason,
        language: this.#state.language,
        residency: "audio now leaves India — Deepgram publishes no India region",
      });
      this.#openAsr("deepgram");
      return;
    }

    if (decision.action === "lose_hearing") {
      this.#loseHearing(standby.available ? reason : `${reason} (no standby: ${standby.detail})`);
      return;
    }

    const delayMs = decision.delayMs;
    this.#log("warn", "reopening asr", {
      attempt: this.#asrReopens,
      delayMs,
      standby: standby.available ? "available" : standby.reason,
    });
    this.#asrReopenTimer = setTimeout(() => {
      this.#asrReopenTimer = null;
      if (!this.#closed && !this.#terminating) this.#openAsr(this.#state.asr_provider);
    }, delayMs);
    this.#asrReopenTimer.unref?.();
  }

  /** Bulbul is gone. The accepted single point of failure, actually happening. */
  #loseVoice(err: Error): void {
    this.#terminate("tts_unavailable", err.message);
  }

  /** Nothing the user says reaches us. We can still say why. */
  #loseHearing(reason: string): void {
    this.#terminate("asr_unavailable", reason);
  }

  /** The LLM is unreachable after backoff. Distinct from a slow turn. */
  #loseThinking(err: unknown): void {
    this.#terminate("llm_unavailable", err instanceof Error ? err.message : String(err));
  }

  /**
   * Say the one thing worth saying, then close.
   *
   * Idempotent by design — see the block comment above. Anything already in
   * flight is abandoned first: a half-composed reply arriving after the goodbye
   * is worse than no reply at all.
   */
  #terminate(key: DegradationKey, detail: string): void {
    if (this.#terminating || this.#closed) return;
    this.#terminating = true;
    this.#degrade(key, { detail });

    this.#turnAbort?.abort();
    this.#chunker.reset();
    void this.#executor?.clearAll();

    const spec = DEGRADATIONS[key];
    if (spec.message_key) {
      this.#sayGoodbye(spec.message_key, spec.requires_prerendered_audio === true);
    }

    setTimeout(() => this.close(key), GOODBYE_DRAIN_MS).unref?.();
  }

  /**
   * Speak the closing line, synthesising it if we still can and playing bytes off
   * disk if we cannot.
   *
   * The pre-rendered branch is the whole reason src/audio/holding-audio.ts
   * exists. If it is missing we say so loudly in the logs, because the user just
   * experienced the exact silent failure this system is built to never produce,
   * and the only trace will be this line.
   */
  #sayGoodbye(key: MessageKey, mustBePreRendered: boolean): void {
    const language = this.#state.language;

    if (!mustBePreRendered && this.#tts) {
      this.#speak(resolveCopy(key, language).text);
      return;
    }

    const pcm = this.#d.holdingAudio?.get(key, language) ?? null;
    if (pcm) {
      this.#log("info", "playing pre-rendered holding audio", { key, language, bytes: pcm.length });
      this.#d.device.sendAudio(pcm);
      return;
    }

    this.#log("error", "no pre-rendered audio — closing in silence", {
      key,
      language,
      consequence: "the user hears nothing and is given no reason",
      fix: "npm run render:holding, then commit assets/holding/",
    });
    // Tell the device, even though nobody hears it. A device with a screen or a
    // light can still show something, and it is the only channel left.
    this.#d.device.sendControl({ type: "notice", key, language });
  }

  /** Device audio in. */
  pushAudio(pcm: Buffer): void {
    this.#asr?.sendAudio(pcm);
  }

  /**
   * Barge-in, stage one. Driven by vad.speech_start — never by transcript.final,
   * which arrives far too late to feel like an interruption.
   *
   * A bare VAD trigger is NOT sufficient while we are speaking: on an open-air
   * device it is as likely to be our own voice as the user's. The echo guard
   * decides, and by default defers to a transcript.
   */
  #onSpeechStart(): void {
    if (!this.#echo.isSpeaking) {
      this.#apply({ type: "speech_start" });
      return;
    }

    const d = this.#echo.onSpeechStart();
    if (!d.accept) {
      this.#log("debug", "barge-in withheld", { reason: d.reason, detail: d.detail });
      return;
    }
    this.#commitBargeIn("vad");
  }

  /**
   * Barge-in, stage two — and where echo is actually caught. Our own voice
   * returns as our own words, which is a signal no energy-based method has.
   */
  #onPartial(text: string): void {
    if (!this.#echo.isSpeaking) return;

    const d = this.#echo.onPartial(text);
    if (!d.accept) {
      if (d.reason === "self_echo") {
        this.#log("warn", "self-echo rejected — AEC is leaking", {
          detail: d.detail,
          heard: text.slice(0, 60),
        });
      }
      return;
    }
    this.#commitBargeIn("partial");
  }

  #commitBargeIn(trigger: "vad" | "partial"): void {
    this.#apply({ type: "speech_start" });
    this.#turnAbort?.abort();
    this.#chunker.reset();
    // Abandon in-flight tools too. A pending entry that outlives the turn makes
    // the agent claim it is still working on something the user interrupted.
    void this.#executor?.clearAll();
    this.#echo.onPlaybackEnd();
    this.#d.device.sendControl({ type: "clear_audio" });
    this.#log("info", "barge-in", { trigger });
  }

  async #onFinal(text: string, detected?: string, confidence?: number): Promise<void> {
    // A session on its way out still receives whatever the ASR had buffered.
    // Answering it would talk over our own goodbye.
    if (this.#closed || this.#terminating || text.trim() === "") return;

    // ⚠ FIRST. BEFORE EVERYTHING.
    //
    // Before the media short-circuit, before the language gate, before the
    // turn lock, before any request that can be rate-limited. Someone calling
    // for help must not be beaten to it by a gate that decided their language
    // was unsupported, or by a radio station playing over them, or by a lock
    // held by the turn they interrupted.
    //
    // This is the one path in the product where slow and wrong are the same
    // outcome. See src/copy/emergency-intent.ts for why it is a table rather
    // than a model call.
    if (this.#d.alerter) {
      const alarm = matchEmergency(text, this.#state.language);
      if (alarm) {
        await this.#raiseAlarm(text, alarm.kind, alarm.matched);
        return;
      }
    }

    // WHILE MEDIA PLAYS, two things are true at once and they pull opposite ways.
    //
    // "Stop" must be deterministic. It is matched locally, with no LLM round
    // trip, because an elderly user shouting at a device that will not stop is
    // the worst moment this product can produce — worse than any wrong answer,
    // because it is loud and they cannot escape it. That short-circuit is not
    // negotiable and runs first.
    //
    // But the rest of what they say must still REACH the companion. The first
    // version of this dropped every non-stop transcript, on the theory that the
    // ASR would otherwise transcribe the song's own lyrics and the model would
    // answer them. It does do that — but the cure was worse: asking for the
    // weather while the radio played got silence, and a companion that stops
    // listening the moment it starts entertaining you is not a companion.
    //
    // So lyrics reaching the model is now an accepted cost, bounded by
    // `restrictListeningDuringMedia` for a deployment that finds it intolerable.
    // The real fix is ducking the music on speech_start, which needs the device
    // side and does not exist yet.
    if (this.#media.playing) {
      const intent = matchMediaIntent(text, this.#state.language);
      if (intent === "stop") {
        this.#media.stop("user_asked");
        return;
      }
      if (intent === "quieter" || intent === "louder") {
        this.#media.adjustVolume(intent);
        return;
      }
    }
    if (this.#media.playing && this.#d.cfg.restrictListeningDuringMedia) {
      this.#log("info", "ignored while media playing", { text: text.slice(0, 60) });
      return;
    }

    this.#apply({ type: "speech_end", text });

    const decision = this.#runLanguageGate(detected, confidence);
    if (decision) {
      // GATE 2/3 blocked this turn. Critically, we return BEFORE the LLM call —
      // never spend a rate-limited request on a reply we cannot speak.
      if (blocksLlm(decision)) {
        await this.#refuse(decision);
        return;
      }
      if (decision.action === "decline_switch") {
        if (decision.message_key) {
          this.#state.switch_declined_acknowledged = true;
          this.#speak(resolveCopy(decision.message_key, decision.respond_in).text);
        }
        // Session continues in the previous language. Never terminate here.
        return;
      }
    }

    // One turn at a time per session. Without this, a barge-in can race a
    // completing turn into a corrupted window.
    const token = randomUUID();
    let held = false;
    try {
      held = await this.#store.acquireLock(this.sid, token);
    } catch (err) {
      this.#markStoreDegraded(err);
      held = true; // A store outage must not stop the conversation.
    }
    if (!held) {
      this.#log("warn", "turn skipped, lock held elsewhere");
      return;
    }

    try {
      this.#state.turn_no += 1;
      await this.#recordTurn({ role: "user", text, language: this.#state.language });
      await this.#respond(text);
    } finally {
      try {
        await this.#store.releaseLock(this.sid, token);
      } catch {
        // Lock expires on its own; nothing useful to do here.
      }
    }
  }

  /** Append to the capped window and keep the in-process copy in step. */
  async #recordTurn(
    partial: Pick<Turn, "role" | "text" | "language"> & Partial<Turn>,
  ): Promise<void> {
    const turn: Turn = {
      tid: this.#state.turn_no,
      at: new Date().toISOString(),
      ...partial,
    };
    this.#turns.unshift(turn);
    this.#turns = this.#turns.slice(0, TURN_WINDOW);

    try {
      await this.#store.appendTurn(this.sid, turn, TURN_WINDOW);
      await this.#persistState();
    } catch (err) {
      this.#markStoreDegraded(err);
    }
  }

  /**
   * Fire-and-forget append to mem:writes.
   *
   * NEVER awaited on the turn path and never allowed to throw into it: a failure
   * here degrades tomorrow's conversation, not today's turn. That asymmetry is
   * the entire reason the seam exists.
   */
  #emitMemWrite(event: Omit<MemWriteEvent, "event_id" | "sid" | "uid" | "at">): void {
    const stream = this.#d.memStream;
    if (!stream) return;

    const full: MemWriteEvent = {
      event_id: randomUUID(),
      sid: this.sid,
      uid: this.#d.uid,
      at: new Date().toISOString(),
      ...event,
    };

    void stream.append(full).catch((err: unknown) => {
      // The stream is expected to buffer rather than throw (see
      // src/memory/buffered-stream.ts), so reaching here means even the buffer
      // gave up. Today's conversation is unaffected; tomorrow's is thinner.
      this.#degrade("long_term_memory_unavailable", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * GATE 2 on the first detection, GATE 3 on every subsequent one.
   * Returns null when the turn may proceed untouched.
   */
  #runLanguageGate(detected?: string, confidence?: number): GateDecision | null {
    if (!this.#firstDetectionDone) {
      this.#firstDetectionDone = true;
      const d = gate2FirstDetection({
        detected,
        confidence,
        seed: this.#state.language,
        profileLanguage: this.#profile?.preferred_language,
      });
      this.#log("info", "gate2", { detected, action: d.action });

      if (d.action === "proceed" && d.verdict.status === "speakable") {
        this.#setLanguage(d.verdict.code, "detected", confidence);
        return null;
      }
      return d;
    }

    const { decision, pending_switch } = gate3Switch({
      detected,
      confidence,
      state: this.#state,
      profileLanguage: this.#profile?.preferred_language,
    });
    this.#state.pending_switch = pending_switch;

    if (decision.action === "proceed" && decision.verdict.status === "speakable") {
      // Both languages speakable — including Hindi<->English code-mixing, which
      // must never be treated as a decline.
      if (decision.verdict.code !== this.#state.language) {
        this.#setLanguage(decision.verdict.code, "detected", confidence);
      }
      return null;
    }
    if (decision.action === "fallback_to_seed") return null;
    return decision;
  }

  #setLanguage(code: LanguageCode, source: SessionState["language_source"], conf?: number): void {
    if (this.#state.language === code) return;
    this.#state.language = code;
    this.#state.language_source = source;
    if (conf !== undefined) this.#state.language_confidence = conf;
    // Voice follows the language. Whether the speaker sounds like the same
    // person across languages is undocumented — docs/05 Q2.
    this.#tts?.reconfigure({ languageCode: code });
    this.#log("info", "language switched", { to: code });
  }

  async #respond(userText: string): Promise<void> {
    this.#turnAbort?.abort();
    const abort = new AbortController();
    this.#turnAbort = abort;
    this.#chunker.reset();

    const messages = buildMessages(this.#turns, this.#profile, userText);

    // Declared out here so the interrupted and failed paths can both record what
    // was actually said. The window must reflect the conversation the user
    // HEARD, not the one we intended to have.
    let reply = "";
    let spokeAnything = false;
    let failure: unknown = null;
    /** Whether any tool round ran — a turn that acted is not a silent turn. */
    let ranAnyTool = false;
    /**
     * Failed calls from the most recent round, held rather than spoken.
     *
     * The old code spoke the localised fallback the instant a tool failed AND
     * fed the error back to the model, so the user heard our apology and then
     * the model's apology for the same failure. The error still goes back — the
     * model needs it to answer honestly — and this is the safety net for the
     * case where it then says nothing at all.
     */
    let unanswered: ToolResult[] = [];

    const speak = (text: string) => {
      for (const chunk of this.#chunker.push(text)) {
        if (!spokeAnything) {
          this.#apply({ type: "first_clause_ready" });
          spokeAnything = true;
        }
        this.#emitToTts(chunk);
      }
    };

    try {
      // Tool rounds. Bounded so a model that keeps calling tools cannot hold the
      // conversation open indefinitely — the user is waiting in real time.
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        let roundText = "";

        const offered = this.#tools ? this.#tools.schemasFor(this.#jsonContext) : [];

        // The last round must produce prose. `tool_choice: "none"` says exactly
        // that — verified honoured on sarvam-105b — and it is better than the
        // alternative of withdrawing the tool list, which changes the prompt
        // prefix mid-turn and invites the model to explain that it has lost
        // capabilities it appeared to have a moment ago.
        const toolChoice: ToolChoice = round < MAX_TOOL_ROUNDS ? "auto" : "none";

        // Retries live inside here and stop at the first chunk — see the method.
        const it = this.#llmStream(messages, offered, toolChoice, abort.signal, !spokeAnything);

        for (let res = await it.next(); !res.done; res = await it.next()) {
          if (abort.signal.aborted) break;
          const chunk = res.value;
          if (chunk.type === "text") {
            roundText += chunk.text;
            reply += chunk.text;
            speak(chunk.text);
          } else {
            calls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
          }
        }
        // The generator holds an open response body. A `break` above leaves it
        // dangling, so close it explicitly rather than waiting for GC.
        if (abort.signal.aborted) await it.return(undefined).catch(() => {});

        if (abort.signal.aborted || calls.length === 0) break;

        this.#apply({ type: "tool_dispatched" });
        // A turn that acted is not a silent turn, even if it never spoke. See
        // `saidNothing` at the end of this method.
        ranAnyTool = true;

        // Anything the model said before calling counts as having spoken for
        // this round — usually it has, since the prompt asks for it explicitly
        // and gets it about 78% of the time. The filler covers the rest.
        this.#roundSpoke = roundText.trim() !== "";

        const results = await this.#runTools(calls, abort.signal);
        this.#apply({ type: "tool_result" });
        unanswered = results.filter((r) => !r.ok);
        if (abort.signal.aborted) break;

        // Once per round, not once per call. A mutating tool invalidates the
        // cached JSON context, and the refetch is a full backend round trip
        // sitting inside a turn that is already over its latency budget —
        // paying for it twice because the model called two mutating tools is
        // pure waste.
        if (results.some((r) => r.ok && r.context_mutated)) {
          this.#jsonContext = await this.#fetchContext();
        }

        messages.push({
          role: "assistant",
          content: roundText,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
        for (const r of results) {
          messages.push({
            role: "tool",
            tool_call_id: r.call_id,
            content: JSON.stringify(r.ok ? r.data : { error: r.error.code }),
          });
        }
      }

      if (!abort.signal.aborted) {
        const tail = this.#chunker.flush();
        if (tail) {
          if (!spokeAnything) this.#apply({ type: "first_clause_ready" });
          this.#emitToTts(tail);
        }

        // The model was handed the tool error and still said nothing. The user
        // asked for something and is owed an answer either way, so the reviewed
        // per-language fallback is spoken here — the one place it cannot
        // duplicate whatever the model chose to say.
        if (!spokeAnything && unanswered.length > 0) {
          const first = unanswered[0]!;
          if (!first.ok) {
            this.#emitToTts(resolveFallback(first.error.spoken_fallback_key, this.#state.language));
            spokeAnything = true;
          }
        }

        this.#tts?.flush();
      }
    } catch (err) {
      failure = err;
    }

    const interrupted = abort.signal.aborted;

    if (reply.trim() !== "") {
      await this.#recordTurn({
        role: "agent",
        text: reply.trim(),
        language: this.#state.language,
        ...(interrupted ? { interrupted: true } : {}),
      });

      // Off the turn path. The user text is the one just recorded above it.
      this.#emitMemWrite({
        kind: "turn_completed",
        tid: this.#state.turn_no,
        user_text: userText,
        agent_text: reply.trim(),
        language: this.#state.language,
      });
    }

    /**
     * The turn ran to completion and the user heard nothing.
     *
     * `EmptyCompletionError` catches the common case — a stream that yields no
     * content at all now throws, and lands in the branch below. This catches
     * what survives that: content that arrived but amounted to nothing once the
     * chunker was done with it. Whitespace is the real shape, not a hypothetical
     * — `tool_choice: "required"` was observed returning 3,037 characters of
     * "\n  " before hitting the token cap.
     *
     * Without this it falls to `!failure` and is scored as a HEALTHY turn: the
     * consecutive-failure counter resets and a recovery is filed, so a run of
     * silent turns reads in the ledger as the LLM repeatedly getting better. A
     * turn that says nothing is a failed turn, whatever the transport thought.
     *
     * Tool rounds are exempt: `unanswered` above already speaks a fallback for a
     * failed tool, and a round that ran tools successfully and stayed quiet is
     * the model acting rather than talking, which is legitimate.
     */
    const saidNothing =
      !failure && !interrupted && !spokeAnything && reply.trim() === "" && !ranAnyTool;

    if (failure && !interrupted) {
      this.#onTurnFailed(failure, spokeAnything);
      this.#apply({ type: "playback_drained" });
    } else if (saidNothing) {
      this.#log("warn", "turn produced no speech", {
        turn_no: this.#state.turn_no,
        chars_received: reply.length,
      });
      this.#onTurnFailed(new Error("turn completed without speaking"), false);
      this.#apply({ type: "playback_drained" });
    } else if (!failure) {
      // A turn that completed is evidence the LLM is back. Recovery is as
      // reportable as failure, or the ledger only ever grows.
      this.#llmFailures = 0;
      this.#recover("llm_retrying");
    }

    // `end_conversation` fired during this turn. Honour it only now, so the
    // farewell the model composed is spoken in full — and drop it entirely if
    // the user interrupted, because someone who talks over a goodbye has not
    // finished the conversation.
    if (this.#endRequested !== null) {
      const reason = this.#endRequested;
      this.#endRequested = null;
      if (interrupted) {
        this.#log("info", "end request cancelled by barge-in", { reason });
      } else {
        this.#log("info", "ending at user request", { reason });
        setTimeout(() => this.close(reason), GOODBYE_DRAIN_MS).unref?.();
      }
    }
  }

  /**
   * Open the LLM stream, retrying ONLY until the first chunk arrives.
   *
   * That boundary is the interesting decision. Once a clause has been synthesised
   * the user has heard the start of a sentence; replaying the request would
   * produce a different completion and the bot would talk over its own opening.
   * So a 429 before first token is retryable, and a failure after it is not — it
   * becomes a truncated reply, recorded as what the user actually heard.
   *
   * Sarvam-105B's limit is 40 req/min on Starter and it is per ACCOUNT, not per
   * session ([ADR 0003](../../docs/adr/0003-llm.md)). When it trips it trips for
   * every live conversation at once, which is why the backoff is jittered — see
   * src/domain/backoff.ts.
   */
  async *#llmStream(
    messages: ChatMessage[],
    offered: ReturnType<ToolRegistry["schemasFor"]>,
    toolChoice: ToolChoice,
    signal: AbortSignal,
    maySpeakFiller: boolean,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    let fillerSpoken = false;

    const opened = await withBackoff(
      async () => {
        const it = this.#llm.stream(messages, {
          signal,
          ...(offered.length > 0 ? { tools: offered, toolChoice } : {}),
          // A divergent tool-call stream is a provider-contract problem, and the
          // only place it is visible is here. Losing it to a silent catch is
          // what made the `{}{}` bug expensive to find in the first place.
          onWarn: (msg, extra) => this.#log("warn", msg, extra),
        });
        // The fetch does not happen until the first pull, so this is what
        // actually surfaces a 429 and makes it retryable.
        const first = await it.next();
        return { it, first };
      },
      {
        policy: LLM_RETRY,
        // Real time and Math.random unless a test says otherwise. The filler
        // threshold below is measured against these, so they are the difference
        // between asserting the silence policy and waiting out a coin toss.
        now: this.#d.clock?.now,
        sleep: this.#d.clock?.sleep,
        rand: this.#d.clock?.rand,
        // A 500 or a malformed request will not fix itself in 250 ms, and
        // retrying it burns the same rate limit a 429 is already telling us
        // about. So this stays narrow — but it was previously narrower than the
        // failures that actually occur.
        //
        // Measured over 12 loaded calls: three empty completions, two dropped
        // sockets, and NOT ONE 429. Keying the retry on `RateLimitError` alone
        // meant every failure we actually saw skipped the retry entirely. The
        // 2.5 s budget in LLM_RETRY is what keeps this honest — and because that
        // budget counts elapsed time rather than sleep time, a slow empty
        // completion is abandoned rather than retried into more silence.
        retryable: (err) =>
          err instanceof RateLimitError ||
          err instanceof EmptyCompletionError ||
          isRetryableTransport(err),
        signal,
        onRetry: ({ attempt, delayMs, elapsedMs, err }) => {
          this.#degrade("llm_retrying");
          // The cause is the whole point of the entry: "rate limited", "said
          // nothing" and "socket died" are three different operational stories
          // that the ledger reason alone can no longer distinguish.
          this.#log("warn", "llm retry", {
            attempt,
            delayMs,
            elapsedMs,
            cause: err instanceof Error ? err.name : typeof err,
            detail: err instanceof Error ? err.message : undefined,
          });

          // Fill the silence only once it has become a silence. Below the
          // threshold the retry is invisible and speaking would make a fast
          // turn feel slow.
          if (!fillerSpoken && maySpeakFiller && elapsedMs + delayMs >= LLM_FILLER_AFTER_MS) {
            fillerSpoken = true;
            this.#emitToTts(resolveFiller(this.#state.language, this.#fillerIndex++));
            this.#tts?.flush();
          }
        },
      },
    );

    if (!opened.first.done) yield opened.first.value;
    yield* opened.it;
  }

  /**
   * A turn produced nothing.
   *
   * ONE failure is answered and survived: the user asked something and is owed a
   * reply, exactly as with a failed tool call, and silence after a "one moment"
   * filler is the worst of both worlds. Repeated failures are a different claim —
   * at that point we are not having a conversation and pretending otherwise
   * wastes the user's evening.
   */
  #onTurnFailed(failure: unknown, spokeAnything: boolean): void {
    this.#llmFailures += 1;

    if (failure instanceof RateLimitError) {
      this.#degrade("llm_retrying", { consecutive: this.#llmFailures });
    } else {
      this.#log("error", "llm", {
        consecutive: this.#llmFailures,
        err: failure instanceof Error ? failure.message : String(failure),
      });
    }

    if (this.#llmFailures >= MAX_LLM_TURN_FAILURES) {
      this.#loseThinking(failure);
      return;
    }

    // A partial reply already reached the user; appending an apology to half a
    // sentence reads worse than letting it stand.
    if (!spokeAnything) this.#speak(resolveCopy("degraded.turn_failed", this.#state.language).text);
  }

  /**
   * Run a round of tool calls — CONCURRENTLY.
   *
   * sarvam-105b returns multiple calls in one round (verified: "what time is it
   * and what's the weather" came back as two). Running them in sequence made the
   * user wait for the sum of the deadlines: two 8 s tools is 16 s of a live
   * conversation, and three rounds of that outlives anyone's patience. Run
   * together, a round costs the SLOWEST call instead of all of them.
   *
   * Each call still carries its own deadline and its own pending entry, so one
   * timing out neither cancels nor delays its siblings. `allSettled` rather than
   * `all` for the same reason — a handler that rejects outside the executor's
   * own catch must not discard the results of calls that succeeded.
   *
   * Failures are returned, not spoken. See `unanswered` in #respond for why.
   */
  async #runTools(
    calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    signal: AbortSignal,
  ): Promise<ToolResult[]> {
    if (!this.#executor) return [];
    const executor = this.#executor;

    const settled = await Promise.allSettled(
      calls.map((c) =>
        executor.execute(
          { call_id: c.id, name: c.name, args: c.args },
          { language: this.#state.language, jsonContext: this.#jsonContext, signal },
        ),
      ),
    );

    const results: ToolResult[] = [];
    for (const [i, outcome] of settled.entries()) {
      const c = calls[i]!;
      if (outcome.status === "rejected") {
        // The executor is written to resolve on every path, so this is a bug in
        // a handler that escaped it. Report it as a tool failure rather than
        // letting one bad tool take down the turn.
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        this.#log("error", "tool executor rejected", { tool: c.name, err: message });
        results.push({
          call_id: c.id,
          name: c.name,
          ok: false,
          elapsed_ms: 0,
          error: { code: "upstream_error", message, spoken_fallback_key: "tool.unavailable" },
        });
        continue;
      }

      const result = outcome.value;
      results.push(result);
      this.#state.last_tool = c.name;
      if (result.ok) {
        this.#log("info", "tool ok", { tool: c.name, ms: result.elapsed_ms });
      } else {
        this.#log("warn", "tool failed", {
          tool: c.name,
          code: result.error.code,
          ms: result.elapsed_ms,
        });
      }
    }
    return results;
  }

  async #fetchContext(): Promise<JsonContext | null> {
    if (!this.#d.fetchContext) return null;
    try {
      return await this.#d.fetchContext(this.#d.uid);
    } catch (err) {
      // Without context, entitlement-gated tools are withheld rather than
      // offered unverified. Fewer capabilities beats phantom ones.
      this.#log("warn", "json context fetch failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Raise the alarm, and say so.
   *
   * ORDER IS THE WHOLE DESIGN HERE.
   *
   * 1. Stop the music. The user has to be able to hear the answer, and a device
   *    playing a film song while someone lies on the floor is its own harm.
   * 2. SPEAK FIRST, before the email is even attempted. The send takes seconds
   *    over a mail relay; the reassurance cannot wait for it, and the words are
   *    what stops a frightened person shouting at the device.
   * 3. Send.
   * 4. If it failed, SAY SO. A companion that claims help is coming when it is
   *    not is worse than one with no alarm at all — it stops the user trying
   *    anything else. This is the reason the alerter returns a result instead
   *    of being fire-and-forget.
   *
   * The turn is deliberately not recorded and no lock is taken: an alarm is not
   * a conversational turn, and it must not be able to lose a race with one.
   */
  async #raiseAlarm(text: string, kind: string, matched: string): Promise<void> {
    const alerter = this.#d.alerter;
    if (!alerter) return;

    this.#log("warn", "EMERGENCY detected", {
      trigger: kind,
      matched,
      language: this.#state.language,
      text: text.slice(0, 120),
    });

    if (this.#media.playing) this.#media.stop("emergency");

    const language = this.#state.language;
    const ack = EMERGENCY_ACK[language] ?? EMERGENCY_ACK["en-IN"]!;
    this.#speak(ack.replace("{names}", alerter.names));

    const result = await alerter.raise({
      uid: this.#d.uid,
      sid: this.sid,
      language,
      timezone: this.#jsonContext?.identity.timezone ?? this.#d.cfg.defaultTimezone,
      spoken: text,
      trigger: kind as "phrase" | "repeated" | "bare",
      detail: `matched "${matched}"`,
      // Oldest last in the window, so it reads as a conversation to whoever
      // opens the email at three in the morning.
      recent: this.#turns
        .slice(0, 6)
        .reverse()
        .map((t) => ({ role: t.role, text: t.text })),
    });

    if (!result.sent) {
      this.#speak(EMERGENCY_FAILED[language] ?? EMERGENCY_FAILED["en-IN"]!);
    }
  }

  #speak(text: string): void {
    this.#apply({ type: "first_clause_ready" });
    this.#emitToTts(text);
    this.#tts?.flush();
  }

  /**
   * Every outgoing chunk is also recorded with the echo guard. That record is
   * the correlation reference that lets us recognise our own voice if it comes
   * back through the microphone.
   */
  #emitToTts(text: string): void {
    this.#echo.onSpeakText(text);
    this.#tts?.speak(text);
  }

  /**
   * Refusals are SPOKEN, never silent — that is the entire point of the gate.
   * `respond_in` is guaranteed speakable by resolveRespondIn().
   */
  async #refuse(decision: GateDecision): Promise<void> {
    const copy = resolveCopy(
      decision.message_key ?? "gate.unsupported_language",
      decision.respond_in,
    );
    this.#log("info", "refusing", {
      gate: decision.gate,
      verdict: decision.verdict.status,
      code: decision.verdict.code,
      respond_in: decision.respond_in,
    });

    // Gate 1 fires before any socket exists, so open one purely to apologise.
    if (!this.#tts) this.#openTts(decision.respond_in);
    else this.#tts.reconfigure({ languageCode: decision.respond_in });

    this.#speak(copy.text);

    if (endsSession(decision)) {
      // Give the apology time to reach the device before tearing down.
      setTimeout(() => this.close("unsupported_language"), 4000).unref();
    }
  }

  #apply(event: Parameters<typeof transition>[1]) {
    const result = transition(this.#phase, event);
    this.#phase = result.phase;
    this.#state.agent_speaking = result.phase === "speaking";
    return result;
  }

  /**
   * Close the transport. Session keys are LEFT TO EXPIRE rather than deleted —
   * that is what makes resume-within-the-idle-window work. A companion that
   * drops the thread because someone walked away for five minutes is the exact
   * failure the idle TTL exists to prevent (docs/02-data-contracts.md section 6).
   */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    // Before anything else. A session that ends while a station plays must not
    // leave the device playing to an empty room with nothing left to stop it —
    // the socket is about to go, and with it the only route to stop_media.
    this.#media.stop(`session_${reason}`);
    this.#turnAbort?.abort();
    if (this.#asrReopenTimer) clearTimeout(this.#asrReopenTimer);
    this.#asrReopenTimer = null;
    this.#asr?.close();
    this.#tts?.close();
    void this.#persistState().catch(() => {});

    // Everything the user quietly lost, in one line, at the one moment someone
    // reading the logs has the whole session in front of them.
    const silent = this.#ledger.silentLosses();
    if (silent.length > 0) this.#log("warn", "session ran degraded", { losses: silent });

    // The episode is written from this event — a session is only summarisable
    // once it has ended.
    this.#emitMemWrite({
      kind: "session_closed",
      tid: this.#state.turn_no,
      turn_count: this.#state.turn_no,
      language: this.#state.language,
      duration_s: Math.round((Date.now() - Date.parse(this.#state.started_at)) / 1000),
    });
    this.#d.device.sendControl({ type: "session_closed", reason });
    this.#d.device.close(reason);
    this.#log("info", "session closed", {
      reason,
      turns: this.#state.turn_no,
      degraded: this.#ledger.list(),
      survivability: this.#ledger.survivability.level,
      asr_provider: this.#state.asr_provider,
    });
  }

  #log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
    this.#d.log?.(level, msg, { sid: this.sid, ...extra });
  }
}
