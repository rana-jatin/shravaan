/**
 * `get_weather` — Open-Meteo, no key required.
 *
 * Split out of tools/builtin.ts, which had grown to hold three unrelated
 * upstreams. See tools/external.ts for the residency argument that governs
 * this tool and the deadline it runs under.
 */

import { getJson, nodeFetch, type HttpFetch } from "@sp-i/shared/providers/http.ts";
import { TtlCache } from "../domain/ttl-cache.ts";
import type { ToolSpec } from "./registry.ts";
import { NETWORK_FILLER_MS, NETWORK_MS } from "./external.ts";

/**
 * WMO 4677 weather codes, as Open-Meteo reports them.
 *
 * English tokens, deliberately — same rule as `enum` in tools/types.ts. The model
 * is bilingual and will render "light drizzle" into Odia; a translated table here
 * would only give it eleven ways to be inconsistent.
 */
const WMO_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "heavy drizzle",
  56: "light freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with light hail",
  99: "thunderstorm with heavy hail",
};

/**
 * Renamed Indian cities, old name → the one the geocoder indexes.
 *
 * ⚠ THIS TABLE IS NOT A CONVENIENCE. It was added after a live call returned
 * weather for ALLĀHĀBĀD, RAZAVI KHORASAN, IRAN when asked for "Allahabad" —
 * confidently, with a plausible temperature, and with nothing in the response to
 * suggest it was the wrong continent. Open-Meteo's index carries only the current
 * name, and its global ranking for "Allahabad" is ten Iranian villages deep with
 * no Indian hit at all, so no amount of country biasing reaches Prayagraj.
 *
 * The users this product is for are exactly the ones who say the old names. An
 * elderly caller in Prayagraj has said "Allahabad" their whole life. Getting
 * Iranian weather for it is the worst failure shape this file has: not an error
 * the model can narrate, but a fluent, wrong answer nobody can detect.
 *
 * Lowercased keys; matched on the whole trimmed string, never a substring —
 * "New Bombay" must not silently become "New Mumbai".
 */
const PLACE_ALIASES: Record<string, string> = {
  allahabad: "Prayagraj",
  bombay: "Mumbai",
  calcutta: "Kolkata",
  madras: "Chennai",
  bangalore: "Bengaluru",
  mysore: "Mysuru",
  poona: "Pune",
  gurgaon: "Gurugram",
  baroda: "Vadodara",
  trivandrum: "Thiruvananthapuram",
  cochin: "Kochi",
  calicut: "Kozhikode",
  simla: "Shimla",
  benares: "Varanasi",
  banaras: "Varanasi",
  pondicherry: "Puducherry",
  panjim: "Panaji",
  cawnpore: "Kanpur",
  jubbulpore: "Jabalpur",
  waltair: "Visakhapatnam",
};

/** Six digits and nothing else. India Post's format. */
const PINCODE = /^\d{6}$/;

export type WeatherDeps = {
  /** Forecast host. Open-Meteo's shape is assumed by the response mapping. */
  apiBase: string;
  /** Geocoding host. A place name is useless to the forecast API without it. */
  geocodeBase: string;
  /**
   * Used only when the model sends a blank place. Not a substitute for asking:
   * a companion guessing the wrong city is confidently wrong, which is the
   * failure `defaultTimezone` carries the same warning about.
   */
  defaultPlace: string | null;
  /**
   * ISO country code tried FIRST, then abandoned. A preference, not a filter:
   * the biased query for "London" comes back empty and the unbiased retry finds
   * the right one, so an India-first companion still answers about Britain.
   *
   * Null disables the bias entirely and takes the geocoder's global ranking.
   */
  countryBias: string | null;
  /**
   * India Post pincode lookup. Null disables pincode support.
   *
   * Worth noting for the residency ledger: this host is IN INDIA, so the one
   * lookup a user is most likely to phrase as a number never leaves the country.
   * It is the geocoding and forecast hops that do.
   */
  pincodeApiBase: string | null;
  /**
   * How long a resolved place keeps its coordinates. Zero disables caching.
   *
   * A DAY, AND IT COULD HONESTLY BE LONGER. Pune's latitude does not change,
   * and neither does the district a PIN code sits in. The only reason it is not
   * permanent is that a cache with no expiry is one nobody can fix without a
   * restart — and the rename table above exists precisely because a geocoder's
   * answer for an Indian city name is a thing that HAS changed.
   *
   * This is the hop worth caching hardest: two round trips, and the one that
   * repeats most, because the same few places are asked about all day.
   */
  geocodeCacheMs?: number;
  /**
   * How long a forecast stays fresh. Zero disables caching.
   *
   * Ten minutes. Open-Meteo publishes on a fifteen-minute cadence, so a shorter
   * window buys the same numbers at more cost; a longer one risks a companion
   * saying it is dry through the first ten minutes of rain.
   */
  forecastCacheMs?: number;
  fetch?: HttpFetch;
  now?: () => number;
};

