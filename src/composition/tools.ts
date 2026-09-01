/**
 * Which tools this deployment actually has, and why.
 *
 * THE RULE THIS FILE ENFORCES: unconfigured means unregistered means never
 * described to the user. An agent that offers the weather and then cannot fetch
 * it is worse than one that never mentioned it — see `offerableTo` in
 * tools/registry.ts and the argument in tools/external.ts.
 *
 * Extracted from src/server.ts. Every gate below was already there; what is new
 * is that the gates are now reachable without booting a WebSocket server, and
 * that the returned `ToolWiring` gives the boot log one place to read the
 * outcome from instead of recomputing it from six variables.
 */

import type { Config } from "../config/env.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { BUILTIN_TOOLS } from "../tools/builtin.ts";
import { createGetWeather } from "../tools/weather.ts";
import { NEWS_CATEGORIES, createGetNews, type NewsCategory } from "../tools/news.ts";
import { createRecallMood } from "../tools/wellbeing.ts";
import { createPlayMusic } from "../tools/music.ts";
import { RadioCatalogue } from "../domain/radio-catalogue.ts";
import { SPEAKABLE } from "../domain/languages.ts";
import { pendingStopReview } from "../copy/stop-intent.ts";
import type { Log } from "./types.ts";
import { isHttpUrl } from "./url.ts";

export type ToolWiring = {
  tools: ToolRegistry;
  /** News categories that ended up with a usable feed behind them. */
  newsCategories: string[];
};

export function registerTools(cfg: Config, log: Log): ToolWiring {
  // The built-ins need nothing but the session itself — clock, last reply,
  // language, pace, memory. Deployment-specific tools (anything that talks to
  // your backend) get registered alongside them here; entitlement filtering and
  // deadlines are handled by the registry and executor.
  const tools = new ToolRegistry();
  for (const spec of BUILTIN_TOOLS) tools.register(spec);

  // Registered only where the worker is actually writing signals. Otherwise the
  // model would carry a tool whose only possible answer is "nothing recorded".
  if (cfg.careSignalsEnabled) tools.register(createRecallMood());

  // The external tools, registered ONLY where the deployment configured one.
  // Unconfigured means unregistered means never described to the user — an agent
  // that offers the weather and then cannot fetch it is worse than one that never
  // mentioned it (src/tools/registry.ts, `offerableTo`).
  if (cfg.weatherEnabled) {
    tools.register(
      createGetWeather({
        apiBase: cfg.weatherApiBase,
        geocodeBase: cfg.weatherGeocodeBase,
        defaultPlace: cfg.weatherDefaultPlace,
        countryBias: cfg.weatherCountryBias,
        pincodeApiBase: cfg.weatherPincodeApiBase,
      }),
    );
  }

  // Only categories with a real feed URL behind them. An unknown key in
  // NEWS_FEEDS is dropped here rather than reaching the model as an enum value
  // it would then pick and get nothing from.
  const newsFeeds: Partial<Record<NewsCategory, string>> = {};
  for (const category of NEWS_CATEGORIES) {
    const url = cfg.newsFeeds[category];
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
    newsFeeds[category] = url;
  }

  // Orphan segments mean a value contained a comma and was cut in half. The
  // surviving half still parses as a URL and passes every check above, so this
  // warning is the ONLY evidence the operator gets before the feed 404s in
  // front of a user. See parsePairs in src/config/env.ts.
  if (cfg.newsFeedsDropped.length > 0) {
    log("error", "NEWS_FEEDS has unreadable segments — a feed URL is likely truncated", {
      dropped: cfg.newsFeedsDropped,
      hint: "percent-encode a literal comma in a feed URL as %2C",
      parsed: newsFeeds,
    });
  }
  const unknownFeeds = Object.keys(cfg.newsFeeds).filter(
    (k) => !(NEWS_CATEGORIES as readonly string[]).includes(k),
  );
  if (unknownFeeds.length > 0) {
    log("warn", "NEWS_FEEDS has categories this build does not know", {
      ignored: unknownFeeds,
      known: [...NEWS_CATEGORIES],
    });
  }
  if (Object.keys(newsFeeds).length > 0) {
    tools.register(createGetNews({ feeds: newsFeeds, limit: cfg.newsHeadlineLimit }));
  }

  // Music. The catalogue is filled ONCE at boot and then on a timer — never in a
  // turn, where a 4.4 s directory query would blow every deadline in the system.
  let radio: RadioCatalogue | null = null;
  if (cfg.musicEnabled) {
    radio = new RadioCatalogue({
      apiBase: cfg.musicRadioApi,
      languages: SPEAKABLE.map((l) => l.code),
      fallbackLanguage: cfg.musicFallbackLanguage,
      perLanguage: cfg.musicStationsPerLanguage,
      secureOnly: cfg.musicSecureOnly,
      log,
    });

    // Boot does not WAIT for it. The directory is a volunteer server and may be
    // slow or down; a companion that will not start because radio is unreachable
    // has its priorities backwards. The tool reports no stations until it fills.
    void radio.refresh().catch((err: unknown) => {
      log("error", "initial radio refresh failed — music starts with no stations", {
        err: err instanceof Error ? err.message : String(err),
      });
    });

    const everyMs = Math.max(1, cfg.musicRefreshMinutes) * 60_000;
    setInterval(() => {
      void radio!.refresh().catch(() => {});
    }, everyMs).unref?.();

    // Stop phrases are the one copy table where a bad translation means the
    // music DOES NOT STOP. Louder than the other review warnings for that reason.
    const pending = pendingStopReview();
    if (pending.length > 0) {
      log("warn", "stop-the-music phrases are unreviewed — music may not stop in these", {
        languages: pending,
        note: "src/copy/stop-intent.ts — a native speaker must confirm before shipping",
      });
    }

    tools.register(
      createPlayMusic({
        catalogue: radio,
        youtubeApiKey: cfg.youtubeApiKey,
        youtubeApiBase: cfg.youtubeApiBase,
      }),
    );
  }

  return { tools, newsCategories: Object.keys(newsFeeds) };
}
