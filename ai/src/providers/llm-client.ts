/**
 * The shared LLM surface, and the failure taxonomy that goes with it.
 *
 * One method, because one method is all the orchestrator uses. The value of the
 * interface is not polymorphism — there is one chat provider — it is that
 * `Session` can be handed a scripted stream instead of a live endpoint. Until it
 * existed, `Session` built its own `SarvamLlm` in the constructor and no test
 * could drive a turn (docs/07-defect-register.md §9).
 *
 * THE ERRORS BELONG HERE, NOT IN THE SARVAM CLIENT.
 *
 * `RateLimitError`, `EmptyCompletionError` and `isRetryableTransport` look like
 * provider trivia and are not: they are the contract the turn loop retries on
 * (`retryable` in session.ts `#llmStream`). A fake that cannot raise them cannot
 * exercise the retry path, the retry filler, or the degradation ledger — which is
 * most of what makes a bad minute survivable. Anything implementing `LlmClient`
 * is expected to speak this vocabulary.
 */

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; tool_calls: unknown[] }
  | { role: "tool"; content: string; tool_call_id: string };

/**
 * Either prose or a tool invocation.
 *
 * TOOL-CALLING IS VERIFIED ON SARVAM-105B as of 2026-08-29 (`npm run
 * verify:tools`). ADR 0003 recorded that nothing in the documentation described
 * its reliability and named this slice as the real test. The answer: it emits
 * OpenAI-shaped `tool_calls` deltas — `{index, id, type, function:{name,
 * arguments}}` — accumulates long arguments token by token exactly as OpenAI
 * does, honours all four `tool_choice` forms, and returns multiple calls in a
 * single round. `role:"tool"` results round-trip into prose.
 *
 * One divergence, handled in `accumulateArgs` (sarvam-llm.ts).
 */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> };

/**
 * OpenAI's four forms, all confirmed honoured by sarvam-105b:
 *   "auto"      — model decides (the default when tools are present)
 *   "none"      — tools stay visible but must not be called
 *   "required"  — the model must call something
 *   {function}  — the model must call this specific tool
 *
 * `"none"` is the one the orchestrator leans on: it is how the final tool round
 * demands prose instead of yet another call, without retracting the tool list
 * mid-conversation.
 */
export type ToolChoice =
  "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    /** Accepted by Sarvam. Whether it is enforced is unverified — we validate anyway. */
    strict?: boolean;
  };
};

export type StreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  /**
   * ⚠ ON A REASONING MODEL THIS IS A MUTE SWITCH, NOT A LENGTH CAP.
   *
   * `max_tokens` counts reasoning tokens. `sarvam-105b` with `max_tokens: 700`
   * returns `finish_reason: "length"`, 2,713 characters of `reasoning_content`,
   * and **zero content** — a well-formed 200 that says nothing. Any value that
   * looks reasonable for a spoken sentence is far below what that model spends
   * before it starts answering.
   *
   * Safe on `sarvam-105b-conversations` (our default), which does not reason.
   * Nothing in the orchestrator sets it. If you set it, `EmptyCompletionError`
   * will name it when it bites.
   */
  maxTokens?: number;
  /** OpenAI-style function schemas. Already entitlement-filtered by the caller. */
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
  /** Diagnostics for a divergent tool-call stream. Never throws into the turn. */
  onWarn?: (msg: string, extra: Record<string, unknown>) => void;
};

export interface LlmClient {
  /**
   * Stream a completion as an async iterable of chunks.
   *
   * An `AsyncGenerator` rather than a bare `AsyncIterable` because the turn loop
   * pulls the first chunk by hand — that is what surfaces a 429 inside the retry,
   * since `fetch` does not happen until the first pull — and closes the generator
   * explicitly on barge-in rather than leaving a response body to the collector.
   */
  stream(messages: ChatMessage[], opts?: StreamOptions): AsyncGenerator<StreamChunk>;
}

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
}

/**
 * The request succeeded and the model said nothing.
 *
 * HTTP 200, a well-formed SSE stream, `[DONE]`, and not one content delta or
 * tool call in between. This is not theoretical: measured over 12 identical
 * calls to `sarvam-105b`, three came back exactly like this and two more dropped
 * the socket. **Not one returned 429.** That is how Sarvam sheds load, so a
 * retry policy that only knows about 429 never fires (docs/adr/0003-llm.md).
 *
 * It is raised rather than returned because silence must not travel any further
 * as success. Returning an empty stream let the orchestrator score the turn as
 * healthy — it reset the failure counter and filed a recovery — while the user
 * heard nothing at all. An error reaches the retry, and if that is exhausted it
 * reaches the degradation ledger, which is where a failed turn belongs.
 *
 * The other way to get here is `max_tokens` on a reasoning model: the budget is
 * spent on `reasoning_content` and the answer never starts. `finish_reason` is
 * carried on the message for exactly that reason — `"length"` with no content
 * means the cap, `"stop"` with no content means load-shedding.
 */
export class EmptyCompletionError extends Error {
  override readonly name = "EmptyCompletionError";
  readonly finishReason: string;
  readonly reasoningChars: number;

  constructor(finishReason: string, reasoningChars: number) {
    super(
      `LLM stream completed with no content (finish_reason=${finishReason || "none"}, ` +
        `reasoning_content=${reasoningChars} chars)` +
        (finishReason === "length"
          ? " — the token budget was spent before the answer began; on a reasoning " +
            "model max_tokens counts reasoning tokens"
          : ""),
    );
    this.finishReason = finishReason;
    this.reasoningChars = reasoningChars;
  }
}

/**
 * Is this failure worth another attempt inside the same turn?
 *
 * Undici reports a dropped connection as `TypeError: fetch failed` with the real
 * reason on `cause.code`, which is the shape two of those twelve calls arrived
 * in. None of it is distinguishable from a 429 by status code, because there
 * isn't one.
 *
 * Deliberately narrow: a 400, a 500 or a malformed request will not fix itself
 * in 250 ms, and retrying spends a request against a limit that is already the
 * system's concurrency ceiling. Aborts are never here — `withBackoff` checks the
 * signal before it consults this.
 */
export function isRetryableTransport(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;

  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === "string") {
    return (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    );
  }

  // No cause to inspect: undici's generic wrapper still means the socket failed
  // before we had an answer, which is the case worth one more attempt.
  return err instanceof TypeError && /fetch failed|terminated/i.test(err.message);
}
