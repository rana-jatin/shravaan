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
 *
 * TOOL-CALLING IS NOW VERIFIED against a live key — `npm run verify:tools`.
 * ADR 0003's open question is answered: sarvam-105b speaks OpenAI's dialect,
 * with one divergence that matters. See `accumulateArgs` below.
 */

import type { Config } from "@sp-i/shared/config/env.ts";
import { ThinkFilter } from "../domain/think-filter.ts";
import {
  EmptyCompletionError,
  RateLimitError,
  type ChatMessage,
  type LlmClient,
  type StreamChunk,
  type StreamOptions,
} from "./llm-client.ts";

// The wire shapes and the failure taxonomy live on the interface now
// (./llm-client.ts) — a fake LLM needs both, and neither is Sarvam-specific.
// Re-exported here so every existing importer keeps its current import line.
export {
  EmptyCompletionError,
  RateLimitError,
  isRetryableTransport,
  type ChatMessage,
  type LlmClient,
  type StreamChunk,
  type StreamOptions,
  type ToolChoice,
  type ToolSchema,
} from "./llm-client.ts";

export class SarvamLlm implements LlmClient {
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
    const url = new URL("/v1/chat/completions", this.#cfg.sarvam.apiBase);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": this.#cfg.sarvam.apiKey,
      },
      body: JSON.stringify({
        model: this.#cfg.sarvam.llmModel,
        messages,
        stream: true,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        // Only meaningful alongside `tools`; sending it bare would be a request
        // to choose from nothing.
        ...(opts.toolChoice && opts.tools && opts.tools.length > 0
          ? { tool_choice: opts.toolChoice }
          : {}),
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
    // arguments JSON a piece at a time after it. Accumulate by index and emit
    // only once the stream closes and the JSON is complete.
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();

    // Everything below tracks one question: did this request produce anything at
    // all? A stream that ends having yielded nothing is a failure wearing a 200
    // (see EmptyCompletionError), and only this scope can tell.
    let yielded = 0;
    let finishReason = "";
    let reasoningChars = 0;
    let warnedReasoning = false;

    const think = new ThinkFilter({
      onStrayClose: () =>
        opts.onWarn?.("model reasoning reached the speech path", {
          detail: "a bare </think> arrived in `content`; text before it has already been spoken",
          model: this.#cfg.sarvam.llmModel,
        }),
    });

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
          const tail = think.flush();
          if (tail) {
            yielded++;
            yield { type: "text", text: tail };
          }
          for (const call of emitToolCalls(partialCalls)) {
            yielded++;
            yield call;
          }
          if (yielded === 0) throw new EmptyCompletionError(finishReason, reasoningChars);
          return;
        }

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              finish_reason?: string | null;
              delta?: {
                content?: string;
                /**
                 * A reasoning model's private scratchpad. Never spoken — see
                 * ThinkFilter and the ADR 0003 addendum. Counted so that an
                 * empty completion can say whether the model was thinking or
                 * the request was simply dropped.
                 */
                reasoning_content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta) continue;

          if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
            reasoningChars += delta.reasoning_content.length;
            // One warning per stream, not per frame — there can be thousands.
            if (!warnedReasoning) {
              warnedReasoning = true;
              opts.onWarn?.("model is emitting reasoning tokens", {
                model: this.#cfg.sarvam.llmModel,
                detail:
                  "reasoning_content delays the first spoken token; " +
                  "sarvam-105b measured ~12.8s vs ~0.3s on sarvam-105b-conversations",
              });
            }
          }

          if (delta.content) {
            const speakable = think.push(delta.content);
            if (speakable !== "") {
              yielded++;
              yield { type: "text", text: speakable };
            }
          }

          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const acc = partialCalls.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) {
              acc.args = accumulateArgs(acc.args, tc.function.arguments);
            }
            partialCalls.set(idx, acc);
          }
        } catch {
          // A malformed SSE frame mid-stream is not worth killing a live
          // conversation over. Skip it.
        }
      }
    }

    // The body ended without `[DONE]` — a truncated stream rather than a clean
    // close. Same accounting: whatever survived is worth speaking, and nothing
    // surviving is a failed turn, not a quiet one.
    const tail = think.flush();
    if (tail) {
      yielded++;
      yield { type: "text", text: tail };
    }
    for (const call of emitToolCalls(partialCalls, opts.onWarn)) {
      yielded++;
      yield call;
    }
    if (yielded === 0) throw new EmptyCompletionError(finishReason, reasoningChars);
  }
}

