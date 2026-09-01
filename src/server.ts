/**
 * Device-facing WebSocket server.
 *
 * Protocol (device <-> server):
 *   device -> server   binary  : linear16 PCM @ ASR_SAMPLE_RATE, mono
 *   device -> server   json    : { type: "hello", uid, locale_hint? }
 *   server -> device   binary  : linear16 PCM @ TTS_SAMPLE_RATE, mono
 *   server -> device   json    : { type: "clear_audio" }        -- flush playback NOW
 *                                { type: "ready", sid }
 *                                { type: "session_closed", reason }
 *                                { type: "play_media", source, ... } -- start music
 *                                { type: "stop_media" }              -- stop it
 *
 * MEDIA IS NOT SPEECH, and does not travel as PCM. `play_media` carries a
 * `source` of "radio" (with `urls`, best first — stations rot, so the device
 * tries the next) or "youtube" (with `video_id`). The DEVICE fetches and plays
 * it; the server never touches those bytes. Same reason `clear_audio` exists:
 * buffered audio lives on the device. A four-minute track is that rule at its
 * most extreme — streaming it server-side would put ~11 MB of PCM per song on
 * this socket alongside TTS. See src/tools/music.ts.
 *
 * `clear_audio` is the barge-in signal. The server decides; the device executes.
 * Buffered audio lives on the device, so only the device can actually drop it.
 * See docs/adr/0007-audio-front-end.md
 */

import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config/env.ts";
import { assertMatrixIntegrity, SPEAKABLE } from "./domain/languages.ts";
import { pendingNativeReview } from "./copy/refusals.ts";
import { Session } from "./orchestrator/session.ts";
import { MemorySessionStore } from "./store/memory-store.ts";
import { RedisSessionStore } from "./store/redis-store.ts";
import type { SessionStore } from "./store/session-store.ts";
import { InMemoryMemWriteStream } from "./memory/stream.ts";
import { BufferedMemWriteStream } from "./memory/buffered-stream.ts";
import { InMemoryLongTermStore } from "./memory/in-memory-long-term-store.ts";
import { HashingEmbedder } from "./memory/long-term-store.ts";
import { LlmDistiller } from "./memory/distiller.ts";
import { MemoryWorker } from "./memory/worker.ts";
import { createCareSignalsAnalyser, type SignalsAnalyser } from "./memory/care-signals-analyser.ts";
import { SarvamLlm } from "./providers/sarvam-llm.ts";
import { DeepgramRead } from "./providers/deepgram-read.ts";
import { ToolRegistry } from "./tools/registry.ts";
import {
  BUILTIN_TOOLS,
  NEWS_CATEGORIES,
  createGetNews,
  createGetWeather,
  createRecallMood,
  type NewsCategory,
} from "./tools/builtin.ts";
import { pendingCopyReview } from "./copy/fillers.ts";
import { GuardedSessionStore } from "./store/guarded-store.ts";
import { HoldingAudio } from "./audio/holding-audio.ts";
import { redundancyProfile } from "./domain/asr-failover.ts";
import { RadioCatalogue } from "./domain/radio-catalogue.ts";
import { createPlayMusic } from "./tools/music.ts";
import {
  createAddAppointment,
  createGetAppointments,
  googleSource,
  icalSource,
  type CalendarSource,
} from "./tools/calendar.ts";
import { GoogleCalendar, parseServiceAccount } from "./providers/google-calendar.ts";
import { createSmtpSender, type MailSender } from "./providers/smtp.ts";
import { createHttpMailSender } from "./providers/mail-api.ts";
import { createRaiseAlarm, EmergencyAlerter, parseContacts } from "./tools/emergency.ts";
import { pendingEmergencyReview } from "./copy/emergency-intent.ts";
import { pendingStopReview } from "./copy/stop-intent.ts";

