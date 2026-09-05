/**
 * get_weather and get_news — the first two tools that leave the process.
 *
 * Everything here runs against an injected fetcher. No test in this file opens a
 * socket, which is the point of `HttpFetch` being a dependency: a suite that
 * needs Open-Meteo to be up is a suite that fails for reasons unrelated to the
 * code under test.
 *
 * The distinction these tests exist to pin down is the one the file header of
 * builtin.ts calls the rule: A DOMAIN OUTCOME IS DATA, NOT AN ERROR. "That city
 * does not exist" must come back as `{found:false}` and cost nothing; a 503 must
 * throw, so the executor spends the reviewed `tool.unavailable` copy on it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGetWeather } from "../src/tools/weather.ts";
import { NEWS_CATEGORIES, createGetNews, parseFeedTitles } from "../src/tools/news.ts";
import type { HttpFetch } from "@sp-i/shared/providers/http.ts";
import { ToolRegistry, toSchema, validateArgs } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { invocation } from "./helpers.ts";

/** A fetcher that answers from a table and records what it was asked for. */
function stubFetch(
  routes: Array<{ match: string; status?: number; body: string }>,
): HttpFetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`unstubbed URL: ${url}`);
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => hit.body };
  }) as HttpFetch & { urls: string[] };
  fn.urls = urls;
  return fn;
}

const GEO_OK = JSON.stringify({
  results: [
    { name: "Bengaluru", admin1: "Karnataka", country: "India", latitude: 12.97, longitude: 77.59 },
  ],
});

const FORECAST_OK = JSON.stringify({
  current: {
    temperature_2m: 30.7,
    apparent_temperature: 33.2,
    relative_humidity_2m: 64.4,
    weather_code: 61,
    wind_speed_10m: 11.6,
  },
  daily: {
    temperature_2m_max: [32.4],
    temperature_2m_min: [21.8],
    precipitation_probability_max: [70],
  },
});

function weather(
  fetch: HttpFetch,
  defaultPlace: string | null = null,
  over: Partial<Parameters<typeof createGetWeather>[0]> = {},
) {
  return createGetWeather({
    apiBase: "https://wx.test",
    geocodeBase: "https://geo.test",
    defaultPlace,
    countryBias: null,
    pincodeApiBase: null,
    fetch,
    ...over,
  });
}

/** Register through the registry so defaults are applied, as in production. */
function defined(spec: ReturnType<typeof weather>): ToolDefinition {
  return new ToolRegistry().register(spec).get(spec.name)!;
}

describe("get_weather", () => {
  it("returns rounded, speakable numbers from a live-shaped response", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const out = await weather(fetch).handler({ place: "Bengaluru" }, invocation());

    assert.equal(out["found"], true);
    assert.equal(out["place"], "Bengaluru, Karnataka, India");
    assert.equal(out["conditions"], "light rain");
    // Rounded: a decimal point here becomes a spoken "point seven".
    assert.equal(out["temperature_c"], 31);
    assert.equal(out["feels_like_c"], 33);
    assert.equal(out["humidity_pct"], 64);
    assert.equal(out["today_high_c"], 32);
    assert.equal(out["today_low_c"], 22);
    assert.equal(out["rain_chance_pct"], 70);
  });

  it("URL-encodes a place name in a non-Latin script", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    await weather(fetch).handler({ place: "मुंबई" }, invocation());
    assert.ok(fetch.urls[0]!.includes(encodeURIComponent("मुंबई")));
  });

  it("treats an unfindable place as DATA, not an error", async () => {
    const fetch = stubFetch([{ match: "geo.test", body: JSON.stringify({ results: [] }) }]);
    const out = await weather(fetch).handler({ place: "Nowherecity" }, invocation());

    assert.equal(out["found"], false);
    assert.equal(out["reason"], "unknown_place");
    // Echoed back so the model can say WHICH place it could not find.
    assert.equal(out["place"], "Nowherecity");
  });

  it("falls back to the configured place only when the model sends a blank", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    await weather(fetch, "Pune").handler({ place: "   " }, invocation());
    assert.ok(fetch.urls[0]!.includes("Pune"));
  });

  it("asks rather than guesses when there is no place and no default", async () => {
    const fetch = stubFetch([]);
    const out = await weather(fetch, null).handler({ place: "" }, invocation());

    assert.equal(out["found"], false);
    assert.equal(out["reason"], "no_place_given");
    // The critical half: it must not have invented a city and gone looking.
    assert.deepEqual(fetch.urls, []);
  });

  it("throws on an upstream failure so the executor speaks tool.unavailable", async () => {
    const fetch = stubFetch([{ match: "geo.test", status: 503, body: "upstream down" }]);
    await assert.rejects(
      () => weather(fetch).handler({ place: "Bengaluru" }, invocation()),
      /HTTP 503/,
    );
  });

  it("throws on a 200 that is not JSON — an HTML error page is still a failure", async () => {
    const fetch = stubFetch([{ match: "geo.test", body: "<html>gateway timeout</html>" }]);
    await assert.rejects(
      () => weather(fetch).handler({ place: "Bengaluru" }, invocation()),
      /unparseable JSON/,
    );
  });

  it("survives a forecast missing the fields we map", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: JSON.stringify({}) },
    ]);
    const out = await weather(fetch).handler({ place: "Bengaluru" }, invocation());

    // Found, but unclear — never a thrown error over a missing optional field.
    assert.equal(out["found"], true);
    assert.equal(out["conditions"], "unclear");
  });

  it("carries the progress line that has been waiting since slice 6", () => {
    const def = defined(weather(stubFetch([])));
    assert.equal(def.progress_key, "progress.weather");
    // A filler pinned at or above the deadline could never fire — the built-ins
    // do that deliberately, and these two must not.
    assert.ok(def.filler_threshold_ms < def.deadline_ms);
  });
});