/**
 * Append an argument fragment — and drop it if it is a repeat.
 *
 * THE DIVERGENCE. OpenAI streams `arguments` as fragments that concatenate to
 * exactly one JSON value. Sarvam does that too for long payloads — verified,
 * token by token, `{"text": "` … `"kind": ` … `"}` — but for a SHORT or empty
 * argument object it sends the finished value whole and then sends it AGAIN:
 *
 *   frame 55  {"arguments":"",   "name":"get_time"}
 *   frame 56  {"arguments":"{}", "name":null}
 *   frame 57  {"arguments":"{}", "name":null}      ← the same value, twice
 *
 * Concatenating gives `{}{}`, which is not JSON. The previous parser caught the
 * throw and emitted empty arguments, which happens to be right for a no-argument
 * tool and is silent data loss for every other one — the failure would have
 * surfaced as a companion that mysteriously ignored half of what it was told.
 *
 * So: once what we hold is a complete JSON value, a fragment identical to it is
 * a retransmission, not more content. Anything else still appends, because a
 * genuinely fragmented stream must keep working.
 */
export function accumulateArgs(acc: string, fragment: string): string {
  if (fragment === "") return acc;
  if (acc === "") return fragment;
  if (fragment === acc && isCompleteJson(acc)) return acc;
  return acc + fragment;
}

function isCompleteJson(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first complete JSON value in `s`, plus whatever trailed it.
 *
 * Brace-depth scan rather than a parser, because it has to work on a string that
 * is known to have trailing junk. String literals and their escapes are skipped
 * so a `}` inside a value cannot close the object early.
 */
export function firstJsonValue(s: string): { value: string; rest: string } | null {
  const start = s.search(/\S/);
  if (start === -1) return null;

  const open = s[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      return { value: s.slice(start, i + 1), rest: s.slice(i + 1) };
    }
  }
  return null;
}

/**
 * Turn an accumulated argument string into an object.
 *
 * Three tiers, weakest assumption last: clean parse; first complete value with a
 * duplicate tail (the divergence above, if it ever slips past `accumulateArgs`);
 * give up and hand back `{}` so the executor's validation speaks "I didn't catch
 * the details" rather than dropping a request the user actually made.
 */
export function parseToolArgs(
  raw: string,
  name: string,
  onWarn?: (msg: string, extra: Record<string, unknown>) => void,
): Record<string, unknown> {
  const text = raw.trim();
  if (text === "") return {};

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through
  }

  const first = firstJsonValue(text);
  if (first) {
    try {
      const value = JSON.parse(first.value) as Record<string, unknown>;
      const rest = first.rest.trim();
      if (rest !== "" && rest !== first.value.trim()) {
        onWarn?.("tool arguments had unexpected trailing content", {
          tool: name,
          trailing: rest.slice(0, 120),
        });
      }
      return value;
    } catch {
      // fall through
    }
  }

  onWarn?.("tool arguments were not parseable JSON", {
    tool: name,
    raw: text.slice(0, 200),
  });
  return {};
}

function* emitToolCalls(
  partial: Map<number, { id: string; name: string; args: string }>,
  onWarn?: (msg: string, extra: Record<string, unknown>) => void,
): Generator<StreamChunk> {
  for (const [, acc] of partial) {
    if (acc.name === "") continue;
    yield {
      type: "tool_call",
      id: acc.id || `call-${acc.name}`,
      name: acc.name,
      args: parseToolArgs(acc.args, acc.name, onWarn),
    };
  }
  partial.clear();
}

// RateLimitError, EmptyCompletionError and isRetryableTransport moved to
// ./llm-client.ts — they are the retry contract, not Sarvam details. Still
// re-exported from this module; see the export block at the top.
