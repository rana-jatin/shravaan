/**
 * The tools.
 *
 * TWO CLASSES, AND THE SPLIT IS LOAD-BEARING. Everything down to `BUILTIN_TOOLS`
 * needs nothing but the session — no key, no URL, no network — so server.ts
 * registers the lot unconditionally and a fresh clone has a working companion.
 * Below that line live the external tools, which are factories precisely because
 * they cannot make that promise. See the divider above `createGetWeather`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT SHAPES ALL OF THESE: A DOMAIN OUTCOME IS DATA, NOT AN ERROR.
 *
 * `ToolResult.ok === false` costs a `spoken_fallback_key`, and every key costs
 * eleven translations — nine of which are currently placeholder text awaiting a
 * native speaker (src/copy/fillers.ts). If "there is nothing to repeat" or "that
 * language cannot be spoken" were modelled as errors, each new tool would drag
 * eleven more strings behind it, and the translation backlog — not the
 * engineering — would decide how many tools this product can carry.
 *
 * So these tools SUCCEED and return a shape the model narrates in whatever
 * language the turn is in. `{repeated: false, reason: "nothing_said_yet"}` gets
 * spoken correctly in Odia for free. Errors stay reserved for what they were
 * meant for: infrastructure that broke.
 *
 * The one exception is a declined language switch, which is spoken by the
 * session from reviewed copy rather than improvised — see `set_language`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Deadlines in the built-in half are short on purpose. The 8 s default in
 * types.ts is sized for a network call; every built-in is an in-process
 * function, so a call that has not returned in 250 ms is wedged, not slow.
 * Their fillers are pinned above the deadline so they can never fire: "one
 * moment" before an instant answer makes a fast companion feel slow. The
 * external tools invert both — see NETWORK_MS and NETWORK_FILLER_MS.
 */

import { SPEAKABLE } from "../domain/languages.ts";
import type { FactKind } from "../domain/types.ts";
import { getJson, getText, nodeFetch, type HttpFetch } from "../providers/http.ts";
import type { ToolSpec } from "./registry.ts";

/** In-process work. Anything slower than this is stuck, not busy. */
const INSTANT_MS = 250;
/** Touches a store, which may be Redis or Postgres one day. */
const STORE_MS = 2500;

const SPEAKABLE_CODES = SPEAKABLE.map((l) => l.code);

/**
 * Fact kinds, as the model sees them. Mirrors FactKind in domain/types.ts.
 * English tokens, deliberately — see the note on `enum` in tools/types.ts.
 */
const FACT_KINDS: FactKind[] = [
  "preference",
  "biographical",
  "relationship",
  "commitment",
  "aversion",
];

/**
 * What time is it.
 *
 * A tool rather than a line in the system prompt, and that is a deliberate
 * trade. The profile block is kept as a STABLE SUFFIX so the prompt prefix stays
 * byte-identical across turns and Sarvam's cached-input pricing applies
 * (session.ts #profileBlock). Injecting "the time is now 18:42" into the prompt
 * would invalidate that cache on every single turn, to serve a question that
 * comes up a few times a day. As a tool it costs one extra round only when
 * someone actually asks.
 */
export const getTime: ToolSpec = {
  name: "get_time",
  description:
    "Get the current date and time where the user is. Use this whenever the user " +
    "asks about the time, the date, the day of the week, or anything that depends " +
    "on knowing when 'now' is. You have no clock of your own.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (_args, ctx) => {
    const timezone = ctx.host.timezone();
    const now = new Date();
    // en-GB gives 24-hour time and an unambiguous day-first date, which is what
    // the model should reason over. It phrases the result for the user itself,
    // in their language — this is data, not a spoken string.
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

    return {
      time_24h: `${get("hour")}:${get("minute")}`,
      weekday: get("weekday"),
      date: `${get("day")} ${get("month")} ${get("year")}`,
      timezone,
      iso: now.toISOString(),
    };
  },
};

/**
 * Say the last thing again.
 *
 * Cheap and disproportionately useful on a voice device: the request behind
 * "kya kaha?" is not "generate a fresh answer" but "I did not hear you", and
 * regenerating produces different words, which is exactly wrong when the user is
 * trying to catch the same ones a second time.
 */