describe("get_news", () => {
  const RSS = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[India win by <b>five</b> wickets]]></title><pubDate>Sat, 30 Aug 2026 09:00:00 +0530</pubDate></item>
    <item><title>Markets rise on Tata &amp; Reliance gains</title><pubDate>Sat, 30 Aug 2026 08:30:00 +0530</pubDate></item>
    <item><title>Third headline</title></item>
  </channel></rss>`;

  function news(
    fetch: HttpFetch,
    feeds = { sports: "https://feed.test/sport.rss" },
    limit?: number,
  ) {
    return createGetNews({ feeds, fetch, ...(limit === undefined ? {} : { limit }) });
  }

  it("returns cleaned, speakable headlines", async () => {
    const fetch = stubFetch([{ match: "feed.test", body: RSS }]);
    const out = await news(fetch).handler({ category: "sports" }, invocation());

    assert.equal(out["found"], 3);
    const headlines = out["headlines"] as Array<{ title: string }>;
    // CDATA unwrapped and inline markup stripped — Bulbul would read "<b>" aloud.
    assert.equal(headlines[0]!.title, "India win by five wickets");
    // Entity decoded: "&amp;" spoken verbatim is five characters of nonsense.
    assert.equal(headlines[1]!.title, "Markets rise on Tata & Reliance gains");
  });

  it("offers only the categories the deployment actually configured", () => {
    const spec = news(stubFetch([]), { sports: "https://feed.test/sport.rss" });
    assert.deepEqual(spec.parameters.properties["category"]!.enum, ["sports"]);

    // And the model cannot get past validation with one we never wired.
    const def = new ToolRegistry().register(spec).get("get_news")!;
    assert.equal(validateArgs(def, { category: "business" }).ok, false);
  });

  it("treats an unconfigured category as DATA, listing what it does have", async () => {
    const fetch = stubFetch([]);
    const spec = createGetNews({ feeds: { top: "https://feed.test/top.rss" }, fetch });
    const out = await spec.handler({ category: "sports" }, invocation());

    assert.equal(out["found"], 0);
    assert.equal(out["reason"], "category_unavailable");
    // So the model can offer the alternative instead of just apologising.
    assert.deepEqual(out["available"], ["top"]);
    assert.deepEqual(fetch.urls, []);
  });

  it("honours the headline limit — this is read aloud, not scrolled", async () => {
    const fetch = stubFetch([{ match: "feed.test", body: RSS }]);
    const out = await news(fetch, { sports: "https://feed.test/sport.rss" }, 2).handler(
      { category: "sports" },
      invocation(),
    );
    assert.equal(out["found"], 2);
  });

  it("reports an empty feed as data rather than throwing", async () => {
    const fetch = stubFetch([{ match: "feed.test", body: "<rss><channel></channel></rss>" }]);
    const out = await news(fetch).handler({ category: "sports" }, invocation());

    assert.equal(out["found"], 0);
    assert.equal(out["reason"], "feed_empty");
  });

  it("throws when the feed itself is down", async () => {
    const fetch = stubFetch([{ match: "feed.test", status: 500, body: "" }]);
    await assert.rejects(
      () => news(fetch).handler({ category: "sports" }, invocation()),
      /HTTP 500/,
    );
  });

  it("carries progress.news", () => {
    const def = new ToolRegistry().register(news(stubFetch([]))).get("get_news")!;
    assert.equal(def.progress_key, "progress.news");
    assert.ok(def.filler_threshold_ms < def.deadline_ms);
  });
});

describe("RSS parsing — only what a headline needs", () => {
  it("reads Atom <entry> with the same two patterns as RSS <item>", () => {
    const atom = `<feed><entry><title>Atom headline</title><updated>2026-08-30T09:00:00Z</updated></entry></feed>`;
    const out = parseFeedTitles(atom, 5);

    assert.equal(out.length, 1);
    assert.equal(out[0]!.title, "Atom headline");
    assert.equal(out[0]!.published, "2026-08-30T09:00:00Z");
  });

  it("skips items with an empty title rather than emitting a blank headline", () => {
    const xml = `<rss><item><title></title></item><item><title>Real one</title></item></rss>`;
    const out = parseFeedTitles(xml, 5);

    assert.equal(out.length, 1);
    assert.equal(out[0]!.title, "Real one");
  });

  it("collapses the whitespace a pretty-printed feed leaves in a title", () => {
    const xml = `<rss><item><title>\n      Spread   over\n      lines\n    </title></item></rss>`;
    assert.equal(parseFeedTitles(xml, 5)[0]!.title, "Spread over lines");
  });

  it("decodes numeric entities, which Indian outlets use for curly quotes", () => {
    const xml = `<rss><item><title>It&#39;s here &#8212; finally</title></item></rss>`;
    assert.equal(parseFeedTitles(xml, 5)[0]!.title, "It's here — finally");
  });

  it("returns nothing for a body that is not a feed at all", () => {
    assert.deepEqual(parseFeedTitles("<html><body>404</body></html>", 5), []);
    assert.deepEqual(parseFeedTitles("", 5), []);
  });

  it("has no published date when the feed omits one", () => {
    assert.equal(
      parseFeedTitles("<rss><item><title>Bare</title></item></rss>", 5)[0]!.published,
      null,
    );
  });
});

