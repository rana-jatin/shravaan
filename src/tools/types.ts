/**
 * Tool contract. Mirrors docs/02-data-contracts.md section 5.
 *
 * Two rules here are easy to get wrong and expensive to get wrong:
 *
 *   1. ENTITLEMENT GATES OFFERING, NOT JUST EXECUTION. A tool the user is not
 *      entitled to must never be *described* to them. Checking only at execution
 *      produces an agent that offers things and then withdraws them, which is a
 *      worse experience than never mentioning them.
 *
 *   2. FALLBACK MESSAGES ARE KEYS, NOT STRINGS. The message must be resolvable in
 *      whatever language the turn is in. An English error string reaching TTS
 *      would be spoken by a Hindi voice.
 */

import type { FactKind, JsonContext, LanguageCode } from "../domain/types.ts";
import type { MoodTrend } from "../domain/care-signals.ts";
import type { MediaRequest } from "./music.ts";

/**
 * The slice of the live session a tool is allowed to touch.
 *
 * WHY AN INTERFACE AND NOT THE SESSION ITSELF. The registry is built once per
 * deployment and shared by every concurrent session, but `repeat_that` means
 * *this* conversation's last reply. So the registry holds stateless definitions
 * and the session hands itself in at execution time, narrowed to this surface.
 * A tool cannot reach the ASR socket, the turn window or the degradation ledger,
 * because nothing it legitimately does needs them.
 *
 * Everything here is synchronous or fire-and-forget except the two memory reads,
 * which are the only tools that touch a store.
 */
export interface SessionToolHost {
  /** The most recent thing the agent said, for `repeat_that`. */
  lastAgentReply(): string | null;

  /**
   * Ask for a language. Routed through the SAME speakability verdict as gates
   * 2 and 3 — a tool must not be a side door around the one check that stops a
   * user hearing silence. A declined switch is spoken by the session in its own
   * reviewed copy, not improvised by the model.
   */
  requestLanguage(code: string): {
    switched: boolean;
    language: LanguageCode;
    reason?: "not_speakable" | "unknown_language" | "already_speaking_it";
  };

  /** Current TTS pace, and a setter that clamps to a sane speaking range. */
  pace(): number;
  setPace(pace: number): number;

  /** Close once the current reply has drained. Never mid-sentence. */
  requestEnd(reason: string): void;

  /** Fire-and-forget write to `mem:writes`. Never blocks the turn. */
  rememberFact(text: string, kind: FactKind): void;

  /** Soft-delete at the user's request. Returns what was actually forgotten. */
  forgetFacts(subject: string): Promise<{ forgotten: number; texts: string[] }>;

  /** Semantic search over long-term memory. Empty when no store is wired. */
  recallFacts(query: string, limit: number): Promise<Array<{ text: string; score: number }>>;

  /**
   * How recent sessions have been going, from signals the memory worker already
   * wrote. A LOCAL READ — no provider is called here, on any turn, ever. Null
   * when nothing has been analysed. See ADR 0009.
   */
  recentMood(sessions: number): Promise<MoodTrend | null>;

  /** IANA zone from JSON context identity, falling back to the deployment default. */
  timezone(): string;

  /**
   * Start media on the device. Returns as soon as the request is DISPATCHED,
   * never when the track ends — a handler that waited would blow its deadline
   * and hold the turn open for the length of a song.
   *
   * The session forwards it over the control channel and marks itself
   * media-playing; nothing here touches audio. See src/tools/music.ts.
   */
  playMedia(req: MediaRequest): void;

  /** Stop whatever is playing. Safe to call when nothing is. */
  stopMedia(reason: string): void;
}

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  /**
   * MUST be language-neutral tokens, never translated values.
   *
   * The model is reasoning in Hindi about a tool described in English, so an
   * enum of `["सुबह","शाम"]` invites it to answer in whichever language the turn
   * is in, and validation then rejects a call the user legitimately made. Keep
   * the tokens English and let the model map — it is bilingual, the enum is not.
   */
  enum?: string[];
  /** For `type: "array"` — the element type. Arrays of objects are not supported. */
  items?: { type: "string" | "number" | "integer" | "boolean" };
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  /**
   * OpenAI `strict` mode's companion. Emitted to the model and enforced locally
   * by validateArgs regardless of whether Sarvam honours it.
   */
  additionalProperties?: false;
};

export type ToolDefinition = {
  name: string;
  /** Shown to the LLM. Written for the model, not the user. */
  description: string;
  parameters: JsonSchema;

  /** Hard deadline. Exceeded → error result, spoken fallback, pending cleared. */
  deadline_ms: number;
  /** Above this, speak a filler while waiting. */
  filler_threshold_ms: number;
  /**
   * Tool-specific progress line, spoken instead of the generic filler.
   *
   * Omit unless this tool can genuinely run long enough to need one. The
   * session speaks at most ONE progress line per round regardless of how many
   * tools are in flight, and none at all if the model already introduced the
   * call itself — see `speakFiller` in the orchestrator.
   */
  progress_key?: ProgressKey | undefined;
  /** Does success mutate JSON context? If so, invalidate user:{uid}:ctx. */
  mutates_context: boolean;
  /** Entitlement required to OFFER this tool at all. */
  requires_entitlement?: string | undefined;

  handler: (
    args: Record<string, unknown>,
    ctx: ToolInvocationContext,
  ) => Promise<Record<string, unknown>>;
};

export type ToolInvocationContext = {
  uid: string;
  sid: string;
  language: LanguageCode;
  jsonContext: JsonContext | null;
  signal: AbortSignal;
  /** The live conversation, narrowed. See SessionToolHost. */
  host: SessionToolHost;
};

export const DEFAULT_DEADLINE_MS = 8000;
export const DEFAULT_FILLER_THRESHOLD_MS = 500;

export type ToolCall = {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolErrorCode =
  "timeout" | "upstream_error" | "not_entitled" | "invalid_args" | "unavailable" | "unknown_tool";

export type ToolResult =
  | {
      call_id: string;
      name: string;
      ok: true;
      data: Record<string, unknown>;
      elapsed_ms: number;
      /** True → orchestrator invalidates user:{uid}:ctx before the next turn. */
      context_mutated: boolean;
    }
  | {
      call_id: string;
      name: string;
      ok: false;
      error: {
        code: ToolErrorCode;
        /** For logs. NEVER spoken verbatim. */
        message: string;
        /** Key into per-language copy. Resolved at speak time. */
        spoken_fallback_key: FallbackKey;
      };
      elapsed_ms: number;
    };

export type FallbackKey =
  "tool.timeout" | "tool.unavailable" | "tool.not_entitled" | "tool.invalid_args" | "tool.generic";

/**
 * What the agent says WHILE a slow tool runs, instead of the generic filler.
 *
 * Only worth defining for a tool that can actually be slow. Every key here is
 * eleven translations, and a tool capped at 250 ms will never reach its own
 * threshold — the built-ins deliberately have none.
 *
 * Phrase these as a person, not a process: "let me check the weather", never
 * "fetching weather data". ADR 0008's rule that a companion should not narrate
 * its own infrastructure applies to progress just as much as to failure.
 */
export type ProgressKey =
  "progress.weather" | "progress.news" | "progress.calendar" | "progress.mail";

/** In-flight call, mirrored into sess:{sid}:pending. */
export type PendingCall = {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
  dispatched_at: string;
  deadline_ms: number;
  /** Did we already say "one moment"? Prevents stacking fillers. */
  filler_spoken: boolean;
};