export const repeatThat: ToolSpec = {
  name: "repeat_that",
  description:
    "Retrieve your own previous reply, word for word, when the user did not hear " +
    "it or asks you to say it again. Repeat it back rather than composing " +
    "something new — they are trying to catch the same words a second time. " +
    "Say it a little more clearly, but do not change the meaning.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (_args, ctx) => {
    const last = ctx.host.lastAgentReply();
    return last === null
      ? { repeated: false, reason: "nothing_said_yet" }
      : { repeated: true, text: last };
  },
};

/**
 * Switch language because the user ASKED, not because detection heard it.
 *
 * This closes a path the data model always had and nothing ever wrote:
 * `LanguageSource` includes `"user_stated"` and no code set it. Gates 2 and 3
 * handle detection; a user saying "Tamil-il pesunga" is a different signal and a
 * stronger one, because a stated preference should survive a turn of noisy
 * detection.
 *
 * It routes through the same speakability verdict as the gates. A tool must not
 * become a side door around the one check that stops a user hearing silence —
 * and the decline is spoken by the session from reviewed copy, not improvised by
 * the model, because that sentence is the whole product promise in a language we
 * had to refuse.
 */
export const setLanguage: ToolSpec = {
  name: "set_language",
  description:
    "Switch the conversation to a language the user has explicitly asked for — " +
    "for example 'speak in Tamil' or 'Hindi mein baat karo'. Only for an explicit " +
    "request. If they simply start speaking another language, say nothing and let " +
    "it happen: that is handled for you.",
  parameters: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "BCP-47 code of the requested language.",
        enum: [...SPEAKABLE_CODES],
      },
    },
    required: ["language"],
    additionalProperties: false,
  },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (args, ctx) => {
    const result = ctx.host.requestLanguage(String(args["language"]));
    return result.switched
      ? { switched: true, language: result.language }
      : {
          switched: false,
          language: result.language,
          reason: result.reason,
          // The session already spoke the reviewed refusal for a language it
          // cannot voice. Telling the model keeps it from apologising twice.
          already_acknowledged: result.reason === "not_speakable",
        };
  },
};

/**
 * Speak faster or slower.
 *
 * On a companion device aimed partly at older users this is a top-of-list
 * request and currently unanswerable — `pace` is set once from TTS_PACE at boot
 * and never touched again. Steps rather than a raw number, because "0.8" is not
 * a thing anyone says out loud and a model asked for a float will invent one.
 */
export const setSpeakingPace: ToolSpec = {
  name: "set_speaking_pace",
  description:
    "Change how fast you speak, when the user asks you to slow down or speed up. " +
    "Takes effect from your next sentence.",
  parameters: {
    type: "object",
    properties: {
      change: {
        type: "string",
        description: "Direction to adjust, or reset to the default pace.",
        enum: ["slower", "faster", "normal"],
      },
    },
    required: ["change"],
    additionalProperties: false,
  },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (args, ctx) => {
    const change = String(args["change"]);
    const current = ctx.host.pace();
    const target =
      change === "slower" ? current - 0.15 : change === "faster" ? current + 0.15 : 1.0;
    const applied = ctx.host.setPace(target);
    return {
      pace: applied,
      // The clamp is visible so the model can say "that is as slow as I go"
      // instead of silently promising a change that did not happen.
      at_limit: Math.abs(applied - current) < 0.001 && change !== "normal",
    };
  },
};

/**
 * Store something because the user asked us to.
 *
 * `MemWriteKind` has included `"explicit_recall"` since the data contracts were
 * written; the buffered stream even prioritises it above ordinary turns
 * (memory/buffered-stream.ts) and nothing has ever emitted one. Until now the
 * only route into long-term memory was the distiller inferring importance from a
 * completed turn — which works, and which quietly drops the case where the user
 * states outright that this one matters.
 *
 * Fire-and-forget, like every other memory write: a failure here degrades
 * tomorrow's conversation, never today's turn.
 */
export const rememberThis: ToolSpec = {
  name: "remember_this",
  description:
    "Store something the user has explicitly asked you to remember for future " +
    "conversations — 'remember that…', 'don't forget…', 'yaad rakhna'. Write the " +
    "fact in the third person about the user, in the language they said it in, " +
    "keeping their own words where you can. Do not use this for ordinary " +
    "conversation; what matters is remembered without being asked.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The fact, stated plainly and in full, so it makes sense months later.",
      },
      kind: {
        type: "string",
        description: "What sort of fact this is.",
        enum: [...FACT_KINDS],
      },
    },
    required: ["text", "kind"],
    additionalProperties: false,
  },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (args, ctx) => {
    const text = String(args["text"]).trim();
    if (text === "") return { remembered: false, reason: "empty" };
    ctx.host.rememberFact(text, args["kind"] as FactKind);
    return { remembered: true, text };
  },
};