describe("both tools, as the model is shown them", () => {
  it("emit strict schemas — every declared property is required", () => {
    const specs = [
      weather(stubFetch([])),
      createGetNews({ feeds: { top: "https://feed.test/top.rss" }, fetch: stubFetch([]) }),
    ];

    for (const spec of specs) {
      const schema = toSchema(new ToolRegistry().register(spec).get(spec.name)!);
      assert.equal(schema.function.strict, true, `${spec.name} should conform to strict mode`);
    }
  });

  it("stay out of the zero-configuration list", async () => {
    const { BUILTIN_TOOLS } = await import("../src/tools/builtin.ts");
    const names = BUILTIN_TOOLS.map((t) => t.name);

    // The whole reason they are factories: a deployment that configured neither
    // must not offer either. See the divider above createGetWeather.
    assert.equal(names.includes("get_weather"), false);
    assert.equal(names.includes("get_news"), false);
  });

  it("every news category has progress copy behind it", async () => {
    // Not decorative: an unconfigured ProgressKey resolves to nothing, and the
    // filler is what covers the ~78% of tool turns the model starts silently.
    assert.ok(NEWS_CATEGORIES.length > 0);
    const { PROGRESS } = await import("../src/copy/fillers.ts");
    assert.ok(PROGRESS["progress.news"]);
    assert.ok(PROGRESS["progress.weather"]);
  });
});

