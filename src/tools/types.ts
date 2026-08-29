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

import type { JsonContext, LanguageCode } from "../domain/types.ts";

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
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
};

export const DEFAULT_DEADLINE_MS = 8000;
export const DEFAULT_FILLER_THRESHOLD_MS = 500;

export type ToolCall = {
  call_id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolErrorCode =
  | "timeout"
  | "upstream_error"
  | "not_entitled"
  | "invalid_args"
  | "unavailable"
  | "unknown_tool";

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
  | "tool.timeout"
  | "tool.unavailable"
  | "tool.not_entitled"
  | "tool.invalid_args"
  | "tool.generic";

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
