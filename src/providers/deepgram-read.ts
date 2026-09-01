/**
 * Deepgram Text Intelligence — `POST /v1/read`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS `/v1/read` AND NOT `/v1/listen`.
 *
 * Deepgram ships the same four analyses twice: on audio (`/v1/listen`, marketed
 * as Audio Intelligence) and on text (`/v1/read`, Text Intelligence). Both run
 * the analysis over a TRANSCRIPT — the audio endpoint just transcribes first.
 * Neither hears prosody. Neither can tell you an eighty-year-old sounded tired,
 * only that they used tired words.
 *
 * Given that, the audio path buys us nothing and costs everything: this system
 * streams PCM and drops it, so `/v1/listen` would mean introducing recording and
 * retention of an elderly person's home conversations to obtain a result we can
 * get from text we already hold. That is not a feature flag, it is a different
 * product with a different consent story.
 *
 * So: text only, from the transcript already in `mem:writes`.
 * See docs/adr/0009-audio-intelligence.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ ENGLISH ONLY, AND THE `language` PARAMETER IS NOT ADVISORY. Every feature on
 * this endpoint is English-only
 * ([text sentiment](https://developers.deepgram.com/docs/text-sentiment-analysis.md),
 * [intents](https://developers.deepgram.com/docs/intent-recognition.md)). A
 * non-English request either 400s or comes back confidently wrong, which is the
 * D9 failure mode — fluent, plausible, about the wrong thing. The language gate
 * is in src/domain/care-signals.ts and it is a hard refusal, not a warning.
 *
 * ⚠ 150K TOKEN INPUT LIMIT, enforced by them with a 400
 * ([audio intelligence](https://developers.deepgram.com/docs/audio-intelligence.md)).
 * We cap on characters well below it — see MAX_CHARS in care-signals.ts — because
 * we do not have their tokeniser and a guess that runs close to a hard limit is a
 * guess that eventually fails in production.
 *
 * The auth header is Deepgram's standard `Authorization: Token <key>`, the same
 * one src/providers/deepgram-asr.ts uses and the same one the curl examples on
 * every page above show.
 *
 * NOT VERIFIED AGAINST A LIVE KEY. Everything here is reconstructed from the
 * pages cited above, which is exactly what README's table of five wrong guesses
 * warns about — two of which failed silently. Run `npm run verify:care` before
 * trusting a single field name.
 */

import type { Config } from "../config/env.ts";
import { nodeFetch, type HttpFetch } from "./http.ts";

export type ReadRequest = {
  /** The text to analyse. Already gated, already capped by the caller. */
  text: string;
  sentiment?: boolean;
  intents?: boolean;
  /**
   * Up to 100 strings. With `strict` mode Deepgram returns ONLY these, which is
   * the whole reason we use them: an open-ended intent list is unreviewable, and
   * a fixed one can be read by a human before it ever reaches a caregiver.
   */
  customIntents?: string[];
  customIntentMode?: "strict" | "extended";
  signal?: AbortSignal;
};

/**
 * A failed call, with the status attached.
 *
 * The status matters to the caller: a 400 is our request being wrong and will
 * fail again identically next session; a 429 or 5xx is worth nothing more than a
 * shrug and a retry next time. Neither is ever spoken to a user — this runs in
 * the memory worker, hours from anybody's ear.
 */
export class DeepgramReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeepgramReadError";
    this.status = status;
  }
}

/**
 * The seam the worker depends on. `DeepgramRead` is the only implementation;
 * tests pass a function.
 */
export interface TextAnalyser {
  analyse(req: ReadRequest): Promise<unknown>;
}

const MAX_CUSTOM_INTENTS = 100;

export class DeepgramRead implements TextAnalyser {
  readonly #cfg: Config;
  readonly #fetch: HttpFetch;

  constructor(cfg: Config, fetcher: HttpFetch = nodeFetch()) {
    this.#cfg = cfg;
    this.#fetch = fetcher;
  }

  /**
   * Returns the parsed response body, untouched.
   *
   * Deliberately `unknown`: mapping Deepgram's shape into ours is a domain
   * decision with its own defensive rules (care-signals.ts `toCareSignals`), and
   * a provider that pre-digests its response is a provider you cannot debug when
   * the shape changes under you.
   */
  async analyse(req: ReadRequest): Promise<unknown> {
    if (!this.#cfg.deepgramApiKey) {
      throw new DeepgramReadError(0, "DEEPGRAM_API_KEY is unset");
    }

    const url = new URL("/v1/read", this.#cfg.deepgramReadBase);
    // Required, and only ever this value. See the header note.
    url.searchParams.set("language", "en");
    if (req.sentiment) url.searchParams.set("sentiment", "true");
    if (req.intents) url.searchParams.set("intents", "true");
    for (const intent of (req.customIntents ?? []).slice(0, MAX_CUSTOM_INTENTS)) {
      // Repeated key, not a comma-joined string: their examples show one
      // `custom_intent` per intent and say nothing about a delimiter.
      url.searchParams.append("custom_intent", intent);
    }
    if (req.customIntentMode) url.searchParams.set("custom_intent_mode", req.customIntentMode);

    const init: Parameters<HttpFetch>[1] = {
      method: "POST",
      headers: {
        Authorization: `Token ${this.#cfg.deepgramApiKey}`,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ text: req.text }),
    };
    if (req.signal) init.signal = req.signal;

    const res = await this.#fetch(url.toString(), init);
    const raw = await res.text();

    if (!res.ok) {
      // Their error body is `{err_code, err_msg, request_id}`. Surface err_msg
      // when it is there — "Summarization v2 not supported for non-English
      // languages" tells you what went wrong; "HTTP 400" does not.
      throw new DeepgramReadError(res.status, `/v1/read returned HTTP ${res.status}: ${detail(raw)}`);
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new DeepgramReadError(res.status, "/v1/read returned unparseable JSON");
    }
  }
}

function detail(raw: string): string {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const msg = body["err_msg"] ?? body["message"] ?? body["error"];
    if (typeof msg === "string" && msg !== "") return msg;
  } catch {
    // Not JSON. Fall through to the truncated body, which is still better than
    // nothing when a proxy returns HTML.
  }
  return raw.slice(0, 200);
}
