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

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type StreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
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
  async *stream(messages: ChatMessage[], opts: StreamOptions = {}): AsyncGenerator<string> {
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
        if (payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // A malformed SSE frame mid-stream is not worth killing a live
          // conversation over. Skip it.
        }
      }
    }
  }
}

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
}