/**
 * Forget something, because they asked.
 *
 * `Fact.deleted_reason` has had a `"user_requested"` variant from the start with
 * nothing to produce it. Deletion is soft — the supersede chain and the audit
 * trail survive, because a memory log that cannot explain itself is worse than
 * one that remembers too much — but the fact stops reaching the profile, which
 * is the only thing the user can perceive.
 */
export const forgetThis: ToolSpec = {
  name: "forget_this",
  description:
    "Forget something you have remembered about the user, when they ask you to. " +
    "Describe what to forget in the same words they used. Confirm afterwards what " +
    "you actually forgot, and if it was not there, say so plainly.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "What to forget, in the user's own words.",
      },
    },
    required: ["subject"],
    additionalProperties: false,
  },
  deadline_ms: STORE_MS,
  handler: async (args, ctx) => {
    const { forgotten, texts } = await ctx.host.forgetFacts(String(args["subject"]));
    return forgotten === 0 ? { forgotten: 0, reason: "nothing_matched" } : { forgotten, texts };
  },
};

/**
 * Look something up in long-term memory, on demand.
 *
 * The architecture deliberately keeps long-term memory OFF the turn path:
 * retrieval happens in the worker, reaches the prompt as a distilled profile,
 * and no turn pays for a search (docs/01-architecture.md §3.9). This tool is the
 * bounded exception — the case where the user asks a direct question of memory
 * that the profile's cap did not carry, and where a search is worth its
 * milliseconds precisely because they asked.
 *
 * ⚠ QUALITY CEILING, NOT A BUG IN THIS FILE: retrieval is only as good as
 * `HashingEmbedder`, which matches lexically and cannot bridge scripts — "they
 * live in Bengaluru" scores zero against "वे बेंगलुरु में रहते हैं". Our facts are
 * multilingual by construction, so this tool will miss cross-language matches
 * until a real embedder replaces it (README, "Known gaps").
 */
export const recall: ToolSpec = {
  name: "recall",
  description:
    "Search what you remember about the user from previous conversations, when " +
    "they ask you a direct question about something they told you before. You " +
    "already carry the important things without looking them up — use this only " +
    "when they ask about something specific you cannot recall.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for, in the user's own words.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  deadline_ms: STORE_MS,
  handler: async (args, ctx) => {
    const hits = await ctx.host.recallFacts(String(args["query"]), 5);
    return hits.length === 0
      ? { found: 0, reason: "nothing_matched" }
      : { found: hits.length, facts: hits };
  },
};

/**
 * End the conversation because the user said goodbye.
 *
 * Every other route out of a session is a failure or a dropped socket. This is
 * the one that is neither — and it must not cut the farewell off mid-word, so
 * the host closes only once the reply has drained.
 */
export const endConversation: ToolSpec = {
  name: "end_conversation",
  description:
    "End the conversation when the user says goodbye or asks you to stop. Say " +
    "your farewell in the same reply — it will be spoken in full before the " +
    "session closes. Do not use this when they merely pause.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  deadline_ms: INSTANT_MS,
  filler_threshold_ms: INSTANT_MS,
  handler: async (_args, ctx) => {
    ctx.host.requestEnd("user_said_goodbye");
    return { ending: true };
  },
};

/**
 * The zero-configuration tools, in the order the model sees it.
 *
 * Order is not cosmetic: it is the order tools appear in the prompt, and a long
 * list degrades selection accuracy. Eight is already more than a companion needs
 * for most turns, and enabling both external tools takes it to ten — which is
 * the largest list this product has ever offered and the one ADR 0003's
 * "selection quality under a realistic tool count" is still unmeasured against.
 */
export const BUILTIN_TOOLS: ToolSpec[] = [
  getTime,
  repeatThat,
  setLanguage,
  setSpeakingPace,
  rememberThis,
  forgetThis,
  recall,
  endConversation,
];

