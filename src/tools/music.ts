/**
 * `play_music` — the first tool that HOLDS THE FLOOR.
 *
 * Its own file rather than builtin.ts, which is already past 700 lines and whose
 * two halves (session-only, then external) are both about tools that answer a
 * question and hand the turn back. This one does not: it starts audio that
 * outlives the turn by minutes, which is a different kind of thing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TOOL DOES NOT DO: play anything.
 *
 * It resolves a request to something playable and returns. The DEVICE plays it,
 * over the control channel, because ADR 0007's rule — "buffered audio lives on
 * the device, so only the device can actually drop it" — is at its most true for
 * a four-minute track. Streaming a song through the server would put ~11 MB of
 * PCM per track on the same socket as TTS and hand us a decoder to maintain.
 *
 * It also means the two modes converge: radio returns a stream URL, songs return
 * a video id, and the device owns how each becomes sound. Swapping how YouTube
 * audio is obtained — an embedded official player, a licensed source — is then a
 * device change, not a server rewrite.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TWO MODES, and the model picks:
 *
 *   radio  — a live station in the user's language. Keyless, verified working.
 *   song   — a specific track, found through the YouTube Data API. Needs a key,
 *            and is NOT OFFERED AT ALL when that key is absent: the `mode` enum
 *            shrinks to ["radio"], exactly as get_news drops unconfigured
 *            categories. A capability the deployment cannot serve is never
 *            described to the user.
 */

import type { RadioCatalogue } from "../domain/radio-catalogue.ts";
import type { LanguageCode } from "../domain/types.ts";
import type { ToolSpec } from "./registry.ts";
import type { HttpFetch } from "./builtin.ts";
import type { SessionToolHost } from "./types.ts";

/** Two network hops at worst (search, then resolve). Radio is one memory read. */
const MUSIC_MS = 6000;
const MUSIC_FILLER_MS = 600;

export type MusicMode = "radio" | "song";

/** What the session hands to the device. Neither mode sends audio. */
export type MediaRequest =
  | { source: "radio"; title: string; language: LanguageCode; urls: string[] }
  | { source: "youtube"; title: string; artist: string | null; video_id: string };

export type MusicDeps = {
  catalogue: RadioCatalogue;
  /**
   * NOTE: there is no `play` dependency here, and that is deliberate.
   *
   * The registry is built ONCE per deployment and shared by every concurrent
   * session, so a callback captured at construction would send one user's music
   * to another user's device. Playback goes through `ctx.host.playMedia` for the
   * same reason `repeat_that` goes through `ctx.host` — the session hands itself
   * in at execution time. See the note on SessionToolHost in tools/types.ts.
   */
  /** Absent disables `song` mode entirely. See the file header. */
  youtubeApiKey: string | null;
  youtubeApiBase?: string;
  fetch?: HttpFetch;
};

type YouTubeItem = {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string };
};

type YouTubeDetail = {
  id?: string;
  snippet?: { title?: string; channelTitle?: string; liveBroadcastContent?: string };
  contentDetails?: { duration?: string };
};

/**
 * Below this, it is a Short, not a song. Measured: a `bhajan` search returned an
 * 18-second clip in the top five.
 */
const MIN_SONG_SECONDS = 90;

/**
 * Above this it is a compilation rather than a track. Measured: "Kishore Kumar
 * old songs" returns a 2h26m mix as its FIRST result, and "old hindi songs" a
 * 1h31m one.
 *
 * Long mixes are still played rather than rejected — for a companion, an hour of
 * continuous music is closer to what someone wanted than an error. They are just
 * ranked below anything that looks like an actual song.
 */
const MAX_SONG_SECONDS = 900;

/**
 * ISO 8601 duration to seconds. Returns -1 for anything that is not a plain
 * duration — which is how a LIVE stream announces itself: YouTube reports `P0D`
 * for one, and a live stream never ends, so it must never be chosen.
 */
