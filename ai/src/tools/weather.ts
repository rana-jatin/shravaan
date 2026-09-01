/**
 * `get_weather` — Open-Meteo, no key required.
 *
 * Split out of tools/builtin.ts, which had grown to hold three unrelated
 * upstreams. See tools/external.ts for the residency argument that governs
 * this tool and the deadline it runs under.
 */

import { getJson, nodeFetch, type HttpFetch } from "@sp-i/shared/providers/http.ts";
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
  fetch?: HttpFetch;
};

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

  /** Old name → current name, so the geocoder can find it at all. */
  const dealias = (place: string): string => PLACE_ALIASES[place.toLowerCase()] ?? place;

  /**
   * A pincode is not a place name. Resolve it to a district before geocoding.
   *
   * Returns null rather than throwing on ANY failure — an unrecognised pincode is
   * a domain outcome, and a pincode service being down must not take the whole
   * tool with it when the caller could still have meant a place name.
   */
  async function resolvePincode(code: string, signal: AbortSignal): Promise<string | null> {
    if (!deps.pincodeApiBase) return null;
    try {
      const body = await getJson<
        Array<{ Status?: string; PostOffice?: Array<{ District?: string; State?: string }> }>
      >(fetcher, `${deps.pincodeApiBase}/pincode/${encodeURIComponent(code)}`, "pincode lookup", {
        signal,
      });

      const office = body?.[0]?.PostOffice?.[0];
      if (body?.[0]?.Status !== "Success" || !office?.District) return null;
      // India Post still returns the PRE-RENAME district ("Allahabad"), so this
      // has to run through the alias table too — which is the whole reason the
      // pincode path was not enough on its own.
      return dealias(office.District);
    } catch {
      return null;
    }
  }

  /** Biased query first, unbiased retry second. See `countryBias`. */
  async function geocode(place: string, signal: AbortSignal): Promise<GeocodeHit | null> {
    const base = `${deps.geocodeBase}/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
    const queries = deps.countryBias ? [`${base}&countryCode=${deps.countryBias}`, base] : [base];

    for (const url of queries) {
      const geo = await getJson<{ results?: GeocodeHit[] }>(fetcher, url, "geocoding", { signal });
      const hit = geo.results?.[0];
      if (hit && typeof hit.latitude === "number" && typeof hit.longitude === "number") return hit;
    }
    return null;
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
    handler: async (args, ctx) => {
      const asked = String(args["place"] ?? "").trim() || deps.defaultPlace || "";
      if (asked === "") return { found: false, reason: "no_place_given" };

      // A pincode resolves to a district; anything else goes through the alias
      // table. Both land on a name the geocoder actually indexes.
      const resolved = PINCODE.test(asked)
        ? await resolvePincode(asked, ctx.signal)
        : dealias(asked);

      if (resolved === null) {
        return { found: false, reason: "unknown_pincode", place: asked };
      }

      const hit = await geocode(resolved, ctx.signal);
      // A place we cannot find is a DOMAIN outcome, not a failure. The model says
      // "I couldn't find that place" in the user's own language, for free — where
      // an error result would cost eleven translations. See the file header.
      if (!hit) return { found: false, reason: "unknown_place", place: asked };

      const wx = await getJson<{
        current?: Record<string, number>;
        daily?: Record<string, unknown[]>;
      }>(
        fetcher,
        `${deps.apiBase}/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
          `&timezone=auto&forecast_days=1`,
        "forecast",
        { signal: ctx.signal },
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
