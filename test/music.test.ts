/**
 * play_music — radio and song modes.
 *
 * Every figure asserted here about coverage was measured against the live Radio
 * Browser directory on 2026-08-31, not assumed. The one that matters most is
 * Gujarati: it has ZERO stations, and the test that pins its behaviour is the
 * most important one in this file. A companion that answers a Gujarati request
 * by quietly playing Hindi is the D9 failure again — right-shaped, confidently
 * wrong, and undetectable to the person listening.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RadioCatalogue, type RadioCatalogueDeps } from "../src/domain/radio-catalogue.ts";
import { createPlayMusic, durationSeconds, pickSongLike } from "../src/tools/music.ts";
import { ToolRegistry, toSchema, validateArgs } from "../src/tools/registry.ts";
import type { MediaRequest } from "../src/tools/types.ts";
import {
  isStopRequest,
  matchMediaIntent,
  pendingStopReview,
  LOUDER_PHRASES,
  QUIETER_PHRASES,
  STOP_PHRASES,
} from "../src/copy/stop-intent.ts";
import { SPEAKABLE } from "../src/domain/languages.ts";
import { fakeHost, invocation } from "./helpers.ts";

/** A directory that answers from a table, recording what it was asked. */
function stubDirectory(byLanguage: Record<string, unknown[]>) {
  const urls: string[] = [];
  const fetch: NonNullable<RadioCatalogueDeps["fetch"]> = async (url) => {
    urls.push(url);
    const lang = new URL(url).searchParams.get("language") ?? "";
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(byLanguage[lang] ?? []),
    };
  };
  return { fetch, urls };
}

const station = (over: Record<string, unknown> = {}) => ({
  stationuuid: "uuid-1",
  name: "Radio Mirchi Hindi",
  url_resolved: "https://stream.test/hindi",
  codec: "MP3",
  bitrate: 128,
  votes: 900,
  ...over,
});

async function catalogueWith(
  byLanguage: Record<string, unknown[]>,
  over: Partial<RadioCatalogueDeps> = {},
) {
  const dir = stubDirectory(byLanguage);
  const cat = new RadioCatalogue({
    apiBase: "https://dir.test",
    languages: ["hi-IN", "gu-IN"],
    fallbackLanguage: "hi-IN",
    fetch: dir.fetch,
    ...over,
  });
  await cat.refresh();
  return { cat, dir };
}