/**
 * Place resolution — the half of get_weather that decides WHICH place.
 *
 * ⚠ THESE ARE REGRESSION TESTS FOR A LIVE DEFECT, not hypotheticals. Asked for
 * "Allahabad" against the real Open-Meteo geocoder, the first version of this
 * tool returned the weather for Allāhābād, Razavi Khorasan, IRAN — 3,000 km away,
 * fluent, plausible, and completely wrong. The global ranking for that name is
 * ten Iranian villages deep with no Indian hit at all.
 *
 * That is the worst failure shape in this file: not an error the model can
 * narrate, but a confident answer nobody listening can detect. Every test below
 * exists to keep one of its causes closed.
 */

const PINCODE_OK = JSON.stringify([
  {
    Status: "Success",
    PostOffice: [{ Name: "Cavellary Lines", District: "Allahabad", State: "Uttar Pradesh" }],
  },
]);

const GEO_PRAYAGRAJ = JSON.stringify({
  results: [
    {
      name: "Prayagraj",
      admin1: "Uttar Pradesh",
      country: "India",
      country_code: "IN",
      latitude: 25.44,
      longitude: 81.84,
    },
  ],
});

describe("get_weather — resolving which place was meant", () => {
  it("sends the CURRENT name to the geocoder when the user says the old one", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_PRAYAGRAJ },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const out = await weather(fetch).handler({ place: "Allahabad" }, invocation());

    // The whole defect in one assertion: "Allahabad" must never reach the
    // geocoder, because the geocoder's answer for it is in Iran.
    assert.ok(fetch.urls[0]!.includes("Prayagraj"), "should have looked up Prayagraj");
    assert.ok(!fetch.urls[0]!.includes("Allahabad"));
    assert.equal(out["place"], "Prayagraj, Uttar Pradesh, India");
    // Echoed back so the model can confirm the substitution out loud — the only
    // way a listener catches a wrong resolution.
    assert.equal(out["asked_for"], "Allahabad");
  });

  it("aliases are case-insensitive and cover the common renames", async () => {
    for (const [said, expected] of [
      ["BOMBAY", "Mumbai"],
      ["calcutta", "Kolkata"],
      ["Madras", "Chennai"],
      ["bangalore", "Bengaluru"],
      ["Gurgaon", "Gurugram"],
    ] as const) {
      const fetch = stubFetch([
        { match: "geo.test", body: GEO_PRAYAGRAJ },
        { match: "wx.test", body: FORECAST_OK },
      ]);
      await weather(fetch).handler({ place: said }, invocation());
      assert.ok(fetch.urls[0]!.includes(expected), `${said} should resolve to ${expected}`);
    }
  });

  it("matches a whole name only — 'New Bombay' is not 'New Mumbai'", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_PRAYAGRAJ },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    await weather(fetch).handler({ place: "New Bombay" }, invocation());
    assert.ok(fetch.urls[0]!.includes(encodeURIComponent("New Bombay")));
  });

  it("tries the biased country FIRST, so a shared name stays in India", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_PRAYAGRAJ },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    await weather(fetch, null, { countryBias: "IN" }).handler({ place: "Prayagraj" }, invocation());
    assert.ok(fetch.urls[0]!.includes("countryCode=IN"));
  });

  it("BUT retries unbiased, so the companion still answers about London", async () => {
    // Exactly what the live API does: countryCode=IN for London returns nothing.
    const fetch = stubFetch([
      { match: "countryCode=IN", body: JSON.stringify({ results: [] }) },
      { match: "geo.test", body: GEO_PRAYAGRAJ },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const out = await weather(fetch, null, { countryBias: "IN" }).handler(
      { place: "London" },
      invocation(),
    );

    assert.equal(out["found"], true);
    assert.equal(fetch.urls.filter((u) => u.includes("geo.test")).length, 2, "should have retried");
    assert.ok(!fetch.urls[1]!.includes("countryCode"));
  });

  it("resolves a six-digit pincode through India Post, then de-aliases it", async () => {
    const fetch = stubFetch([
      { match: "post.test", body: PINCODE_OK },
      { match: "geo.test", body: GEO_PRAYAGRAJ },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const out = await weather(fetch, null, { pincodeApiBase: "https://post.test" }).handler(
      { place: "211004" },
      invocation(),
    );

    assert.ok(fetch.urls[0]!.includes("/pincode/211004"));
    // India Post returns the PRE-RENAME district, so the alias table has to run
    // on its output too. This is why the pincode path was not enough on its own.
    assert.ok(fetch.urls[1]!.includes("Prayagraj"));
    assert.equal(out["asked_for"], "211004");
  });

  it("treats an unrecognised pincode as data, not a failure", async () => {
    const fetch = stubFetch([
      { match: "post.test", body: JSON.stringify([{ Status: "Error", PostOffice: null }]) },
    ]);
    const out = await weather(fetch, null, { pincodeApiBase: "https://post.test" }).handler(
      { place: "999999" },
      invocation(),
    );

    assert.equal(out["found"], false);
    assert.equal(out["reason"], "unknown_pincode");
  });

  it("does not take the whole tool down when the pincode service is broken", async () => {
    const fetch = stubFetch([{ match: "post.test", status: 502, body: "" }]);
    const out = await weather(fetch, null, { pincodeApiBase: "https://post.test" }).handler(
      { place: "211004" },
      invocation(),
    );

    // A degraded lookup, spoken as "I couldn't find that" — not a thrown
    // upstream_error that spends the reviewed unavailable copy.
    assert.equal(out["found"], false);
    assert.equal(out["reason"], "unknown_pincode");
  });

  it("asks for a place name when pincode support is switched off", async () => {
    const fetch = stubFetch([]);
    const out = await weather(fetch, null, { pincodeApiBase: null }).handler(
      { place: "211004" },
      invocation(),
    );

    assert.equal(out["found"], false);
    assert.equal(out["reason"], "unknown_pincode");
    assert.deepEqual(fetch.urls, [], "must not geocode a bare number");
  });

  it("stays quiet about substitution when there was none", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_PRAYAGRAJ },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const out = await weather(fetch).handler({ place: "Prayagraj" }, invocation());
    assert.equal("asked_for" in out, false);
  });
});

