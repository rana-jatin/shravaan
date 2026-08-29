/**
 * Sarvam-105B chat client, streaming.
 *
 * RATE LIMIT IS THE SYSTEM'S CONCURRENCY CEILING: 40 req/min on Starter, 60 on
 * Pro, 120 on Business — below the 20/100/100 STT socket limit at realistic call
 * rates. Capacity plans against this, not against the transcriber.
 * See docs/adr/0003-llm.md
 *
 * That is also why the speakability gate runs BEFORE this module is ever called:
 * spending a request on a reply that can never be spoken burns the scarcest
 * resource in the stack to produce nothing.
 *
 * ⚠ UNVERIFIED: endpoint path and payload shape assume an OpenAI-compatible
 * surface. Sarvam's API-reference pages were not reachable during research
 * (docs/05-open-questions.md Q12). Verify before first run.
 */

import type { Config } from "../config/env.ts";

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; tool_calls: unknown[] }
  | { role: "tool"; content: string; tool_call_id: string };

/**
 * Either prose or a tool invocation.
 *
 * ⚠ TOOL-CALLING IS UNVERIFIED ON SARVAM-105B. ADR 0003 records that nothing in
 * the documentation describes its tool-calling reliability, and named this slice
 * as the real test. The wire format below assumes an OpenAI-compatible
 * `tool_calls` delta. If Sarvam diverges, this parser is where it shows up —
 * and the honest fallback is an external LLM with the residency cost that
 * implies.
 */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> };

export type StreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** OpenAI-style function schemas. Already entitlement-filtered by the caller. */
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
};

export class SarvamLlm {
  readonly #cfg: Config;

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  /**
   * Stream a completion as an async iterable of text deltas.
   *
   * Deltas are fed straight into the clause chunker so synthesis can begin at the
   * first clause boundary rather than at completion — the largest structural
   * latency win available to us.
   */
  async *stream(messages: ChatMessage[], opts: StreamOptions = {}): AsyncGenerator<StreamChunk> {
    const url = new URL("/v1/chat/completions", this.#cfg.apiBase);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": this.#cfg.sarvamApiKey,
      },
      body: JSON.stringify({
        model: this.#cfg.llmModel,
        messages,
        stream: true,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (res.status === 429) {
      throw new RateLimitError(
        "Sarvam-105B rate limit hit (40/min Starter, 60 Pro, 120 Business). " +
          "This is the system's binding concurrency constraint — see docs/adr/0003-llm.md",
      );
    }
    if (!res.ok) {
      throw new Error(`LLM request failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    if (!res.body) throw new Error("LLM response had no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // Tool calls arrive fragmented across deltas: the name in one frame, the
    // arguments JSON a character at a time after it. Accumulate by index and
    // emit only once the stream closes and the JSON is complete.
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield* emitToolCalls(partialCalls);
          return;
        }

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) yield { type: "text", text: delta.content };

          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const acc = partialCalls.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            partialCalls.set(idx, acc);
          }
        } catch {
          // A malformed SSE frame mid-stream is not worth killing a live
          // conversation over. Skip it.
        }
      }
    }

    yield* emitToolCalls(partialCalls);
  }
}

function* emitToolCalls(
  partial: Map<number, { id: string; name: string; args: string }>,
): Generator<StreamChunk> {
  for (const [, acc] of partial) {
    if (acc.name === "") continue;
    let args: Record<string, unknown> = {};
    try {
      args = acc.args.trim() === "" ? {} : (JSON.parse(acc.args) as Record<string, unknown>);
    } catch {
      // Truncated or malformed arguments. Emit with empty args so the executor's
      // validation produces a spoken "I didn't catch the details" rather than a
      // silent drop — the user asked for something and deserves an answer.
    }
    yield { type: "tool_call", id: acc.id || `call-${acc.name}`, name: acc.name, args };
  }
  partial.clear();
}

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
}