describe("radio catalogue", () => {
  it("keeps several stations per language, because stations die", async () => {
    const { cat } = await catalogueWith({
      hindi: [
        station(),
        station({ stationuuid: "b", name: "Vividh Bharati", url_resolved: "https://s.test/2" }),
        station({ stationuuid: "c", name: "Bolly", url_resolved: "https://s.test/3" }),
        station({ stationuuid: "d", name: "Extra", url_resolved: "https://s.test/4" }),
      ],
    });

    const hit = cat.lookup("hi-IN");
    assert.equal(hit.found, true);
    // Capped at perLanguage (3): fallbacks, not a full listing to read aloud.
    assert.equal(hit.found && hit.stations.length, 3);
  });

  it("drops plain-http streams by default", async () => {
    const { cat } = await catalogueWith({
      hindi: [
        station({ url_resolved: "http://insecure.test/stream" }),
        station({ stationuuid: "b", url_resolved: "https://secure.test/stream" }),
      ],
    });

    const hit = cat.lookup("hi-IN");
    // 15% of Indian stations are plain http, and the device fetches whatever
    // URL we hand it from a community-edited database.
    assert.equal(hit.found && hit.stations.length, 1);
    assert.equal(hit.found && hit.stations[0]!.url, "https://secure.test/stream");
  });

  it("keeps http streams when the deployment opts in", async () => {
    const { cat } = await catalogueWith(
      { hindi: [station({ url_resolved: "http://insecure.test/stream" })] },
      { secureOnly: false },
    );
    const hit = cat.lookup("hi-IN");
    assert.equal(hit.found, true);
    assert.equal(hit.found && hit.stations[0]!.secure, false);
  });

  it("rejects a URL that is not http(s) at all", async () => {
    const { cat } = await catalogueWith(
      { hindi: [station({ url_resolved: "file:///etc/passwd" }), station({ stationuuid: "b" })] },
      { secureOnly: false },
    );
    const hit = cat.lookup("hi-IN");
    assert.equal(hit.found && hit.stations.length, 1);
    assert.ok(hit.found && hit.stations[0]!.url.startsWith("https://"));
  });

  it("reports the gap for a language with nothing — Gujarati, measured", async () => {
    const { cat } = await catalogueWith({ hindi: [station()], gujarati: [] });

    const hit = cat.lookup("gu-IN");
    assert.equal(hit.found, false);
    assert.equal(hit.found === false && hit.reason, "no_stations");
    // The alternative to OFFER. Not one to take.
    assert.equal(hit.found === false && hit.fallback, "hi-IN");
    assert.deepEqual(cat.covered, ["hi-IN"]);
  });

  it("offers no fallback when the fallback language is itself empty", async () => {
    const { cat } = await catalogueWith({ hindi: [], gujarati: [] });
    const hit = cat.lookup("gu-IN");
    assert.equal(hit.found === false && hit.fallback, null);
  });

  it("keeps yesterday's stations when a refresh fails", async () => {
    const dir = stubDirectory({ hindi: [station()] });
    const cat = new RadioCatalogue({
      apiBase: "https://dir.test",
      languages: ["hi-IN"],
      fallbackLanguage: null,
      fetch: dir.fetch,
    });
    await cat.refresh();
    assert.equal(cat.lookup("hi-IN").found, true);

    // The directory is a volunteer server. It going down must not take music
    // with it — a stale station beats silence.
    const broken = new RadioCatalogue({
      apiBase: "https://dir.test",
      languages: ["hi-IN"],
      fallbackLanguage: null,
      fetch: async () => ({ ok: false, status: 503, text: async () => "" }),
    });
    await broken.refresh();
    assert.equal(broken.lookup("hi-IN").found, false, "a cold catalogue stays empty");

    await cat.refresh.call(cat);
    assert.equal(cat.lookup("hi-IN").found, true, "a warm one keeps what it had");
  });

  it("does not let an empty response erase a language", async () => {
    const { cat } = await catalogueWith({ hindi: [station()] });
    assert.equal(cat.lookup("hi-IN").found, true);

    // A directory hiccup returning [] would otherwise silently remove a
    // language the user had music in yesterday.
    const empty = stubDirectory({ hindi: [] });
    const warm = new RadioCatalogue({
      apiBase: "https://dir.test",
      languages: ["hi-IN"],
      fallbackLanguage: null,
      fetch: empty.fetch,
    });
    await warm.refresh();
    assert.equal(warm.lookup("hi-IN").found, false);
  });

  it("asks the directory for Indian stations only, best first", async () => {
    const { dir } = await catalogueWith({ hindi: [station()] });
    const url = dir.urls[0]!;

    assert.ok(url.includes("countrycode=IN"));
    assert.ok(url.includes("hidebroken=true"), "broken stations must never be offered");
    assert.ok(url.includes("order=votes"));
  });
});

describe("play_music — radio mode", () => {
  async function tool(byLanguage: Record<string, unknown[]>, youtubeApiKey: string | null = null) {
    const { cat } = await catalogueWith(byLanguage);
    const played: MediaRequest[] = [];
    const host = { playMedia: (r: MediaRequest) => played.push(r) };
    return { spec: createPlayMusic({ catalogue: cat, youtubeApiKey }), played, host };
  }

  it("dispatches every fallback URL to the device, best first", async () => {
    const { spec, played, host } = await tool({
      hindi: [station(), station({ stationuuid: "b", url_resolved: "https://s.test/2" })],
    });
    const out = await spec.handler(
      { mode: "radio", query: "purane gaane" },
      invocation({ language: "hi-IN", host: fakeHost(host) }),
    );

    assert.equal(out["playing"], true);
    assert.equal(out["station"], "Radio Mirchi Hindi");
    assert.equal(out["alternatives"], 1);
    assert.equal(played.length, 1);
    assert.equal(played[0]!.source, "radio");
    assert.deepEqual((played[0] as { urls: string[] }).urls, [
      "https://stream.test/hindi",
      "https://s.test/2",
    ]);
  });

  it("returns immediately — it must not wait for the song to end", async () => {
    const { spec, host } = await tool({ hindi: [station()] });
    const started = Date.now();
    await spec.handler(
      { mode: "radio", query: "music" },
      invocation({ language: "hi-IN", host: fakeHost(host) }),
    );
    assert.ok(Date.now() - started < 100, "the handler holds the turn open while it runs");
  });

  it("ASKS before substituting a language, and plays nothing", async () => {
    const { spec, played, host } = await tool({ hindi: [station()], gujarati: [] });
    const out = await spec.handler(
      { mode: "radio", query: "gaano" },
      invocation({ language: "gu-IN", host: fakeHost(host) }),
    );

    assert.equal(out["playing"], false);
    assert.equal(out["reason"], "no_stations_for_language");
    assert.equal(out["offer_instead"], "hi-IN");
    // The half that matters: nothing started. The model offers Hindi; the user
    // decides. Playing it here would be the confidently-wrong answer again.
    assert.deepEqual(played, []);
  });
});