const DEFAULT_GEOCODE_CACHE_MS = 24 * 60 * 60_000;
const DEFAULT_FORECAST_CACHE_MS = 10 * 60_000;

type Forecast = { current?: Record<string, number>; daily?: Record<string, unknown[]> };

/**
 * A geocoder hit that actually carries coordinates.
 *
 * Every field on `GeocodeHit` is optional because the upstream's are, and the
 * latitude check used to live at the one call site that needed it. Now that a
 * hit is stored and read back, the guarantee has to travel with the value —
 * otherwise the check happens on the way in and is re-litigated on the way out.
 */
type ResolvedPlace = GeocodeHit & { latitude: number; longitude: number };

/**
 * A place the geocoder genuinely has no entry for.
 *
 * A SENTINEL RATHER THAN A `null` RETURN, because the lookup now happens inside
 * a cached load and the cache stores what the loader returns. Returning null
 * would file "we could not find it" as the answer for a day; throwing keeps the
 * miss out of the cache while still letting the caller turn it into the domain
 * outcome the model needs.
 */
class UnknownPlace extends Error {
  constructor(place: string) {
    super(`no geocoding result for ${place}`);
    this.name = "UnknownPlace";
  }
}

type GeocodeHit = {
  name?: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
};

export function createGetWeather(deps: WeatherDeps): ToolSpec {
  const fetcher = deps.fetch ?? nodeFetch();
  const clock = deps.now ? { now: deps.now } : {};

  // THREE CACHES, NOT ONE, because the three answers go stale at completely
  // different rates: a coordinate effectively never, a forecast in minutes.
  // One shared lifetime would mean either re-geocoding Pune every ten minutes
  // or telling somebody it is dry a day after it started raining.
  const geocodeCache = new TtlCache<ResolvedPlace>({
    ttlMs: deps.geocodeCacheMs ?? DEFAULT_GEOCODE_CACHE_MS,
    ...clock,
  });
  const pincodeCache = new TtlCache<string>({
    ttlMs: deps.geocodeCacheMs ?? DEFAULT_GEOCODE_CACHE_MS,
    ...clock,
  });
  const forecastCache = new TtlCache<Forecast>({
    ttlMs: deps.forecastCacheMs ?? DEFAULT_FORECAST_CACHE_MS,
    ...clock,
  });

  /** Old name → current name, so the geocoder can find it at all. */
  const dealias = (place: string): string => PLACE_ALIASES[place.toLowerCase()] ?? place;

  /**
   * A pincode is not a place name. Resolve it to a district before geocoding.
   *
   * Returns null rather than throwing on ANY failure — an unrecognised pincode is
   * a domain outcome, and a pincode service being down must not take the whole
   * tool with it when the caller could still have meant a place name.
   */
  async function resolvePincode(code: string): Promise<string | null> {
    if (!deps.pincodeApiBase) return null;
    try {
      // ⚠ ONLY A RESOLUTION IS CACHED. A pincode service having a bad minute
      // and a pincode nobody has heard of are the same value from here, and
      // remembering the first for a day would turn one blip into an address
      // this device cannot find until it restarts.
      return await pincodeCache.fetch(code, async () => {
        const body = await getJson<
          Array<{ Status?: string; PostOffice?: Array<{ District?: string; State?: string }> }>
        >(fetcher, `${deps.pincodeApiBase}/pincode/${encodeURIComponent(code)}`, "pincode lookup");

        const office = body?.[0]?.PostOffice?.[0];
        if (body?.[0]?.Status !== "Success" || !office?.District) {
          throw new UnknownPlace(code);
        }
        // India Post still returns the PRE-RENAME district ("Allahabad"), so
        // this has to run through the alias table too — which is the whole
        // reason the pincode path was not enough on its own.
        return dealias(office.District);
      });
    } catch {
      return null;
    }
  }

  /** Biased query first, unbiased retry second. See `countryBias`. */
  async function geocode(place: string): Promise<ResolvedPlace | null> {
    // Lowercased, so "PUNE", "Pune" and "pune" are one entry rather than three.
    // The bias is part of the key because it changes the answer: "London" with
    // an India bias and without it are different places.
    const key = `${place.toLowerCase()}|${deps.countryBias ?? ""}`;
    try {
      // ⚠ A MISS IS NOT CACHED, the same rule as the pincode above. An empty
      // result means "no such place" or "the index is rebuilding" and nothing
      // here can tell those apart, so a name that failed once is retried.
      return await geocodeCache.fetch(key, async () => {
        const base = `${deps.geocodeBase}/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
        const queries = deps.countryBias
          ? [`${base}&countryCode=${deps.countryBias}`, base]
          : [base];

        for (const url of queries) {
          const geo = await getJson<{ results?: GeocodeHit[] }>(fetcher, url, "geocoding");
          const hit = geo.results?.[0];
          if (hit && typeof hit.latitude === "number" && typeof hit.longitude === "number") {
            return { ...hit, latitude: hit.latitude, longitude: hit.longitude };
          }
        }
        throw new UnknownPlace(place);
      });
    } catch (err) {
      // ONLY OUR SENTINEL BECOMES A DOMAIN OUTCOME. A geocoder that answered
      // 503 is infrastructure and still throws, so the model speaks the
      // reviewed "something went wrong" copy rather than "I couldn't find that
      // place" — which would be a confident wrong answer about a real place.
      if (err instanceof UnknownPlace) return null;
      throw err;
    }
  }

  return {
    name: "get_weather",
    description:
      "Get the current weather and today's forecast for a place. Use this whenever " +
      "the user asks about weather, temperature, rain, or whether they need an " +
      "umbrella. You have no weather knowledge of your own — never answer from " +
      "memory. If you do not know which place they mean, ask them first rather " +
      "than guessing a city.",
    parameters: {
      type: "object",
      properties: {
        place: {
          type: "string",
          description:
            "City or town name, in English or the local script — for example " +
            "'Bengaluru', 'Pune', or 'Mumbai'. A six-digit Indian PIN code also " +
            "works if the user gives one.",
        },
      },
      required: ["place"],
      additionalProperties: false,
    },
    deadline_ms: NETWORK_MS,
    filler_threshold_ms: NETWORK_FILLER_MS,
    progress_key: "progress.weather",
    handler: async (args) => {
      const asked = String(args["place"] ?? "").trim() || deps.defaultPlace || "";
      if (asked === "") return { found: false, reason: "no_place_given" };

      // A pincode resolves to a district; anything else goes through the alias
      // table. Both land on a name the geocoder actually indexes.
      const resolved = PINCODE.test(asked) ? await resolvePincode(asked) : dealias(asked);

      if (resolved === null) {
        return { found: false, reason: "unknown_pincode", place: asked };
      }

      const hit = await geocode(resolved);
      // A place we cannot find is a DOMAIN outcome, not a failure. The model says
      // "I couldn't find that place" in the user's own language, for free — where
      // an error result would cost eleven translations. See the file header.
      if (!hit) return { found: false, reason: "unknown_place", place: asked };

      // Keyed to two decimal places — about a kilometre. Neighbouring suburbs
      // share an entry because they share the weather, and the coordinates a
      // geocoder returns for one city name are identical anyway; the rounding
      // is what makes that true across two different names for one place.
      //
      // ⚠ THE TURN'S ABORT SIGNAL IS DELIBERATELY NOT PASSED into any of these
      // loads, and this handler no longer takes a `ctx` at all. A shared load
      // can outlive the turn that started it, so cancelling on the first
      // caller's hang-up would take the answer away from the second — which is
      // the whole point of sharing it. The tool's own deadline still bounds
      // every waiter, so nothing here can hold a turn open; what the request
      // itself is bounded by is the fetch timeout, not the turn.
      const key = `${hit.latitude.toFixed(2)},${hit.longitude.toFixed(2)}`;
      const wx = await forecastCache.fetch(key, () =>
        getJson<Forecast>(
          fetcher,
          `${deps.apiBase}/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
            `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
            `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
            `&timezone=auto&forecast_days=1`,
          "forecast",
        ),
      );

      const cur = wx.current ?? {};
      const daily = wx.daily ?? {};
      const first = (k: string): unknown => (Array.isArray(daily[k]) ? daily[k][0] : undefined);
      const code = typeof cur["weather_code"] === "number" ? cur["weather_code"] : -1;

      const place = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");

      return {
        found: true,
        place,
        // What the user actually said, when it is not what we looked up — a
        // pincode, or an old name. The model needs this to confirm out loud
        // ("in Prayagraj — that's your 211004"), which is the only way a
        // listener can catch a wrong resolution. Omitted when they match, so
        // the ordinary case stays quiet.
        ...(resolved.toLowerCase() === asked.toLowerCase() ? {} : { asked_for: asked }),
        // Rounded on purpose: "31 degrees" is what a person says. "30.7" invites
        // the model to read a decimal point aloud.
        temperature_c: Math.round(Number(cur["temperature_2m"])),
        feels_like_c: Math.round(Number(cur["apparent_temperature"])),
        conditions: WMO_CODES[code] ?? "unclear",
        humidity_pct: Math.round(Number(cur["relative_humidity_2m"])),
        wind_kmh: Math.round(Number(cur["wind_speed_10m"])),
        today_high_c: Math.round(Number(first("temperature_2m_max"))),
        today_low_c: Math.round(Number(first("temperature_2m_min"))),
        rain_chance_pct: Math.round(Number(first("precipitation_probability_max"))),
      };
    },
  };
}
