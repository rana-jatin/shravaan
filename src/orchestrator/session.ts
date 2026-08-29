/**
 * One conversation session. Owns turn state, the speakability gates, streaming
 * and barge-in.
 *
 * SCOPE — slices 1, 2 (server half), 3 and 7. Deliberately NOT here:
 * long-term memory, the mem:writes worker, tools, device-side AEC, wake word.
 * See docs/04-milestones.md
 *
 * BARGE-IN follows Sarvam's own documented rule: trigger on vad.speech_start or
 * early partials, NEVER on transcript.final. Note their guidance assumes a
 * telephony leg where the carrier already cancelled echo — on an open-air device
 * that assumption evaporates and AEC is ours (docs/adr/0007-audio-front-end.md).
 */

import { randomUUID } from "node:crypto";
import type { Config } from "../config/env.ts";
import { resolveCopy } from "../copy/refusals.ts";
import { blocksLlm, endsSession, gate1PreConnect, gate2FirstDetection, gate3Switch } from "../domain/gate.ts";
import { ClauseChunker } from "../domain/clause-chunker.ts";
import { EchoGuard } from "../domain/echo-guard.ts";
import { normalizeLanguage } from "../domain/languages.ts";
import { transition } from "../domain/turn-state.ts";
import { TURN_WINDOW } from "../domain/redis-keys.ts";
import type { GateDecision, LanguageCode, Profile, SessionState, Turn, TurnPhase } from "../domain/types.ts";
import { SarvamAsr } from "../providers/sarvam-asr.ts";
import { SarvamLlm, RateLimitError } from "../providers/sarvam-llm.ts";
import { SarvamTts } from "../providers/sarvam-tts.ts";
import { NullSessionStore, type SessionStore } from "../store/session-store.ts";

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
  profile?: Profile | undefined;
  localeHint?: LanguageCode | undefined;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

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
  #asr: SarvamAsr | null = null;
  #tts: SarvamTts | null = null;
  readonly #llm: SarvamLlm;
  readonly #chunker = new ClauseChunker();
  readonly #echo: EchoGuard;
  readonly #store: SessionStore;
  #turnAbort: AbortController | null = null;
  #firstDetectionDone = false;
  #closed = false;

  readonly #d: SessionDeps;

  constructor(deps: SessionDeps) {
    this.#d = deps;
    this.sid = deps.sid ?? randomUUID();
    this.#llm = new SarvamLlm(deps.cfg);
    this.#echo = new EchoGuard(deps.cfg.echoGuard);
    this.#store = deps.store ?? new NullSessionStore();

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
    try {
      const ctx = await this.#store.loadForTurn(this.sid, this.#d.uid, TURN_WINDOW);

      if (ctx.state) {
        this.#state = ctx.state;
        this.#turns = ctx.turns;
        this.#resumed = true;
        this.#firstDetectionDone = ctx.turns.length > 0;
        this.#log("info", "session resumed", {
          turns: ctx.turns.length,
          turn_no: ctx.state.turn_no,
          language: ctx.state.language,
        });
        return;
      }

      // No stored state, but a profile may still seed the language.
      if (ctx.profile?.preferred_language) {
        const code = normalizeLanguage(ctx.profile.preferred_language);
        if (code) {
          this.#state.language = code;
          this.#state.language_source = "profile";
        }
      }
    } catch (err) {
      this.#state.degraded.push("store_unavailable");
      this.#log("warn", "store unavailable, continuing stateless", {
        err: err instanceof Error ? err.message : String(err),
      });
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

  #markStoreDegraded(err: unknown): void {
    if (!this.#state.degraded.includes("store_unavailable")) {
      this.#state.degraded.push("store_unavailable");
    }
    this.#log("warn", "store write failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  #openAsr(): void {
    // Auto-detect on the first turn so the user's actual language wins over the
    // seed. The token itself is unresolved in Sarvam's docs (docs/05 Q1).
    const asr = new SarvamAsr(this.#d.cfg, {
      languageCode: this.#d.cfg.asrAutodetectToken,
      mode: "codemix",
      returnTimestamps: true,
    });

    asr.on("speech_start", () => this.#onSpeechStart());
    asr.on("partial", (t) => this.#onPartial(t.text));
    asr.on("final", (t) => void this.#onFinal(t.text, t.language, t.languageProbability));
    asr.on("error", (e) => this.#log("error", "asr", { err: e.message }));
    asr.on("close", ({ code }) => {
      if (!this.#closed) this.#log("warn", "asr closed", { code });
    });

    asr.connect();
    this.#asr = asr;
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
    tts.connect();
    this.#tts = tts;
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
    this.#echo.onPlaybackEnd();
    this.#d.device.sendControl({ type: "clear_audio" });
    this.#log("info", "barge-in", { trigger });
  }

  async #onFinal(text: string, detected?: string, confidence?: number): Promise<void> {
    if (this.#closed || text.trim() === "") return;
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
  #buildMessages(userText: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
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
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...history,
      ...(alreadyIncluded ? [] : [{ role: "user" as const, content: userText }]),
    ];
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
        profileLanguage: this.#d.profile?.preferred_language,
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
      profileLanguage: this.#d.profile?.preferred_language,
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

    try {
      for await (const delta of this.#llm.stream(messages, { signal: abort.signal })) {
        if (abort.signal.aborted) break;
        reply += delta;
        for (const chunk of this.#chunker.push(delta)) {
          if (!spokeAnything) {
            this.#apply({ type: "first_clause_ready" });
            spokeAnything = true;
          }
          this.#emitToTts(chunk);
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
    }

    if (failure && !interrupted) {
      if (failure instanceof RateLimitError) {
        this.#log("warn", "llm rate limited");
        if (!this.#state.degraded.includes("llm_429")) this.#state.degraded.push("llm_429");
      } else {
        this.#log("error", "llm", {
          err: failure instanceof Error ? failure.message : String(failure),
        });
      }
      this.#apply({ type: "playback_drained" });
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
    this.#asr?.close();
    this.#tts?.close();
    void this.#persistState().catch(() => {});
    this.#d.device.sendControl({ type: "session_closed", reason });
    this.#d.device.close(reason);
    this.#log("info", "session closed", {
      reason,
      turns: this.#state.turn_no,
      degraded: this.#state.degraded,
    });
  }

  #log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
    this.#d.log?.(level, msg, { sid: this.sid, ...extra });
  }
}