/**
 * NEWS_FEEDS parsing — where a feed URL goes to die quietly.
 *
 * Verified against the live config loader, because the first version of the
 * documentation for this got it backwards: it warned that "&" was the dangerous
 * character (it is not) and said nothing about "," (which is). A comma inside a
 * query string cuts the value in half, the half 404s at request time, and the
 * user hears "I can't check the news" with nothing in the log pointing at
 * NEWS_FEEDS. server.ts refuses a non-URL at boot for exactly that reason.
 */
describe("NEWS_FEEDS parsing", () => {
  /** Load the config fresh with one NEWS_FEEDS value, hermetically. */
  async function load(raw: string): Promise<{
    news: { feeds: Record<string, string>; feedsDropped: string[] };
  }> {
    const saved = process.env;
    try {
      process.env = { SARVAM_API_KEY: "test-key", NEWS_FEEDS: raw };
      const mod = await import(`@sp-i/shared/config/env.ts?feeds=${encodeURIComponent(raw)}`);
      return (
        mod as {
          loadConfig: () => { news: { feeds: Record<string, string>; feedsDropped: string[] } };
        }
      ).loadConfig();
    } finally {
      process.env = saved;
    }
  }

  const parse = async (raw: string) => (await load(raw)).news.feeds;

  it("keeps an ampersand — Google News URLs survive intact", async () => {
    const out = await parse("top=https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en");
    assert.equal(out["top"], "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en");
  });

  it("splits on the FIRST equals only, so query parameters survive", async () => {
    const out = await parse("top=https://x.test/rss?hl=en-IN&a=b");
    assert.equal(out["top"], "https://x.test/rss?hl=en-IN&a=b");
  });

  it("trims whitespace around both halves", async () => {
    const out = await parse("  top = https://x.test/rss , sports = https://y.test/s.rss  ");
    assert.deepEqual(out, { top: "https://x.test/rss", sports: "https://y.test/s.rss" });
  });

  it("TRUNCATES on a comma inside a URL — the documented hazard", async () => {
    const out = await parse("top=https://x.test/rss?ids=1,2,3,sports=https://y.test/s.rss");

    // This is the defect the boot-time URL check exists to catch. Asserted
    // rather than fixed: percent-encoding is the documented answer, and a
    // parser that guesses where a URL ends is worse than one that is honest.
    assert.equal(out["top"], "https://x.test/rss?ids=1");
    assert.equal(out["sports"], "https://y.test/s.rss");

    // And the ONLY evidence it happened. The surviving half is a perfectly
    // valid URL, so no amount of URL checking catches this — the orphans are
    // what server.ts warns on.
    const cfg = await load("top=https://x.test/rss?ids=1,2,3,sports=https://y.test/s.rss");
    assert.deepEqual(cfg.news.feedsDropped, ["2", "3"]);
  });

  it("reports nothing dropped for a clean config", async () => {
    const cfg = await load("top=https://x.test/rss?a=1&b=2,sports=https://y.test/s.rss");
    assert.deepEqual(cfg.news.feedsDropped, []);
  });

  it("survives a percent-encoded comma, which is the documented workaround", async () => {
    const out = await parse("top=https://x.test/rss?ids=1%2C2%2C3");
    assert.equal(out["top"], "https://x.test/rss?ids=1%2C2%2C3");
  });

  it("drops malformed pairs rather than inventing a category", async () => {
    const out = await parse("top=https://x.test/rss,garbage,=https://y.test,empty=");
    assert.deepEqual(out, { top: "https://x.test/rss" });
  });

  it("is empty when unset, so no feed means no tool", async () => {
    assert.deepEqual(await parse(""), {});
  });
});