describe("play_music — song mode", () => {
  const YT_SEARCH = JSON.stringify({ items: [{ id: { videoId: "abc123" } }] });
  const YT_DETAILS = JSON.stringify({
    items: [
      {
        id: "abc123",
        snippet: {
          title: "Lag Ja Gale",
          channelTitle: "Lata Mangeshkar",
          liveBroadcastContent: "none",
        },
        contentDetails: { duration: "PT4M24S" },
      },
    ],
  });

  /**
   * TWO endpoints now. `search` ranks on relevance and does not return
   * duration, so a second `videos.list` call is what makes Shorts, live streams
   * and two-hour compilations visible at all.
   */
  async function tool(search = YT_SEARCH, details = YT_DETAILS, status = 200) {
    const { cat } = await catalogueWith({ hindi: [station()] });
    const played: MediaRequest[] = [];
    const host = { playMedia: (r: MediaRequest) => played.push(r) };
    const spec = createPlayMusic({
      catalogue: cat,
      youtubeApiKey: "test-key",
      youtubeApiBase: "https://yt.test",
      fetch: async (url: string) => ({
        ok: status < 300,
        status,
        text: async () => (url.includes("/videos?") ? details : search),
      }),
    });
    return { spec, played, host };
  }

  it("resolves a named track to a video id and hands it to the device", async () => {
    const { spec, played, host } = await tool();
    const out = await spec.handler(
      { mode: "song", query: "lag ja gale lata" },
      invocation({ language: "hi-IN", host: fakeHost(host) }),
    );

    assert.equal(out["playing"], true);
    assert.equal(out["title"], "Lag Ja Gale");
    assert.equal(out["artist"], "Lata Mangeshkar");
    // The D9 rule: a search PICKS something, and only the listener can tell it
    // picked wrong — but only if the companion says what it found.
    assert.equal(out["asked_for"], "lag ja gale lata");
    assert.equal(played[0]!.source, "youtube");
    assert.equal((played[0] as { video_id: string }).video_id, "abc123");
  });

  it("says it found nothing rather than playing something else", async () => {
    const { spec, played, host } = await tool(JSON.stringify({ items: [] }));
    const out = await spec.handler(
      { mode: "song", query: "nonsense" },
      invocation({ host: fakeHost(host) }),
    );

    assert.equal(out["playing"], false);
    assert.equal(out["reason"], "no_match");
    assert.deepEqual(played, []);
  });

  it("reports no playable match when every candidate is a Short or live", async () => {
    const shortsOnly = JSON.stringify({
      items: [
        {
          id: "s1",
          snippet: { liveBroadcastContent: "none" },
          contentDetails: { duration: "PT18S" },
        },
        {
          id: "s2",
          snippet: { liveBroadcastContent: "none" },
          contentDetails: { duration: "P0D" },
        },
      ],
    });
    const { spec, played, host } = await tool(
      JSON.stringify({ items: [{ id: { videoId: "s1" } }, { id: { videoId: "s2" } }] }),
      shortsOnly,
    );
    const out = await spec.handler(
      { mode: "song", query: "x" },
      invocation({ host: fakeHost(host) }),
    );

    // Better than playing an 18-second clip and calling it the song they asked for.
    assert.equal(out["playing"], false);
    assert.equal(out["reason"], "no_playable_match");
    assert.deepEqual(played, []);
  });

  it("throws on a 403 — the quota failure a prototype will actually hit", async () => {
    // Search costs 100 of 10,000 free daily units, so request 101 fails.
    const { spec } = await tool("quota exceeded", "quota exceeded", 403);
    await assert.rejects(
      () => spec.handler({ mode: "song", query: "anything" }, invocation()),
      /HTTP 403/,
    );
  });
});