// ─────────────────────────────────────────────────────────────────────────────
// EXTERNAL TOOLS — the ones that leave the process.
//
// These are NOT in BUILTIN_TOOLS, and that is the whole point. Everything above
// needs nothing but the session, so server.ts can register it blindly and it
// works on a laptop with no configuration. These two need an upstream, a URL,
// and a decision about where a user's request is allowed to travel — so they are
// FACTORIES, and a deployment that has not configured one never registers it.
//
// The alternative — shipping them in BUILTIN_TOOLS and returning `upstream_error`
// when unconfigured — produces exactly the failure registry.ts's entitlement note
// warns about: an agent that offers a capability and then withdraws it. A tool
// the deployment cannot serve must never be DESCRIBED to the user.
//
// ⚠ RESIDENCY. Every other hop in this product is Sarvam, in India, on purpose
// (ADR 0003). Both tools below reach a third party, and Open-Meteo in particular
// is EU-hosted — so a weather question sends a place name out of the country.
// That is the same trade `asrFailoverEnabled` documents and defaults to off, for
// the same reason, and it is why these are opt-in. What crosses the border here
// is a city name and a topic, not the user's voice, which is a smaller exposure
// than the ASR failover — but it is not zero, and it is not our call to make
// silently. See docs/05-open-questions.md Q14.
// ─────────────────────────────────────────────────────────────────────────────

/** A network round trip, not an in-process call. Sized for two hops. */
const NETWORK_MS = 6000;
/**
 * Low enough that the progress line actually fires. `progress.weather` and
 * `progress.news` have existed in src/copy/fillers.ts since slice 6, written
 * ahead of these tools; this is the threshold that finally lets them be heard.
 */
const NETWORK_FILLER_MS = 600;

// --- Weather -----------------------------------------------------------------

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

// --- News --------------------------------------------------------------------

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

// --- Wellbeing ---------------------------------------------------------------

/**
 * `recall_mood` — how the last few conversations have been going.
 *
 * A FACTORY FOR A DIFFERENT REASON THAN THE TWO ABOVE. Weather and news are
 * factories because they leave the process. This one never does: it reads
 * episodes the memory worker already wrote (src/memory/care-signals-analyser.ts),
 * so it costs a store hit and nothing else, on any turn, in any language.
 *
 * It is a factory because the signals it reads only exist where a deployment
 * turned the analysis on. Registering it regardless would give the model a tool
 * that always answers "nothing recorded" — the offer-then-withdraw failure the
 * divider above and registry.ts both exist to prevent.
 *
 * ⚠ WHAT THE MODEL IS ALLOWED TO DO WITH THIS. The numbers are a third party's
 * score of English words, not a reading of how someone is (src/domain/care-signals.ts).
 * So the description below tells the model to speak in ordinary language and
 * never to diagnose, and the returned shape deliberately carries a coarse
 * direction rather than a chart. "You've sounded a bit quieter this week, is
 * everything all right?" is the ceiling of what this may become out loud.
 *
 * ⚠ AND IT ONLY EVER KNOWS ABOUT ENGLISH SESSIONS. `sessions` is the number
 * ANALYSED, not the number the person had — a user who speaks Hindi on Tuesday
 * and English on Wednesday has one analysed session that week. The model is told
 * to say so rather than imply it watched the whole week.
 */
export function createRecallMood(deps: { window?: number } = {}): ToolSpec {
  // Two weeks of daily use, which is enough for a direction without reaching so
  // far back that a bad fortnight in March colours today.
  const window = deps.window ?? 14;

  return {
    name: "recall_mood",
    description:
      "Look up how the user's recent conversations have been going, when they ask " +
      "how they have been lately or you are asked to reflect on the last few days. " +
      "Speak in ordinary, gentle language — never quote the numbers, never diagnose, " +
      "and never present this as a measurement of the person. If it covers fewer " +
      "sessions than they have had, say you are only going on some of them.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    deadline_ms: STORE_MS,
    handler: async (_args, ctx) => {
      const trend = await ctx.host.recentMood(window);
      // Domain outcome, not an error: nothing analysed yet is the normal state
      // of a new device and of every non-English deployment.
      return trend === null
        ? { analysed: 0, reason: "nothing_recorded" }
        : { analysed: trend.sessions, ...trend };
    },
  };
}