describe("a truncated feed URL is refused, not fetched", () => {
  /** Mirrors the guard in server.ts. */
  function isHttpUrl(value: string): boolean {
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  it("accepts a real feed URL", () => {
    assert.equal(isHttpUrl("https://www.thehindu.com/sport/feeder/default.rss"), true);
    assert.equal(isHttpUrl("http://x.test/rss?a=1&b=2"), true);
  });

  it("rejects the wreckage a comma leaves behind", () => {
    // What survives `NEWS_FEEDS=top=https://x.test/rss,2,3` after the split.
    assert.equal(isHttpUrl("2"), false);
    assert.equal(isHttpUrl(""), false);
    assert.equal(isHttpUrl("thehindu.com/sport.rss"), false, "no scheme is not a URL");
  });

  it("rejects a scheme that is not http(s)", () => {
    // A file: or data: URL here would be an SSRF-shaped surprise, not a feed.
    assert.equal(isHttpUrl("file:///etc/passwd"), false);
    assert.equal(isHttpUrl("ftp://x.test/rss"), false);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe("what these tools stop asking for twice", () => {
  // A local copy: the RSS fixture above is scoped to its own describe block,
  // and reaching into it would couple two suites that have nothing to do with
  // each other.
  const FEED = `<?xml version="1.0"?><rss><channel>
    <item><title>Monsoon reaches the coast</title><pubDate>Mon, 01 Sep 2026 06:00:00 GMT</pubDate></item>
    <item><title>Metro line opens</title></item>
  </channel></rss>`;

  it("geocodes a place once and forecasts it again", async () => {
    // The two hops have completely different lifetimes and this is what that
    // buys: a second question about the same city half an hour later re-reads
    // the weather without re-asking where the city is.
    let clock = 0;
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const tool = weather(fetch, null, { now: () => clock });

    await tool.handler({ place: "Bengaluru" }, invocation());
    clock = 20 * 60_000; // past the forecast window, nowhere near the geocode one
    await tool.handler({ place: "Bengaluru" }, invocation());

    assert.equal(fetch.urls.filter((u) => u.includes("geo.test")).length, 1);
    assert.equal(fetch.urls.filter((u) => u.includes("wx.test")).length, 2);
  });

  it("asks upstream nothing at all for a repeated question", async () => {
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const tool = weather(fetch, null, { now: () => 0 });

    await tool.handler({ place: "Bengaluru" }, invocation());
    const after = fetch.urls.length;
    const out = await tool.handler({ place: "Bengaluru" }, invocation());

    assert.equal(fetch.urls.length, after);
    assert.equal(out["found"], true);
    assert.equal(out["temperature_c"], 31);
  });

  it("treats one place said three ways as one place", async () => {
    // Case-insensitive, and through the rename table: "BANGALORE", "bangalore"
    // and "Bengaluru" are the same city and the same coordinates.
    const fetch = stubFetch([
      { match: "geo.test", body: GEO_OK },
      { match: "wx.test", body: FORECAST_OK },
    ]);
    const tool = weather(fetch, null, { now: () => 0 });

    for (const place of ["Bengaluru", "BENGALURU", "bangalore"]) {
      assert.equal((await tool.handler({ place }, invocation()))["found"], true);
    }
    assert.equal(fetch.urls.filter((u) => u.includes("geo.test")).length, 1);
  });

  it("does not remember a place it could not find", async () => {
    // A geocoder returning nothing means "no such place" or "the index is
    // rebuilding", and nothing here can tell those apart. Filing the first
    // answer for a day would make one bad minute a permanent gap.
    const fetch = stubFetch([{ match: "geo.test", body: JSON.stringify({ results: [] }) }]);
    const tool = weather(fetch, null, { now: () => 0 });

    assert.equal((await tool.handler({ place: "Nowhere" }, invocation()))["found"], false);
    assert.equal((await tool.handler({ place: "Nowhere" }, invocation()))["found"], false);
    assert.equal(fetch.urls.length, 2);
  });

  it("still throws on a geocoder that is down, rather than saying no such place", async () => {
    // The distinction the cache had to preserve: a 503 is infrastructure and
    // must reach the reviewed `tool.unavailable` copy. Saying "I couldn't find
    // that place" about a place that exists is a confident wrong answer.
    const fetch = stubFetch([{ match: "geo.test", status: 503, body: "upstream down" }]);
    await assert.rejects(
      () => weather(fetch, null, { now: () => 0 }).handler({ place: "Pune" }, invocation()),
      /HTTP 503/,
    );
  });

  it("fetches a feed once for two questions inside the window", async () => {
    let clock = 0;
    const fetch = stubFetch([{ match: "feed.test", body: FEED }]);
    const tool = createGetNews({
      feeds: { top: "https://feed.test/top.rss" },
      fetch,
      now: () => clock,
    });

    await tool.handler({ category: "top" }, invocation());
    clock = 4 * 60_000;
    const out = await tool.handler({ category: "top" }, invocation());

    assert.equal(fetch.urls.length, 1);
    assert.ok(Number(out["found"]) > 0);

    clock = 5 * 60_000;
    await tool.handler({ category: "top" }, invocation());
    assert.equal(fetch.urls.length, 2);
  });

  it("shares one fetch between two categories pointed at the same feed", async () => {
    // Keyed by URL, not by category — which is what an operator who set `top`
    // and `world` to the same wire service has actually asked for.
    const fetch = stubFetch([{ match: "feed.test", body: FEED }]);
    const tool = createGetNews({
      feeds: { top: "https://feed.test/all.rss", world: "https://feed.test/all.rss" },
      fetch,
      now: () => 0,
    });

    await tool.handler({ category: "top" }, invocation());
    await tool.handler({ category: "world" }, invocation());
    assert.equal(fetch.urls.length, 1);
  });

  it("makes one request when three conversations ask at once", async () => {
    // The morning in a house with two devices. All three arrive before the
    // first response lands, so a cache checked only on entry misses all three.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const fetch: HttpFetch = async () => {
      calls++;
      await gate;
      return { ok: true, status: 200, text: async () => FEED };
    };
    const tool = createGetNews({
      feeds: { top: "https://feed.test/top.rss" },
      fetch,
      now: () => 0,
    });

    const asks = Promise.all([
      tool.handler({ category: "top" }, invocation()),
      tool.handler({ category: "top" }, invocation()),
      tool.handler({ category: "top" }, invocation()),
    ]);
    release();
    const results = await asks;

    assert.equal(calls, 1);
    for (const out of results) assert.ok(Number(out["found"]) > 0);
  });

  it("caches nothing when the window is zero", async () => {
    // NEWS_CACHE_SECONDS=0, the switch for somebody chasing a stale headline.
    const fetch = stubFetch([{ match: "feed.test", body: FEED }]);
    const tool = createGetNews({
      feeds: { top: "https://feed.test/top.rss" },
      fetch,
      cacheMs: 0,
    });

    await tool.handler({ category: "top" }, invocation());
    await tool.handler({ category: "top" }, invocation());
    assert.equal(fetch.urls.length, 2);
  });
});
