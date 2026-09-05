/**
 * Which conversations are live right now, and how to say something into one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WHOLE SYSTEM UNTIL NOW HAS BEEN REACTIVE. Every word the companion says
 * is an answer: audio arrives, a turn runs, a reply goes back. A reminder
 * inverts that. Nobody asked, and there is no turn to attach to — so something
 * outside the conversation needs a way in, and this is the only one.
 *
 * IT IS DELIBERATELY THE NARROWEST DOOR THAT WORKS. A holder of a `LiveSession`
 * can say one prepared thing and read the session's phase and language. It
 * cannot run a turn, reach the model, touch the store, or read the transcript.
 * The reason is not tidiness: a background job that could drive a conversation
 * is a background job that can talk over a person indefinitely, and the failure
 * would be invisible to everyone except the person in the room.
 *
 * WHY A STRUCTURAL TYPE AND NOT `Session`. Nothing here imports the
 * orchestrator, so the registry is testable against a two-line fake and
 * `session.ts` can depend on these types without a cycle. `Session` satisfies
 * `LiveSession` structurally; if it stops doing so, the compiler says where.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { LanguageCode, SessionState, TurnPhase } from "@sp-i/shared/domain/types.ts";

/**
 * Something to say, and how to say it in whatever language the conversation is
 * currently in.
 *
 * `text` IS A FUNCTION, and that is the point. The caller owns the copy and its
 * eleven translations; the session owns the language and may have changed it
 * three turns ago. A caller passing a finished string would be guessing, and
 * the guess is silent — the person simply hears the wrong language.
 */
export type ProactiveSpeech = {
  text: (language: LanguageCode) => string;
  /** For the log. Short and mechanical: "medication_due", "checkin". */
  reason: string;
};

/**
 * What happened. A refusal here is DATA, not an error.
 *
 * Every `spoken: false` is an ordinary state of a conversation, not a fault:
 * somebody is mid-sentence, the radio is on, the device went away. The caller
 * decides what that means — for a hydration prompt, nothing; for a medication
 * dose, the escalation ladder.
 */
export type ProactiveResult =
  | {
      spoken: true;
      language: LanguageCode;
      /** What was actually said, for the caller's own record. */
      text: string;
    }
  | { spoken: false; reason: ProactiveRefusal };

export type ProactiveRefusal =
  /** The session ended, or is in the middle of ending. */
  | "closed"
  /** Mid-turn: the user is talking, the agent is answering, a tool is running. */
  | "busy"
  /** Music or radio is playing. The session cannot hear an answer either. */
  | "media"
  /** No voice: TTS never opened, or Bulbul is gone. */
  | "no_voice"
  /** The resolved copy was empty. A missing translation, not a broken session. */
  | "no_copy";

export type LiveSession = {
  readonly sid: string;
  readonly uid: string;
  readonly phase: TurnPhase;
  readonly state: Readonly<SessionState>;
  readonly closed: boolean;
  speakProactively(utterance: ProactiveSpeech): Promise<ProactiveResult>;
};

export class SessionRegistry {
  readonly #bySid = new Map<string, LiveSession>();

  add(session: LiveSession): void {
    this.#bySid.set(session.sid, session);
  }

  remove(sid: string): void {
    this.#bySid.delete(sid);
  }

  /**
   * Every live session for one person, the most recently active first.
   *
   * PLURAL ON PURPOSE. One person can have two devices, and a reconnect can
   * briefly overlap the session it replaces. Returning a single "the" session
   * would make that choice here, silently and wrongly — the device somebody is
   * actually sitting next to is the one that spoke most recently, which is a
   * guess this can at least make out loud.
   */
  forUser(uid: string): LiveSession[] {
    this.#prune();
    return [...this.#bySid.values()]
      .filter((s) => s.uid === uid)
      .sort((a, b) => (a.state.last_activity_at < b.state.last_activity_at ? 1 : -1));
  }

  /** The one most likely to have somebody in front of it, or null. */
  reach(uid: string): LiveSession | null {
    return this.forUser(uid)[0] ?? null;
  }

  /** Live sessions, after pruning. For a boot log or a dashboard. */
  get size(): number {
    this.#prune();
    return this.#bySid.size;
  }

  /**
   * A session can end without anybody telling us: `end_conversation`, a
   * dependency failure, a terminate. The socket close usually follows and calls
   * `remove`, but "usually" is not a lifetime rule, and a registry that hands
   * out dead sessions would report a reminder as delivered into silence.
   */
  #prune(): void {
    for (const [sid, session] of this.#bySid) {
      if (session.closed) this.#bySid.delete(sid);
    }
  }
}