/** Parses as http(s). Anything else in NEWS_FEEDS is config damage, not a feed. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Enough of a URL to debug it, never enough to use it.
 *
 * A calendar feed needs no API key, which makes it easy to forget that THE URL
 * IS THE CREDENTIAL: Google's "secret address in iCal format" carries a
 * `private-<hash>` segment, and anyone holding it can read that person's whole
 * diary, indefinitely, with no login and no audit trail. So it is a secret that
 * happens to be shaped like a link — and a link is exactly the kind of thing
 * that gets pasted into a log, a ticket or a screenshot without a second look.
 *
 * The host is the useful half for diagnosis ("that isn't Google at all"); the
 * path is the half worth protecting.
 */
function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}/… (${value.length} chars)`;
  } catch {
    // Unparseable is the common case here — that is usually why it was dropped.
    return `<unparseable, ${value.length} chars, starts "${value.slice(0, 12)}">`;
  }
}

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export type ServerHandle = {
  wss: WebSocketServer;
  /** Stops the memory worker too — otherwise it keeps the process alive. */
  shutdown(): void;
};

export function start(): ServerHandle {
  // Fail fast on a malformed matrix. A typo here becomes a user hearing nothing,
  // which is the one failure this whole subsystem exists to prevent.
  assertMatrixIntegrity();

  const cfg = loadConfig();

  const pending = [
    ...pendingNativeReview().map((p) => p.language),
    ...pendingCopyReview().map((p) => p.language),
  ];
  if (pending.length > 0) {
    log("warn", "spoken copy pending native review — do not ship to users", {
      entries: pending.length,
      languages: [...new Set(pending)],
    });
  }

  // Behind a circuit breaker so a Redis outage costs one round trip, not one per
  // call per turn. The degraded path was always specified; the breaker is what
  // makes it arrive on time. See src/store/guarded-store.ts
  const store: SessionStore = new GuardedSessionStore(
    cfg.redisUrl ? new RedisSessionStore(cfg.redisUrl) : new MemorySessionStore(),
    { log },
  );

  if (!cfg.redisUrl) {
    log("warn", "no REDIS_URL — using in-process working memory", {
      note: "sessions will not survive a restart and cannot be shared across replicas",
    });
  }

  // Long-term memory. In-process by default; ADR 0004 (Postgres + pgvector) is
  // still Proposed, so the durable backend is deliberately not wired yet.
  //
  // The buffer resolves the decision docs/02 section 6 left open: bounded, drops
  // the oldest low-priority event on overflow, and counts every drop.
  //
  // NOTE the asymmetry with `store` above, which DOES switch on cfg.redisUrl:
  // the stream is in-process even when Redis is available, so `mem:writes` does
  // not survive a restart and cannot be shared across replicas. That contradicts
  // docs/02 section 3, which specifies it as a Redis Stream.
  // `RedisMemWriteStream` implements that spec and is ready; swapping it in here
  // is the whole change. Left unwired deliberately — see the note on the class.
  const memStream = new BufferedMemWriteStream(new InMemoryMemWriteStream(), {
    capacity: cfg.memWriteBufferCapacity,
    log,
    onStateChange: (buffering) =>
      log(buffering ? "warn" : "info", "mem:writes buffering", { buffering }),
  });
  const longTerm = new InMemoryLongTermStore(new HashingEmbedder());

  // Retrospective wellbeing analysis of closed sessions (ADR 0009). Wired into
  // the WORKER and nowhere else: nothing on the voice path calls Deepgram for
  // this, on any turn. Off unless the deployment turned it on — see the config
  // block in src/config/env.ts for the three reasons why that is the default.
  let signals: SignalsAnalyser | null = null;
  if (cfg.careSignalsEnabled) {
    signals = createCareSignalsAnalyser(new DeepgramRead(cfg), {
      deadlineMs: cfg.careSignalsDeadlineMs,
      intentConfidence: cfg.careSignalsIntentConfidence,
      log,
    });
    log("warn", "care signals ON — English sessions are sent to Deepgram after close", {
      endpoint: `${cfg.deepgramReadBase}/v1/read`,
      note: "transcripts leave India; ten of eleven languages are never analysed",
      intent_confidence_floor: cfg.careSignalsIntentConfidence,
      unverified: "field names reconstructed from docs — run npm run verify:care",
    });
  }

  const worker = new MemoryWorker({
    stream: memStream,
    longTerm,
    sessions: store,
    distiller: new LlmDistiller(new SarvamLlm(cfg)),
    ...(signals ? { signals } : {}),
    options: { log, blockMs: 1000 },
  });
  void worker.start();

  log("warn", "long-term memory is in-process and NOT durable", {
    note: "facts and episodes are lost on restart; see docs/adr/0004-vector-store.md",
    embedder: "HashingEmbedder (lexical only — no cross-lingual matching)",
  });

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

  // Calendars. Two backends, one tool — see src/tools/calendar.ts. Registered
  // only where a calendar is configured, same rule as every other external tool.
  const calendarSources: CalendarSource[] = [];

  for (const [label, url] of Object.entries(cfg.calendarFeeds)) {
    if (!isHttpUrl(url)) {
      log("error", "CALENDAR_FEEDS entry is not a usable http(s) URL — dropped", {
        label,
        url: redactUrl(url),
      });
      continue;
    }
    calendarSources.push(icalSource(label, url));
  }
  if (cfg.calendarFeedsDropped.length > 0) {
    log("error", "CALENDAR_FEEDS has unreadable segments — a URL is likely truncated", {
      dropped: cfg.calendarFeedsDropped,
      hint: "percent-encode a literal comma as %2C",
    });
  }

  // The API path. A service account outranks an API key where both are set,
  // because a key cannot read a private calendar OR write at all.
  let googleCalendar: GoogleCalendar | null = null;
  try {
    const account = parseServiceAccount(cfg.googleServiceAccountJson, (p) =>
      readFileSync(p, "utf8"),
    );
    if (account) {
      googleCalendar = new GoogleCalendar({
        auth: { mode: "service_account", ...account },
      });
      log("info", "google calendar: service account", { client_email: account.clientEmail });
    } else if (cfg.googleCalendarApiKey) {
      googleCalendar = new GoogleCalendar({
        auth: { mode: "api_key", key: cfg.googleCalendarApiKey },
      });
      // Said at boot, once, in the place someone will actually look — rather
      // than left to surface as a 401 in the middle of a conversation.
      log("warn", "google calendar: API KEY ONLY — public calendars, read-only", {
        cannot: ["read a private calendar", "create or change any event"],
        fix: "share the calendar with a service account, then set GOOGLE_SERVICE_ACCOUNT_JSON",
      });
    }
  } catch (err) {
    log("error", "google calendar credential unusable — API path disabled", {
      error: String(err instanceof Error ? err.message : err),
    });
  }

  if (googleCalendar) {
    if (Object.keys(cfg.googleCalendarIds).length === 0) {
      log("error", "a Google credential is set but GOOGLE_CALENDAR_IDS is empty", {
        hint: "label=calendarId pairs; a personal calendar's id is its email address",
      });
    }
    for (const [label, id] of Object.entries(cfg.googleCalendarIds)) {
      calendarSources.push(googleSource(label, id, googleCalendar));
    }
  }
  if (cfg.googleCalendarIdsDropped.length > 0) {
    log("error", "GOOGLE_CALENDAR_IDS has unreadable segments", {
      dropped: cfg.googleCalendarIdsDropped,
      hint: "percent-encode a literal comma as %2C",
    });
  }

  if (calendarSources.length > 0) {
    tools.register(
      createGetAppointments({ sources: calendarSources, limit: cfg.calendarEventLimit }),
    );
  }

  // Writing. Gated three ways: a credential that CAN write, a calendar id, and
  // an explicitly named target — never a guess about which diary an appointment
  // belongs in.
  if (googleCalendar?.canWrite) {
    const target = cfg.calendarWriteTarget;
    const ids = cfg.googleCalendarIds;
    const only = Object.keys(ids).length === 1 ? Object.keys(ids)[0]! : null;
    const label = target ?? only;

    if (label && ids[label]) {
      tools.register(
        createAddAppointment({ client: googleCalendar, calendarId: ids[label], label }),
      );
    } else if (label) {
      log("error", "CALENDAR_WRITE_TARGET names a calendar that is not configured", {
        target: label,
        known: Object.keys(ids),
      });
    } else if (Object.keys(ids).length > 1) {
      log("warn", "add_appointment not registered: several calendars, no write target named", {
        known: Object.keys(ids),
        hint: "set CALENDAR_WRITE_TARGET to one of them",
      });
    }
  }

  // Emergency contacts. Registered only when there is somewhere to send an
  // alert AND a relay to send it through — see below for why half-configured is
  // treated as not configured.
  const { contacts, invalid } = parseContacts(cfg.emergencyContacts);
  if (invalid.length > 0) {
    log("error", "EMERGENCY_CONTACTS has entries that are not email addresses — dropped", {
      dropped: invalid,
    });
  }

  // One seam, two transports. See src/providers/mail-api.ts for why the HTTP
  // one is preferred on this particular path.
  let mailSender: MailSender | null = null;
  let transportLabel = "";
  if (cfg.mailTransport === "smtp") {
    if (cfg.smtpHost && cfg.smtpFrom) {
      mailSender = createSmtpSender({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        security: cfg.smtpSecurity,
        user: cfg.smtpUser,
        pass: cfg.smtpPass,
        from: cfg.smtpFrom,
      });
      transportLabel = `smtp ${cfg.smtpHost}:${cfg.smtpPort} (${cfg.smtpSecurity})`;
    }
  } else if (cfg.mailApiKey && cfg.mailFrom) {
    mailSender = createHttpMailSender({
      provider: cfg.mailTransport,
      apiKey: cfg.mailApiKey,
      from: cfg.mailFrom,
    });
    transportLabel = `${cfg.mailTransport} web api, from ${cfg.mailFrom}`;
  }

  let alerter: EmergencyAlerter | null = null;
  if (contacts.length > 0 && mailSender) {
    alerter = new EmergencyAlerter({
      send: mailSender,
      contacts,
      cooldownMs: cfg.emergencyCooldownMs,
      log,
    });
    tools.register(createRaiseAlarm(alerter));

    // Said at boot at WARN, deliberately. An unreviewed stop phrase means the
    // music does not stop; an unreviewed emergency phrase means a call for help
    // does not register, and nobody finds out until it matters.
    const unreviewed = pendingEmergencyReview();
    log("warn", "emergency alerting ARMED", {
      contacts: contacts.map((c) => `${c.name} <${c.email}>`),
      transport: transportLabel,
      unreviewed_languages: unreviewed,
      note: "en-IN and hi-IN phrases reviewed; the rest need a native speaker",
    });
  } else if (contacts.length > 0 || cfg.smtpHost || cfg.mailApiKey) {
    // HALF-CONFIGURED IS THE DANGEROUS STATE, so it is refused rather than
    // half-enabled. Contacts with no relay would recognise "help" and have no
    // way to send it; a relay with no contacts has nowhere to send it. Either
    // way the companion would say help is coming when nothing is.
    log("error", "EMERGENCY ALERTING IS OFF — configured only halfway", {
      contacts: contacts.length,
      transport: cfg.mailTransport,
      ...(cfg.mailTransport === "smtp"
        ? {
            smtp_host: cfg.smtpHost ? "set" : "MISSING",
            smtp_from: cfg.smtpFrom ? "set" : "MISSING",
          }
        : {
            mail_api_key: cfg.mailApiKey ? "set" : "MISSING",
            mail_from: cfg.mailFrom ? "set" : "MISSING",
          }),
      effect: "a call for help will be treated as an ordinary turn",
    });
  } else {
    log("warn", "emergency alerting is not configured", {
      hint: "set EMERGENCY_CONTACTS and SMTP_* to arm it",
    });
  }

  log("info", "tools registered", {
    count: tools.all().length,
    names: tools.all().map((t) => t.name),
    external: {
      music: cfg.musicEnabled ? (cfg.youtubeApiKey ? "radio+song" : "radio only") : false,
      calendars: calendarSources.map((s) => s.label),
      calendar_writable: googleCalendar?.canWrite ?? false,
      emergency: alerter ? contacts.map((c) => c.name) : false,
      weather: cfg.weatherEnabled,
      news: Object.keys(newsFeeds),
      // Worth saying out loud at boot: this is the one hop that is not Sarvam
      // and not in India. See the residency note in src/config/env.ts.
      residency: cfg.weatherEnabled ? "get_weather leaves India (Open-Meteo, EU)" : "all in-India",
    },
    note: "sarvam-105b tool-calling verified 2026-08-29 — npm run verify:tools",
  });

  // The apology for a Bulbul outage, rendered ahead of time — the one message
  // that cannot be synthesised, because synthesis is what broke.
  const holdingAudio = new HoldingAudio({
    dir: cfg.holdingAudioDir,
    expectedSampleRate: cfg.ttsSampleRate,
    log,
  });
  holdingAudio.load();

  // State the availability profile at boot rather than during an incident.
  const redundancy = redundancyProfile(SPEAKABLE.map((l) => l.code));
  log(cfg.asrFailoverEnabled ? "info" : "warn", "asr failover", {
    enabled: cfg.asrFailoverEnabled,
    key_present: cfg.deepgramApiKey !== null,
    redundant_languages: redundancy.redundant,
    single_vendor_languages: redundancy.singleVendor.length,
    tts_failover: "none, for any language — docs/adr/0005-tts-provider-split.md",
    residency: cfg.asrFailoverEnabled
      ? "ENABLED: a failover sends audio to Deepgram, which publishes no India region"
      : "disabled by default; enabling relocates audio out of India (docs/05 Q14)",
  });

  const wss = new WebSocketServer({ port: cfg.port });
  log("info", "listening", {
    port: cfg.port,
    speakable: SPEAKABLE.length,
    asrRate: cfg.asrSampleRate,
    ttsRate: cfg.ttsSampleRate,
    store: cfg.redisUrl ? "redis" : "memory",
  });

  wss.on("connection", (ws: WebSocket) => {
    let session: Session | null = null;

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session?.pushAudio(data);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log("warn", "device sent non-JSON control frame");
        return;
      }

      // Playback finished on the device. The session gates listening on a media
      // flag, so a track that ends without reporting it leaves the user unheard.
      if (msg["type"] === "media_ended") {
        session?.mediaEnded();
        return;
      }

      if (msg["type"] === "hello" && session === null) {
        session = new Session({
          cfg,
          store,
          memStream,
          tools,
          longTerm,
          holdingAudio,
          // Null when unconfigured, which leaves the alarm path inert rather
          // than half-working. See the boot log above.
          ...(alerter ? { alerter } : {}),
          // fetchContext: wire your backend here. Without it, entitlement-gated
          // tools are withheld rather than offered unverified.
          uid: String(msg["uid"] ?? "anonymous"),
          // A device reconnecting with its previous sid resumes that thread,
          // provided the idle window has not lapsed.
          sid: typeof msg["sid"] === "string" ? msg["sid"] : undefined,
          localeHint: typeof msg["locale_hint"] === "string" ? msg["locale_hint"] : undefined,
          log,
          device: {
            sendAudio: (pcm) => {
              if (ws.readyState === ws.OPEN) ws.send(pcm, { binary: true });
            },
            sendControl: (m) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
            },
            close: () => ws.close(),
          },
        });
        ws.send(JSON.stringify({ type: "ready", sid: session.sid }));
        void session.start();
      }
    });

    ws.on("close", () => session?.close("device_disconnected"));
    ws.on("error", (err) => log("error", "device socket", { err: err.message }));
  });

  return {
    wss,
    shutdown() {
      worker.stop();
      // One last drain attempt. A buffered backlog dies with the process — that
      // is what "bounded in-process buffer" means, and it is stated plainly in
      // docs/adr/0008-degradation-policy.md rather than discovered.
      void memStream.close().catch(() => {});
      // Redis holds live sockets, and closing the WSS does not touch them. Without
      // this the event loop never empties: `REDIS_URL=… npm test` hangs on
      // server.test.ts until the runner kills it, and the direct-run path below
      // only escapes because it force-exits on a timer.
      void store.close().catch(() => {});
      wss.close();
    },
  };
}

// Only auto-run when executed directly, so tests can drive start() themselves.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const handle = start();
  const shutdown = () => {
    log("info", "shutting down");
    handle.shutdown();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
