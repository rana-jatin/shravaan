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
import type { Config } from "../config/env.ts";
import { resolveCopy } from "../copy/refusals.ts";
import { resolveFallback, resolveFiller } from "../copy/fillers.ts";
import { blocksLlm, endsSession, gate1PreConnect, gate2FirstDetection, gate3Switch } from "../domain/gate.ts";
import { ClauseChunker } from "../domain/clause-chunker.ts";
import { EchoGuard } from "../domain/echo-guard.ts";
import { normalizeLanguage } from "../domain/languages.ts";
import { transition } from "../domain/turn-state.ts";
import { TURN_WINDOW } from "../domain/redis-keys.ts";
import { LLM_RETRY, SOCKET_RECONNECT, delayFor, withBackoff } from "../domain/backoff.ts";
import { DEGRADATIONS, DegradationLedger, type DegradationKey } from "../domain/degradation.ts";
import { standbyFor } from "../domain/asr-failover.ts";
import type { GateDecision, JsonContext, LanguageCode, MemWriteEvent, MessageKey, Profile, SessionState, Turn, TurnPhase } from "../domain/types.ts";
import type { AsrClient } from "../providers/asr-client.ts";
import { DeepgramAsr } from "../providers/deepgram-asr.ts";
import { SarvamAsr } from "../providers/sarvam-asr.ts";
import { SarvamLlm, RateLimitError, type ChatMessage, type StreamChunk } from "../providers/sarvam-llm.ts";
import { SarvamTts } from "../providers/sarvam-tts.ts";
import type { HoldingAudio } from "../audio/holding-audio.ts";
import { NullSessionStore, type SessionStore } from "../store/session-store.ts";
import type { MemWriteStream } from "../memory/stream.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolResult } from "../tools/types.ts";

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
  /** Fetches JSON context from our backend. Read-only to the agent. */
  fetchContext?: ((uid: string) => Promise<JsonContext | null>) | undefined;
  /**
   * Pre-rendered apology audio for a TTS outage — the one message that cannot be
   * synthesised, because synthesis is what broke (slice 8).
   */
  holdingAudio?: HoldingAudio | undefined;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

/**
 * Bounded so a model that keeps calling tools cannot hold a live conversation
 * open indefinitely. The user is waiting in real time.
 */
const MAX_TOOL_ROUNDS = 3;

/**
 * How long a retrying turn may stay silent before we say something. Below this
 * the retry is invisible and a filler would only make a fast turn feel slow;
 * above it the user is sitting in dead air wondering if we are still here.
 */
const LLM_FILLER_AFTER_MS = 600;

/** Consecutive ASR socket failures before we stop reconnecting and admit it. */
const MAX_ASR_REOPENS = 4;

/**
 * Consecutive turns that produce nothing before we stop claiming to be a
 * conversation. Three, not one: a 429 is per-account and transient, and closing
 * a companion session over one unlucky minute is its own failure.
 */
const MAX_LLM_TURN_FAILURES = 3;

/**
 * Time for the closing message to actually reach the device before teardown.
 * Generous on purpose: cutting our own apology off mid-word to save three
 * seconds is the exact failure this whole slice exists to avoid.
 */
const GOODBYE_DRAIN_MS = 4000;