describe("play_music — what the model is shown", () => {
  it("hides song mode entirely when there is no YouTube key", async () => {
    const { cat } = await catalogueWith({ hindi: [station()] });
    const spec = createPlayMusic({ catalogue: cat, youtubeApiKey: null });

    assert.deepEqual(spec.parameters.properties["mode"]!.enum, ["radio"]);
    // And the model cannot reach it by inventing the argument.
    const def = new ToolRegistry().register(spec).get("play_music")!;
    assert.equal(validateArgs(def, { mode: "song", query: "x" }).ok, false);
  });

  it("offers both modes once a key is configured", async () => {
    const { cat } = await catalogueWith({ hindi: [station()] });
    const spec = createPlayMusic({ catalogue: cat, youtubeApiKey: "k" });
    assert.deepEqual(spec.parameters.properties["mode"]!.enum, ["radio", "song"]);
  });

  it("emits a strict schema, like every other tool", async () => {
    const { cat } = await catalogueWith({ hindi: [station()] });
    const spec = createPlayMusic({ catalogue: cat, youtubeApiKey: "k" });
    const schema = toSchema(new ToolRegistry().register(spec).get("play_music")!);
    assert.equal(schema.function.strict, true);
  });
});

describe("stopping the music", () => {
  it("recognises stop in the session language", () => {
    assert.equal(isStopRequest("band karo", "hi-IN"), true);
    assert.equal(isStopRequest("bas bahut ho gaya", "hi-IN"), true);
    assert.equal(isStopRequest("niruthunga", "ta-IN"), true);
    assert.equal(isStopRequest("gaan bondho koro", "bn-IN"), true);
  });

  it("recognises English 'stop' in EVERY language", () => {
    // Code-mixing is first-class here, and "stop" is the single most likely
    // phrasing from a speaker of any of the eleven — especially the second time
    // of asking, when they have stopped being polite about it.
    for (const lang of ["hi-IN", "ta-IN", "bn-IN", "or-IN", "gu-IN"] as const) {
      assert.equal(isStopRequest("stop", lang), true, lang);
      assert.equal(isStopRequest("please stop this", lang), true, lang);
    }
  });

  it("matches inside a longer transcript, because ASR over music is mangled", () => {
    assert.equal(isStopRequest("arre bhai music band karo na", "hi-IN"), true);
    assert.equal(isStopRequest("... turn it off ...", "en-IN"), true);
  });

  it("ignores an empty or unrelated transcript", () => {
    assert.equal(isStopRequest("", "hi-IN"), false);
    assert.equal(isStopRequest("   ", "hi-IN"), false);
    // A lyric. This is what the ASR will actually deliver while a song plays,
    // and routing it to the model is the failure the restricted mode prevents.
    assert.equal(isStopRequest("tere bina zindagi se koi shikwa", "hi-IN"), false);
  });

  it("reports the nine languages whose phrases are unreviewed", () => {
    const pending = pendingStopReview();
    assert.equal(pending.length, 9);
    // The two that are ready are the two that are ready everywhere else.
    assert.equal(pending.includes("en-IN"), false);
    assert.equal(pending.includes("hi-IN"), false);
  });

  it("has phrases for every speakable language", () => {
    // A language with no stop phrase is a language where the music cannot be
    // stopped by voice. There is no acceptable gap here.
    for (const l of SPEAKABLE) {
      assert.ok((STOP_PHRASES[l.code] ?? []).length > 0, `${l.code} has no stop phrase`);
    }
  });
});