export function durationSeconds(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return -1;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Pick the most song-like candidate, in search-relevance order.
 *
 * Relevance alone is not enough: the top hit for a vague query is routinely a
 * Short, a live stream, or a two-hour compilation. Order of preference —
 *
 *   1. a plain track in the normal song band (90 s - 15 min)
 *   2. failing that, the SHORTEST thing over 90 s, so a 20-minute set beats a
 *      two-hour one when nothing better exists
 *
 * Live streams and Shorts are never returned at all.
 */
export function pickSongLike(
  details: YouTubeDetail[],
): { id: string; title: string; artist: string | null; seconds: number } | null {
  const usable = details
    .map((v) => ({
      id: v.id ?? "",
      title: v.snippet?.title ?? "",
      artist: v.snippet?.channelTitle ?? null,
      seconds: durationSeconds(v.contentDetails?.duration ?? ""),
      live: (v.snippet?.liveBroadcastContent ?? "none") !== "none",
    }))
    .filter((v) => v.id !== "" && !v.live && v.seconds >= MIN_SONG_SECONDS);

  if (usable.length === 0) return null;

  const inBand = usable.find((v) => v.seconds <= MAX_SONG_SECONDS);
  if (inBand) return inBand;

  return usable.reduce((best, v) => (v.seconds < best.seconds ? v : best));
}

export function createPlayMusic(deps: MusicDeps): ToolSpec {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const apiBase = deps.youtubeApiBase ?? "https://www.googleapis.com";
  const modes: MusicMode[] = deps.youtubeApiKey ? ["radio", "song"] : ["radio"];

  return {
    name: "play_music",
    description:
      "Play music for the user. Use 'radio' for anything general — a mood, a " +
      "language, 'some old songs', 'put the radio on' — which starts a live " +
      "radio station and keeps playing. Use 'song' only when they name a " +
      "specific track or artist they want to hear. Tell them what you are " +
      "putting on before it starts. To stop, the user just says so out loud; " +
      "you do not need a tool for that.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "'radio' for a live station in their language, 'song' for a named track.",
          // Only what this deployment can serve. Without a YouTube key the
          // model never learns that songs were ever a possibility.
          enum: [...modes],
        },
        query: {
          type: "string",
          description:
            "What they asked for, in their own words — 'purane gaane', " +
            "'Lag Ja Gale by Lata Mangeshkar'. Used to search in 'song' mode " +
            "and recorded for the spoken confirmation in 'radio' mode.",
        },
      },
      required: ["mode", "query"],
      additionalProperties: false,
    },
    deadline_ms: MUSIC_MS,
    filler_threshold_ms: MUSIC_FILLER_MS,
    handler: async (args, ctx) => {
      const mode = String(args["mode"] ?? "").trim() as MusicMode;
      const query = String(args["query"] ?? "").trim();

      const host = ctx.host;
      if (mode === "song") {
        if (!deps.youtubeApiKey) {
          // Unreachable through the enum, but a model that invents an argument
          // must not reach a fetch with a null key.
          return { playing: false, reason: "song_mode_unavailable", modes };
        }
        return await playSong(query, host);
      }
      return playRadio(ctx.language, query, host);
    },
  };

  function playRadio(
    language: LanguageCode,
    query: string,
    host: SessionToolHost,
  ): Record<string, unknown> {
    const hit = deps.catalogue.lookup(language);

    // A language with no stations is a DOMAIN outcome carrying the alternative,
    // never a silent substitution. Gujarati has zero stations in the directory;
    // playing Hindi at someone who asked in Gujarati is the wrong answer given
    // confidently, which is the failure this codebase keeps meeting.
    if (!hit.found) {
      return {
        playing: false,
        reason: "no_stations_for_language",
        language,
        // The model asks before switching. It does not switch.
        offer_instead: hit.fallback,
      };
    }

    const title = hit.stations[0]!.name;
    host.playMedia({
      source: "radio",
      title,
      language,
      // Every station, best first. Stations die constantly — the device tries
      // the next rather than failing in front of the user.
      urls: hit.stations.map((s) => s.url),
    });

    return {
      playing: true,
      mode: "radio",
      station: title,
      language,
      alternatives: hit.stations.length - 1,
      ...(query === "" ? {} : { asked_for: query }),
    };
  }

  async function playSong(query: string, host: SessionToolHost): Promise<Record<string, unknown>> {
    if (query === "") return { playing: false, reason: "no_query" };

    // EIGHT candidates, not one. `search` ranks on relevance alone, and for a
    // vague query the top hit is routinely a Short, a live stream, or a
    // two-hour compilation — all three observed against the live API. Duration
    // is not in the search response, so it takes a second call to see them.
    const url =
      `${apiBase}/youtube/v3/search?part=snippet&type=video&maxResults=8` +
      `&videoCategoryId=10&q=${encodeURIComponent(query)}&key=${deps.youtubeApiKey}`;

    const res = await fetcher(url, { headers: { accept: "application/json" } });
    // Quota exhaustion arrives as a 403 and is the most likely failure in a
    // prototype: search costs 100 of the 10,000 free daily units, so the
    // hundred-and-first request of the day fails. Thrown, so the executor
    // speaks the reviewed unavailable copy rather than inventing an excuse.
    if (!res.ok) throw new Error(`youtube search returned HTTP ${res.status}`);

    const body = JSON.parse(await res.text()) as { items?: YouTubeItem[] };
    const ids = (body.items ?? []).map((i) => i.id?.videoId).filter((v): v is string => !!v);
    if (ids.length === 0) return { playing: false, reason: "no_match", query };

    // `videos.list` costs 1 unit against search's 100, so filtering properly is
    // effectively free next to the search that found the candidates.
    const detailRes = await fetcher(
      `${apiBase}/youtube/v3/videos?part=snippet,contentDetails&id=${ids.join(",")}` +
        `&key=${deps.youtubeApiKey}`,
      { headers: { accept: "application/json" } },
    );
    if (!detailRes.ok) throw new Error(`youtube lookup returned HTTP ${detailRes.status}`);

    const details = JSON.parse(await detailRes.text()) as { items?: YouTubeDetail[] };
    const pick = pickSongLike(details.items ?? []);
    // Everything found was a Short or a live stream. Saying so is better than
    // playing an 18-second clip and calling it the song they asked for.
    if (!pick)
      return { playing: false, reason: "no_playable_match", query, candidates: ids.length };

    const { id: videoId, title, artist, seconds } = pick;
    host.playMedia({ source: "youtube", title, artist, video_id: videoId });

    return {
      playing: true,
      mode: "song",
      title,
      artist,
      duration_s: seconds,
      // The D9 rule: say what was resolved. A search picks something, and the
      // user is the only one who can tell it picked wrong — but only if the
      // companion says which track it found before it starts.
      asked_for: query,
    };
  }
}