const SYSTEM_PROMPT = [
  "You are a warm, attentive companion. Keep replies short and conversational —",
  "one or two sentences unless asked for more. You are being spoken aloud, so",
  "avoid lists, markdown, and anything that only works on a page.",
  "Reply in the same language the user is speaking. If they mix languages,",
  "mix them back naturally.",
].join(" ");

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
  #tts: SarvamTts | null = null;
  readonly #llm: SarvamLlm;
  readonly #chunker = new ClauseChunker();
  readonly #echo: EchoGuard;
  readonly #store: SessionStore;
  readonly #tools: ToolRegistry | null;
  readonly #executor: ToolExecutor | null;
  /** Read-only backend data. NOT memory — see docs/01-architecture.md section 1. */
  #jsonContext: JsonContext | null = null;
  #fillerIndex = 0;
  #turnAbort: AbortController | null = null;
  #firstDetectionDone = false;
  #closed = false;

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
    this.#llm = new SarvamLlm(deps.cfg);
    this.#echo = new EchoGuard(deps.cfg.echoGuard);
    this.#store = deps.store ?? new NullSessionStore();
    this.#tools = deps.tools ?? null;
    this.#executor = this.#tools
      ? new ToolExecutor({
          registry: this.#tools,
          uid: deps.uid,
          sid: this.sid,
          speakFiller: (lang) => {
            // Fillers rotate so a companion that waits often does not sound
            // like a loop.
            this.#emitToTts(resolveFiller(lang, this.#fillerIndex++));
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
    const asr: AsrClient =
      provider === "deepgram"
        ? new DeepgramAsr(this.#d.cfg, {
            // Flux wants a bare primary subtag. Only reached for hi-IN / en-IN.
            languageHint: this.#state.language.split("-")[0]!,
          })
        : // Auto-detect on the first turn so the user's actual language wins over
          // the seed. The token itself is unresolved in Sarvam's docs (docs/05 Q1).
          new SarvamAsr(this.#d.cfg, {
            languageCode: this.#d.cfg.asrAutodetectToken,
            mode: "codemix",
            returnTimestamps: true,
          });

    asr.on("open", () => {
      // A clean open resets the failure count. Otherwise four failures spread
      // across an hour of healthy conversation eventually mute the session.
      this.#asrReopens = 0;
    });
    asr.on("speech_start", () => this.#onSpeechStart());
    asr.on("partial", (t) => this.#onPartial(t.text));
    asr.on("final", (t) => void this.#onFinal(t.text, t.language, t.languageProbability));
    asr.on("error", (e) => this.#log("error", "asr", { provider, err: e.message }));
    asr.on("close", ({ code }) => {
      if (this.#closed || this.#terminating) return;
      this.#log("warn", "asr closed", { provider, code });
      this.#onAsrDown(`socket closed with ${code}`);
    });

    asr.connect();
    this.#asr = asr;
    this.#state.asr_provider = provider;
  }

  #openTts(language: LanguageCode): void {
    const tts = new SarvamTts(this.#d.cfg, {
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
  #onAsrDown(reason: string): void {
    if (this.#closed || this.#terminating || this.#asrReopenTimer) return;

    this.#asrReopens += 1;
    this.#asr?.close();
    this.#asr = null;

    const standby = standbyFor(this.#state.language, {
      configured: this.#d.cfg.asrFailoverEnabled && this.#d.cfg.deepgramApiKey !== null,
      current: this.#state.asr_provider,
    });

    if (standby.available && this.#asrReopens >= 2) {
      this.#degrade("asr_failover_active", {
        from: reason,
        language: this.#state.language,
        residency: "audio now leaves India — Deepgram publishes no India region",
      });
      this.#openAsr("deepgram");
      return;
    }

    if (this.#asrReopens > MAX_ASR_REOPENS) {
      this.#loseHearing(
        standby.available ? reason : `${reason} (no standby: ${standby.detail})`,
      );
      return;
    }

    const delayMs = delayFor(this.#asrReopens - 1, SOCKET_RECONNECT);
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
   * Build the LLM window: oldest first, capped, with each turn's own language.
   *
   * `language` is per turn rather than per session on purpose — a code-mixing
   * user produces a mixed window, and the model should see that rather than a
   * flattened single value (docs/02-data-contracts.md section 2.4).
   */
  #buildMessages(userText: string): ChatMessage[] {
    const history = [...this.#turns]
      .reverse()
      .filter((t) => t.text.trim() !== "")
      .map((t) => ({
        role: t.role === "user" ? ("user" as const) : ("assistant" as const),
        content: t.text,
      }));

    // The current turn was just recorded, so it is already the last entry.
    const alreadyIncluded =
      history.length > 0 &&
      history[history.length - 1]!.role === "user" &&
      history[history.length - 1]!.content === userText;

    return [
      { role: "system" as const, content: SYSTEM_PROMPT + this.#profileBlock() },
      ...history,
      ...(alreadyIncluded ? [] : [{ role: "user" as const, content: userText }]),
    ];
  }

  /**
   * The only long-term memory on the turn path. Capped upstream in
   * buildProfile(); this just renders it.
   *
   * Kept as a stable suffix on the system message so the prefix stays
   * byte-identical across turns — Sarvam prices cached input at roughly a third
   * of fresh input, which is only reachable if we do not churn the prefix.
   */
  #profileBlock(): string {
    const p = this.#profile;
    if (!p) return "";

    const parts: string[] = [];
    if (p.facts.length > 0) {
      parts.push(`What you know about them:\n${p.facts.map((f) => `- ${f.text}`).join("\n")}`);
    }
    if (p.open_threads.length > 0) {
      parts.push(
        `Left unfinished last time:\n${p.open_threads.map((t) => `- ${t.text}`).join("\n")}`,
      );
    }
    if (p.recent_episodes.length > 0) {
      parts.push(`Recently:\n${p.recent_episodes.slice(0, 3).map((e) => `- ${e.summary}`).join("\n")}`);
    }
    if (parts.length === 0) return "";

    return (
      `\n\n${parts.join("\n\n")}\n\n` +
      `Draw on this only when it is genuinely relevant. Do not recite it, and do not ` +
      `open by listing what you remember — that is unsettling rather than warm.`
    );
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

    const messages = this.#buildMessages(userText);

    // Declared out here so the interrupted and failed paths can both record what
    // was actually said. The window must reflect the conversation the user
    // HEARD, not the one we intended to have.
    let reply = "";
    let spokeAnything = false;
    let failure: unknown = null;

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

        const offered =
          this.#tools && round < MAX_TOOL_ROUNDS
            ? this.#tools.schemasFor(this.#jsonContext)
            : [];

        // Retries live inside here and stop at the first chunk — see the method.
        const it = this.#llmStream(messages, offered, abort.signal, !spokeAnything);

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
        const results = await this.#runTools(calls, abort.signal);
        this.#apply({ type: "tool_result" });
        if (abort.signal.aborted) break;

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

    if (failure && !interrupted) {
      this.#onTurnFailed(failure, spokeAnything);
      this.#apply({ type: "playback_drained" });
    } else if (!failure) {
      // A turn that completed is evidence the LLM is back. Recovery is as
      // reportable as failure, or the ledger only ever grows.
      this.#llmFailures = 0;
      this.#recover("llm_rate_limited");
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
    signal: AbortSignal,
    maySpeakFiller: boolean,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    let fillerSpoken = false;

    const opened = await withBackoff(
      async () => {
        const it = this.#llm.stream(messages, {
          signal,
          ...(offered.length > 0 ? { tools: offered } : {}),
        });
        // The fetch does not happen until the first pull, so this is what
        // actually surfaces a 429 and makes it retryable.
        const first = await it.next();
        return { it, first };
      },
      {
        policy: LLM_RETRY,
        // A 500 or a malformed request will not fix itself in 250 ms, and
        // retrying it burns the same rate limit a 429 is already telling us
        // about. Only the limit itself is worth waiting out.
        retryable: (err) => err instanceof RateLimitError,
        signal,
        onRetry: ({ attempt, delayMs, elapsedMs }) => {
          this.#degrade("llm_rate_limited");
          this.#log("warn", "llm retry", { attempt, delayMs, elapsedMs });

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
      this.#degrade("llm_rate_limited", { consecutive: this.#llmFailures });
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
   * Run a round of tool calls.
   *
   * A failed tool is SPOKEN, not swallowed: the user asked for something and is
   * owed an answer either way. The fallback is resolved per language so an
   * English error string never reaches a Hindi voice.
   */
  async #runTools(
    calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    signal: AbortSignal,
  ): Promise<ToolResult[]> {
    if (!this.#executor) return [];

    const results: ToolResult[] = [];
    for (const c of calls) {
      const result = await this.#executor.execute(
        { call_id: c.id, name: c.name, args: c.args },
        { language: this.#state.language, jsonContext: this.#jsonContext, signal },
      );
      results.push(result);

      this.#state.last_tool = c.name;
      if (result.ok) {
        this.#log("info", "tool ok", { tool: c.name, ms: result.elapsed_ms });
        if (result.context_mutated) this.#jsonContext = await this.#fetchContext();
      } else {
        this.#log("warn", "tool failed", {
          tool: c.name,
          code: result.error.code,
          ms: result.elapsed_ms,
        });
        this.#emitToTts(resolveFallback(result.error.spoken_fallback_key, this.#state.language));
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
    const copy = resolveCopy(decision.message_key ?? "gate.unsupported_language", decision.respond_in);
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
      duration_s: Math.round(
        (Date.now() - Date.parse(this.#state.started_at)) / 1000,
      ),
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
