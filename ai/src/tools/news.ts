/**
 * `get_news` — headlines from whichever RSS feeds the deployment configured.
 *
 * Split out of tools/builtin.ts. See tools/external.ts for the residency
 * argument that governs this tool and the deadline it runs under.
 */

import { getText, nodeFetch, type HttpFetch } from "@sp-i/shared/providers/http.ts";
import { TtlCache } from "../domain/ttl-cache.ts";
import type { ToolSpec } from "./registry.ts";
import { NETWORK_FILLER_MS, NETWORK_MS } from "./external.ts";

/**
 * Categories the model may ask for. English tokens, mapped to feed URLs by the
 * deployment — so "sports news" reaches whichever source the operator chose,
 * and a category nobody configured is a domain outcome rather than a 404.
 */
export const NEWS_CATEGORIES = ["top", "sports", "business", "world", "entertainment"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/** See `NewsDeps.cacheMs` for why five minutes. */
const DEFAULT_CACHE_MS = 5 * 60_000;

export type NewsDeps = {
  /** Category → RSS URL. Only the configured categories are offered. */
  feeds: Partial<Record<NewsCategory, string>>;
  /** Headlines per answer. Small on purpose — this is read aloud. */
  limit?: number;
  /**
   * How long a feed's headlines stay fresh. Zero disables caching.
   *
   * Five minutes by default, and the number comes from what news IS rather
   * than from load. A wire service publishes a few times an hour; nobody asking
   * a companion what is happening is served better by a headline five minutes
   * newer, and refetching per question would hit the same feed once for every
   * conversation in the house every time somebody asked.
   */
  cacheMs?: number;
  fetch?: HttpFetch;
  now?: () => number;
};

type Headline = { title: string; published: string | null };

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * RSS titles are not plain text, and this one ends up spoken aloud.
 *
 * Feeds ship CDATA wrappers, inline markup and HTML entities in roughly equal
 * measure. Left alone, Bulbul reads "&amp;" out as five characters — the same
 * class of defect as the markdown note in verify-tool-calling.ts.
 */
function cleanText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Enough RSS to read headlines, and no more.
 *
 * Deliberately not an XML parser: the product needs `<title>` out of `<item>`,
 * a real parser is a dependency this repo does not otherwise carry, and Atom's
 * `<entry>` is handled by the same two patterns. If a feed ever needs more than
 * a headline and a date, replace this rather than growing it.
 */
export function parseFeedTitles(
  xml: string,
  limit: number,
): Array<{ title: string; published: string | null }> {
  const items = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  const out: Array<{ title: string; published: string | null }> = [];

  for (const item of items) {
    const title = cleanText(item.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    if (title === "") continue;
    const date = item.match(
      /<(?:pubDate|published|updated)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i,
    )?.[1];
    out.push({ title, published: date ? cleanText(date) : null });
    if (out.length >= limit) break;
  }
  return out;
}

export function createGetNews(deps: NewsDeps): ToolSpec {
  const fetcher = deps.fetch ?? nodeFetch();
  const limit = deps.limit ?? 5;
  const available = NEWS_CATEGORIES.filter((c) => deps.feeds[c]);

  // Keyed by URL rather than by category, so two categories pointed at the same
  // feed share one fetch — which is what an operator who set `top` and `world`
  // to the same wire service has actually asked for.
  const cache = new TtlCache<Headline[]>({
    ttlMs: deps.cacheMs ?? DEFAULT_CACHE_MS,
    maxEntries: NEWS_CATEGORIES.length,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return {
    name: "get_news",
    description:
      "Get today's headlines. Use this whenever the user asks what is happening, " +
      "for the news, or for news about a particular subject like sport or " +
      "business. You do not know today's news on your own — never answer from " +
      "memory. Read out a few headlines conversationally, not as a list.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Which headlines to fetch.",
          // Only what this deployment can actually serve. A category the
          // operator never configured is never offered in the first place.
          enum: [...available],
        },
      },
      required: ["category"],
      additionalProperties: false,
    },
    deadline_ms: NETWORK_MS,
    filler_threshold_ms: NETWORK_FILLER_MS,
    progress_key: "progress.news",
    handler: async (args) => {
      const category = String(args["category"] ?? "").trim() as NewsCategory;
      const url = deps.feeds[category];
      // Domain outcome again: the model offers what IS available rather than
      // apologising for infrastructure the user never asked about.
      if (!url) {
        return { found: 0, reason: "category_unavailable", category, available };
      }

      // THE PARSE IS INSIDE THE CACHED LOAD, not outside it. Storing the raw
      // XML would mean every hit re-running six regexes over a document that
      // can be a hundred kilobytes, inside a turn, to produce the same five
      // strings it produced a minute ago.
      //
      // ⚠ `ctx.signal` belongs to ONE turn, and a shared load may outlive it —
      // the second caller would lose its answer because the first one hung up.
      // The tool's own deadline still bounds every waiter, so nothing here can
      // hold a turn open; what is given up is cancelling the upstream request,
      // which is a request already made.
      const headlines = await cache.fetch(url, () =>
        getText(fetcher, url, "news feed", {
          headers: { accept: "application/rss+xml, application/xml, text/xml" },
        }).then((xml) => parseFeedTitles(xml, limit)),
      );
      return headlines.length === 0
        ? { found: 0, reason: "feed_empty", category }
        : { found: headlines.length, category, headlines };
    },
  };
}