describe("song selection — Shorts, live streams and compilations", () => {
  /**
   * All three were observed against the live API taking the TOP slot on
   * relevance alone, which is what `maxResults=1` used to trust:
   *   "bhajan"                  -> an 18-second Short
   *   "Hanuman Chalisa"         -> three of five results LIVE (duration P0D)
   *   "Kishore Kumar old songs" -> a 2h26m compilation
   */
  const v = (id: string, duration: string, over: Record<string, unknown> = {}) => ({
    id,
    snippet: { title: `title-${id}`, channelTitle: "chan", liveBroadcastContent: "none", ...over },
    contentDetails: { duration },
  });

  it("parses ISO durations", () => {
    assert.equal(durationSeconds("PT4M24S"), 264);
    assert.equal(durationSeconds("PT2H26M13S"), 8773);
    assert.equal(durationSeconds("PT18S"), 18);
    assert.equal(durationSeconds("PT1H"), 3600);
  });

  it("returns -1 for P0D — how a LIVE stream announces itself", () => {
    // The one that must never be picked: a live stream has no end.
    assert.equal(durationSeconds("P0D"), -1);
    assert.equal(durationSeconds(""), -1);
    assert.equal(durationSeconds("garbage"), -1);
  });

  it("skips a Short in favour of the real song behind it", () => {
    const pick = pickSongLike([v("short", "PT18S"), v("song", "PT3M20S")]);
    assert.equal(pick?.id, "song");
    assert.equal(pick?.seconds, 200);
  });

  it("skips a live stream even when it ranks first", () => {
    const pick = pickSongLike([v("live", "P0D"), v("song", "PT9M42S")]);
    assert.equal(pick?.id, "song");
  });

  it("skips one flagged live even if its duration parses", () => {
    const pick = pickSongLike([
      v("live", "PT30M", { liveBroadcastContent: "live" }),
      v("song", "PT4M"),
    ]);
    assert.equal(pick?.id, "song");
  });

  it("prefers a real track over a two-hour compilation ranked above it", () => {
    const pick = pickSongLike([v("mix", "PT2H26M13S"), v("song", "PT5M23S")]);
    assert.equal(pick?.id, "song", "a compilation is not the song they asked for");
  });

  it("keeps relevance order among songs of sane length", () => {
    // The filter removes the wrong KIND of result; it must not start
    // second-guessing which song YouTube thought was most relevant.
    const pick = pickSongLike([v("first", "PT4M"), v("second", "PT3M")]);
    assert.equal(pick?.id, "first");
  });

  it("falls back to the SHORTEST long thing when nothing is in band", () => {
    // An hour of continuous music is closer to what someone wanted than an
    // error — but a 20-minute set beats a two-hour one.
    const pick = pickSongLike([v("huge", "PT2H"), v("long", "PT20M")]);
    assert.equal(pick?.id, "long");
  });

  it("returns null when everything is a Short or live", () => {
    assert.equal(pickSongLike([v("a", "PT18S"), v("b", "P0D"), v("c", "PT45S")]), null);
    assert.equal(pickSongLike([]), null);
  });
});

describe("volume by voice", () => {
  it("recognises quieter and louder in Hindi and English", () => {
    for (const t of ["dheere karo", "aawaz kam karo", "volume kam", "bahut tez"]) {
      assert.equal(matchMediaIntent(t, "hi-IN"), "quieter", t);
    }
    for (const t of ["tez karo", "aawaz badhao", "zor se", "sunai nahi de raha"]) {
      assert.equal(matchMediaIntent(t, "hi-IN"), "louder", t);
    }
    assert.equal(matchMediaIntent("turn it down", "en-IN"), "quieter");
    assert.equal(matchMediaIntent("louder please", "en-IN"), "louder");
  });

  it("understands English volume words in every language", () => {
    for (const l of ["ta-IN", "bn-IN", "or-IN", "gu-IN"] as const) {
      assert.equal(matchMediaIntent("turn it down", l), "quieter", l);
      assert.equal(matchMediaIntent("louder", l), "louder", l);
    }
  });

  it("lets STOP win over anything that looks like a volume word", () => {
    // "bas" is a Hindi stop word. Reading it as a volume change would leave the
    // music playing, which is the one outcome that must never happen.
    assert.equal(matchMediaIntent("bas", "hi-IN"), "stop");
    assert.equal(matchMediaIntent("band karo", "hi-IN"), "stop");
  });

  it("does not read 'not so loud' as louder", () => {
    // It contains "loud". Quieter is checked first for exactly this.
    assert.equal(matchMediaIntent("not so loud", "en-IN"), "quieter");
  });

  it("returns null for ordinary speech, which must reach the model", () => {
    assert.equal(matchMediaIntent("what is the weather today", "en-IN"), null);
    assert.equal(matchMediaIntent("tere bina zindagi se koi shikwa", "hi-IN"), null);
    assert.equal(matchMediaIntent("", "hi-IN"), null);
  });

  it("has quieter and louder phrases for every speakable language", () => {
    for (const l of SPEAKABLE) {
      assert.ok((QUIETER_PHRASES[l.code] ?? []).length > 0, `${l.code} quieter`);
      assert.ok((LOUDER_PHRASES[l.code] ?? []).length > 0, `${l.code} louder`);
    }
  });
});
