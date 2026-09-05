/**
 * `get_news` — headlines from whichever RSS feeds the operator configured.
 *
 * The validation here is the interesting part, and every branch of it was
 * written after a real failure. See tools/news.ts for the tool itself.
 */

import { NEWS_CATEGORIES, createGetNews, type NewsCategory } from "../tools/news.ts";
import { isHttpUrl } from "../domain/url.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const newsCapability: Capability = {
  name: "news",
  // Not "is NEWS_FEEDS set" — is there a feed for a category this build knows.
  // A value full of typos is not a configured capability.
  isConfigured: (cfg) => NEWS_CATEGORIES.some((c) => Boolean(cfg.news.feeds[c])),

  register(registry, { cfg, log }): CapabilityReport {
    // Only categories with a real feed URL behind them. An unknown key is
    // dropped here rather than reaching the model as an enum value it would
    // then pick and get nothing from.
    const feeds: Partial<Record<NewsCategory, string>> = {};
    for (const category of NEWS_CATEGORIES) {
      const url = cfg.news.feeds[category];
      if (!url) continue;

      // Refuse anything that is not http(s) — a missing scheme, or a file:/data:
      // URL, which would be an SSRF-shaped surprise rather than a feed.
      if (!isHttpUrl(url)) {
        log("error", "NEWS_FEEDS entry is not a usable http(s) URL — dropped", {
          category,
          value: url,
        });
        continue;
      }
      feeds[category] = url;
    }

    // Orphan segments mean a value contained a comma and was cut in half. The
    // surviving half still parses as a URL and passes every check above, so this
    // warning is the ONLY evidence the operator gets before the feed 404s in
    // front of a user. See parsePairs in shared/src/config/env.ts.
    if (cfg.news.feedsDropped.length > 0) {
      log("error", "NEWS_FEEDS has unreadable segments — a feed URL is likely truncated", {
        dropped: cfg.news.feedsDropped,
        hint: "percent-encode a literal comma in a feed URL as %2C",
        parsed: feeds,
      });
    }

    const unknown = Object.keys(cfg.news.feeds).filter(
      (k) => !(NEWS_CATEGORIES as readonly string[]).includes(k),
    );
    if (unknown.length > 0) {
      log("warn", "NEWS_FEEDS has categories this build does not know", {
        ignored: unknown,
        known: [...NEWS_CATEGORIES],
      });
    }

    const categories = Object.keys(feeds);
    if (categories.length === 0) {
      // Every configured feed turned out unusable. `isConfigured` answered on
      // the presence of a key; this is the check that reads the values.
      return { name: "news", registered: false, tools: [], detail: { news: [] } };
    }

    const spec = createGetNews({ feeds, limit: cfg.news.headlineLimit });
    registry.register(spec);
    return { name: "news", registered: true, tools: [spec.name], detail: { news: categories } };
  },
};
