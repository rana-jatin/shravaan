/**
 * `get_news` — headlines from whichever RSS feeds the deployment configured.
 *
 * Split out of tools/builtin.ts. See tools/external.ts for the residency
 * argument that governs this tool and the deadline it runs under.
 */

import { getText, nodeFetch, type HttpFetch } from "../providers/http.ts";
import type { ToolSpec } from "./registry.ts";
import { NETWORK_FILLER_MS, NETWORK_MS } from "./external.ts";

/**
 * Categories the model may ask for. English tokens, mapped to feed URLs by the
 * deployment — so "sports news" reaches whichever source the operator chose,
 * and a category nobody configured is a domain outcome rather than a 404.
 */
export const NEWS_CATEGORIES = ["top", "sports", "business", "world", "entertainment"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export type NewsDeps = {
  /** Category → RSS URL. Only the configured categories are offered. */
  feeds: Partial<Record<NewsCategory, string>>;
  /** Headlines per answer. Small on purpose — this is read aloud. */
  limit?: number;
  fetch?: HttpFetch;
};

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
    handler: async (args, ctx) => {
      const category = String(args["category"] ?? "").trim() as NewsCategory;
      const url = deps.feeds[category];
      // Domain outcome again: the model offers what IS available rather than
      // apologising for infrastructure the user never asked about.
      if (!url) {
        return { found: 0, reason: "category_unavailable", category, available };
      }

      const xml = await getText(fetcher, url, "news feed", {
        signal: ctx.signal,
        headers: { accept: "application/rss+xml, application/xml, text/xml" },
      });

      const headlines = parseFeedTitles(xml, limit);
      return headlines.length === 0
        ? { found: 0, reason: "feed_empty", category }
        : { found: headlines.length, category, headlines };
    },
  };
}
