/**
 * Live radio stations, per language, cached.
 *
 * Backed by Radio Browser — a community-run directory, free and keyless. Three
 * properties of that source shape everything here.
 *
 * IT IS SLOW AND IT IS SOMEONE'S VOLUNTEER SERVER. Measured at ~1.7 s per query.
 * A turn cannot wait for that, and hammering it per request would be rude as
 * well as slow, so the catalogue is refreshed on a timer and every lookup is
 * served from memory. No network call ever happens inside a turn.
 *
 * STATIONS ROT. Community-edited URLs die constantly. Measured on the top
 * Indian stations: one played directly, one needed a redirect followed, and All
 * India Radio returned 403. So a language keeps a LIST, not a station, and the
 * device is handed fallbacks to try in order.
 *
 * COVERAGE IS DEEPLY UNEVEN, and this is a product problem rather than a
 * technical one. Measured 2026-08-31, stations per language:
 *
 *   hindi 200+   tamil 200+   malayalam 85   punjabi 33
 *   english 30   telugu 29    kannada 27
 *   bengali 7    odia 8       marathi 4      gujarati 0
 *
 * Four of the eleven languages this product speaks have almost no radio, and
 * Gujarati has none at all. That is the speakability gate's shape again — a
 * language the companion converses in fluently but cannot play music for — so
 * it gets the same treatment: `lookup` reports the gap rather than silently
 * substituting Hindi, and the model offers the fallback out loud.
 */

import { getJson, nodeFetch, type HttpFetch } from "../providers/http.ts";
import type { LanguageCode } from "./types.ts";

/** Radio Browser's `language` field is an English name, not a BCP-47 code. */
const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  "hi-IN": "hindi",
  "bn-IN": "bengali",
  "ta-IN": "tamil",
  "te-IN": "telugu",
  "gu-IN": "gujarati",
  "kn-IN": "kannada",
  "ml-IN": "malayalam",
  "mr-IN": "marathi",
  "pa-IN": "punjabi",
  "or-IN": "odia",
  "en-IN": "english",
};

export type Station = {
  id: string;
  name: string;
  url: string;
  language: LanguageCode;
  codec: string;
  bitrate: number;
  /** Community vote count. The only quality signal the directory offers. */
  votes: number;
  /** False for a plain-http stream. Carried, not hidden — see `secureOnly`. */
  secure: boolean;
};

export type RadioLookup =
  | { found: true; language: LanguageCode; stations: Station[] }
  /** No station in the asked-for language. `fallback` is what to offer instead. */
  | { found: false; language: LanguageCode; reason: "no_stations"; fallback: LanguageCode | null };

type RawStation = {
  stationuuid?: string;
  name?: string;
  url_resolved?: string;
  url?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
};

export type RadioCatalogueDeps = {
  apiBase: string;
  /** Languages to keep warm. Anything else reports `no_stations`. */
  languages: readonly LanguageCode[];
  /**
   * Offered when the asked-for language has nothing. Null means say so and stop
   * — which is the honest answer, and better than quietly playing Hindi at
   * someone who asked for Gujarati.
   */
  fallbackLanguage: LanguageCode | null;
  /** Fallbacks handed to the device per lookup. Stations die; one is not enough. */
  perLanguage?: number;
  /** Drop plain-http streams. A device fetching them is an injection surface. */
  secureOnly?: boolean;
  fetch?: HttpFetch;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
};

export class RadioCatalogue {
  readonly #d: RadioCatalogueDeps;
  readonly #perLanguage: number;
  readonly #stations = new Map<LanguageCode, Station[]>();
  #refreshedAt: number | null = null;

  constructor(deps: RadioCatalogueDeps) {
    this.#d = deps;
    this.#perLanguage = deps.perLanguage ?? 3;
  }

  get refreshedAt(): number | null {
    return this.#refreshedAt;
  }

  /** Languages that actually have a station. Not the same as those configured. */
  get covered(): LanguageCode[] {
    return [...this.#stations.entries()].filter(([, s]) => s.length > 0).map(([l]) => l);
  }

  /**
   * Refill from the directory. Call at boot and on a timer, never in a turn.
   *
   * One language failing must not empty the others, so each is caught
   * independently and the previous list is kept on error — a stale station is
   * far better than silence.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    const fetcher = this.#d.fetch ?? nodeFetch();

    for (const language of this.#d.languages) {
      // A code outside the eleven has no directory name and cannot be searched.
      const name = LANGUAGE_NAMES[language];
      if (name === undefined) {
        this.#d.log?.("warn", "no radio directory name for language", { language });
        continue;
      }
      const url =
        `${this.#d.apiBase}/json/stations/search?language=${encodeURIComponent(name)}` +
        `&countrycode=IN&hidebroken=true&order=votes&reverse=true&limit=25`;

      try {
        const parsed = await getJson<RawStation[]>(
          fetcher,
          url,
          "radio directory",
          signal ? { signal } : undefined,
        );
        const stations = this.#shape(parsed, language);

        // An empty result REPLACES nothing. A directory hiccup that returns []
        // would otherwise silently remove a language the user had yesterday.
        if (stations.length > 0) this.#stations.set(language, stations);
        else if (!this.#stations.has(language)) this.#stations.set(language, []);
      } catch (err) {
        this.#d.log?.("warn", "radio refresh failed for one language", {
          language,
          err: err instanceof Error ? err.message : String(err),
          keeping: this.#stations.get(language)?.length ?? 0,
        });
      }
    }

    this.#refreshedAt = Date.now();
    this.#d.log?.("info", "radio catalogue refreshed", {
      covered: this.covered,
      missing: this.#d.languages.filter((l) => !this.covered.includes(l)),
    });
  }

  #shape(raw: RawStation[], language: LanguageCode): Station[] {
    const out: Station[] = [];
    for (const s of raw) {
      const url = (s.url_resolved || s.url || "").trim();
      if (url === "") continue;

      let secure: boolean;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        secure = parsed.protocol === "https:";
      } catch {
        continue;
      }
      // 15% of Indian stations are plain http. A device fetching an arbitrary
      // http URL from a community-edited database is a content-injection
      // surface pointed at someone's living room, so this is opt-out.
      if (this.#d.secureOnly !== false && !secure) continue;

      out.push({
        id: s.stationuuid ?? url,
        name: (s.name ?? "").trim() || "Unnamed station",
        url,
        language,
        codec: s.codec ?? "unknown",
        bitrate: s.bitrate ?? 0,
        votes: s.votes ?? 0,
        secure,
      });
      if (out.length >= this.#perLanguage) break;
    }
    return out;
  }

  /**
   * Stations for a language, best first.
   *
   * Never substitutes silently. A language with nothing returns `found: false`
   * carrying the fallback, so the model can ASK — "I don't have Gujarati
   * stations, shall I put on Hindi?" — rather than playing the wrong thing and
   * leaving the user to work out why.
   */
  lookup(language: LanguageCode): RadioLookup {
    const stations = this.#stations.get(language) ?? [];
    if (stations.length > 0) return { found: true, language, stations };

    const fallback = this.#d.fallbackLanguage;
    const usable =
      fallback && fallback !== language && (this.#stations.get(fallback)?.length ?? 0) > 0
        ? fallback
        : null;

    return { found: false, language, reason: "no_stations", fallback: usable };
  }
}
