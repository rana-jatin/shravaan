/**
 * Environment configuration, validated once at boot.
 *
 * Audio rates are NOT free choices. Sarvam's realtime STT socket accepts only
 * 8000 or 16000 and closes with code 4000 otherwise; Bulbul streaming is capped
 * at 24 kHz. Those constraints are enforced here rather than discovered at
 * runtime as a dropped connection.
 */

const ASR_ALLOWED_RATES = [8000, 16000] as const;
const TTS_MAX_STREAMING_RATE = 24000;

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env.`);
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const asrSampleRate = num("ASR_SAMPLE_RATE", 16000);
  const ttsSampleRate = num("TTS_SAMPLE_RATE", 24000);

  if (!ASR_ALLOWED_RATES.includes(asrSampleRate as 8000 | 16000)) {
    throw new Error(
      `ASR_SAMPLE_RATE must be 8000 or 16000 (Sarvam closes the socket with code 4000 ` +
        `otherwise). Got ${asrSampleRate}.`,
    );
  }
  if (ttsSampleRate > TTS_MAX_STREAMING_RATE) {
    throw new Error(
      `TTS_SAMPLE_RATE must be <= ${TTS_MAX_STREAMING_RATE} — Bulbul streaming is capped ` +
        `at 24 kHz. Got ${ttsSampleRate}.`,
    );
  }

  // Fail at boot, not at the end of the first English session. The alternative
  // is a deployment that believes it is recording wellbeing signals and silently
  // writes none for a week — a broken feature nobody is watching is worse than a
  // process that will not start.
  if (opt("CARE_SIGNALS_ENABLED", "false") === "true" && !process.env["DEEPGRAM_API_KEY"]?.trim()) {
    throw new Error(
      "CARE_SIGNALS_ENABLED=true requires DEEPGRAM_API_KEY — the analysis runs on " +
        "Deepgram's /v1/read. See docs/adr/0009-audio-intelligence.md.",
    );
  }

  // Parsed ONCE each. Every one of these was previously parsed twice — once for
  // the pairs and again for the orphans — which is two chances for the two
  // halves to disagree about what a value contained.
  const news = parsePairs(process.env["NEWS_FEEDS"]);
  const calendars = parsePairs(process.env["CALENDAR_FEEDS"]);
  const googleCalendars = parsePairs(process.env["GOOGLE_CALENDAR_IDS"]);

  return {
    defaultSeedLanguage: opt("DEFAULT_SEED_LANGUAGE", "hi-IN"),
    /**
     * Fallback for `get_time` when JSON context carries no `identity.timezone`.
     * The model has no clock, so a wrong zone here is a confidently wrong answer
     * rather than a missing one — set it per deployment region.
     */
    defaultTimezone: opt("DEFAULT_TIMEZONE", "Asia/Kolkata"),
    /**
     * Echo guard. NOT a substitute for device-side AEC — the second layer that
     * catches what leaks through. See docs/adr/0007-audio-front-end.md
     *
     * Defaults are deliberately conservative: a bot that occasionally misses an
     * interruption is tolerable, one that interrupts itself is unusable. Tune
     * toward sensitivity only once AEC is measured on real hardware.
     */
    echoGuard: {
      suppressionWindowMs: num("ECHO_SUPPRESSION_MS", 400),
      requireTranscript: opt("ECHO_REQUIRE_TRANSCRIPT", "true") !== "false",
      selfEchoThreshold: num("ECHO_SELF_THRESHOLD", 0.6),
      /** Emergency fallback from ADR 0007: mutes barge-in entirely. */
      halfDuplex: opt("HALF_DUPLEX", "false") === "true",
    },
    /**
     * Working memory. Unset means an in-process store — fine for a single
     * instance and for development, useless across restarts or replicas.
     * A store outage is survivable by design: the session continues stateless
     * and marks itself degraded.
     */
    redisUrl: process.env["REDIS_URL"]?.trim() || null,
    /**
     * Pre-rendered apology audio for a Bulbul outage. Generated ahead of time by
     * `npm run render:holding` — you cannot render it during the outage it exists
     * for. See src/audio/holding-audio.ts
     */
    // Relative to backend/'s cwd, which is where `npm run dev` launches the
    // server from — the clips themselves live in ai/assets/holding.
    holdingAudioDir: opt("HOLDING_AUDIO_DIR", "../ai/assets/holding"),
    /**
     * Bounded in-process buffer for `mem:writes` when the stream is unreachable.
     * Overflow drops the oldest low-priority event and counts it — the decision
     * docs/02-data-contracts.md section 6 left open, resolved in ADR 0008.
     */
    memWriteBufferCapacity: num("MEM_WRITE_BUFFER", 500),
    port: num("PORT", 8080),

    /** Sarvam: ASR, LLM and TTS. Every hop on the default path. */
    sarvam: {
      apiKey: req("SARVAM_API_KEY"),
      // NOTE: these bases come from Sarvam's guide pages. The API-reference pages
      // that would confirm exact hostnames returned 404 during research
      // (docs/05-open-questions.md Q12). Verify before first run.
      apiBase: opt("SARVAM_API_BASE", "https://api.sarvam.ai"),
      wsBase: opt("SARVAM_WS_BASE", "wss://api.sarvam.ai"),
      asrModel: opt("SARVAM_ASR_MODEL", "saaras:v3-realtime"),
      ttsModel: opt("SARVAM_TTS_MODEL", "bulbul:v3"),
      /**
       * `sarvam-105b-conversations`, NOT `sarvam-105b`. Both are live on
       * `/v1/models`; only one of them can hold a conversation.
       *
       * sarvam-105b is a REASONING model. It streams thousands of characters of
       * `reasoning_content` before the first `content` token, and nothing about
       * that is visible in the response shape until you look for the field.
       * Measured over 12 identical calls, 2026-08-30:
       *
       *                        sarvam-105b    sarvam-105b-conversations
       *   first content token   12,777 ms     313 ms      (median)
       *   reasoning_content     4.9k-7.8k     0            chars/turn
       *   empty completions     3/12          0/12
       *   dropped connections   2/12          0/12
       *
       * The latency alone disqualifies it: the clause chunker exists to start
       * synthesis at the first clause boundary, and it cannot start before a
       * clause exists. Twelve seconds of silence is not a companion.
       *
       * The empty completions were the same cause, not a separate fault — the
       * reasoning burn is what exhausted capacity. Sarvam sheds load as a 200 with
       * zero content deltas, or a dropped socket. Never a 429.
       *
       * Two things carry over to the conversations model, so do not delete them:
       * the `{}{}` argument retransmission (`accumulateArgs`), which still occurs;
       * and `max_tokens` counting reasoning tokens, which is only harmless while
       * the reasoning model is unused.
       *
       * KNOWN, and off the product path: `tool_choice: "required"` degenerates on
       * this model — it emits the call, then loops whitespace to the token cap
       * (87 s, finish_reason "length"). The orchestrator only ever sends "auto"
       * and "none" (src/orchestrator/session.ts). Keep it that way.
       */
      llmModel: opt("SARVAM_LLM_MODEL", "sarvam-105b-conversations"),
      /**
       * ANSWERED against a live key, 2026-08-29: the token is `auto`.
       *
       * Sarvam's docs gave three answers — "auto" (realtime page), "unknown"
       * (Saaras page and the agent product), and explicit-required (streaming
       * guide) — and this defaulted to "unknown", which the socket rejects:
       *
       *   4000 Unsupported language_code 'unknown'. Supported values: auto,
       *   hi-IN, bn-IN, kn-IN, ml-IN, mr-IN, or-IN, pa-IN, ta-IN, te-IN, …
       *
       * That is every session with no profile and no locale hint, so the default
       * mattered. docs/05-open-questions.md Q1
       */
      asrAutodetectToken: opt("ASR_AUTODETECT_TOKEN", "auto"),
    },

    /** Wire format. Not free choices - see the rate checks above. */
    audio: {
      asrSampleRate,
      ttsSampleRate,
      ttsSpeaker: opt("TTS_SPEAKER", "shubh"),
      ttsPace: num("TTS_PACE", 1.0),
    },

    /** Deepgram. Two features share one credential, which is why the key
     * lives here rather than inside either of them. */
    deepgram: {
      apiKey: process.env["DEEPGRAM_API_KEY"]?.trim() || null,
      wsBase: opt("DEEPGRAM_WS_BASE", "wss://api.deepgram.com"),
      /** Flux Multilingual: the only Deepgram streaming model that reaches Hindi. */
      asrModel: opt("DEEPGRAM_ASR_MODEL", "flux-general-multi"),
      /** Same host as the ASR standby, different scheme — this half is REST. */
      readBase: opt("DEEPGRAM_READ_BASE", "https://api.deepgram.com"),
    },

    /** The ASR standby (ADR 0006). Off by default: enabling it relocates
     * audio out of India. */
    asrFailover: {
      // --- Degradation (slice 8) ------------------------------------------------

      /**
       * ASR failover to Deepgram Flux. Covers `hi-IN` and `en-IN` ONLY; nine of our
       * eleven languages have no second ASR at all.
       *
       * OFF BY DEFAULT, AND NOT BECAUSE OF THE COVERAGE GAP.
       *
       * Sarvam's pitch includes "Data residency in India"
       * (https://docs.sarvam.ai/conversations/overview.md). Deepgram publishes EU
       * and AU endpoints and **no India region**
       * (https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available).
       * So an automatic failover quietly relocates a user's voice out of the
       * country, mid-conversation, as an incident-response side effect. That is a
       * decision for whoever owns the data-protection posture, not a default.
       * See docs/05-open-questions.md Q14.
       */
      enabled: opt("ASR_FAILOVER_ENABLED", "false") === "true",
    },

    /** Retrospective wellbeing analysis (ADR 0009). English only, off by
     * default, and never on the voice path. */
    careSignals: {
      // --- Care signals (ADR 0009) ---------------------------------------------

      /**
       * Retrospective wellbeing analysis of CLOSED sessions, via Deepgram's
       * `/v1/read`. Off by default, for three separate reasons and any one of them
       * is enough:
       *
       *   1. RESIDENCY. Same call as `asrFailoverEnabled` above, one notch down:
       *      what crosses the border is a transcript rather than the voice itself.
       *      Still the user's words, still leaving India. Q14.
       *   2. COVERAGE. English only — every feature on that endpoint is. Ten of our
       *      eleven languages get nothing, forever, and a deployment that speaks
       *      Tamil should not be paying for a Deepgram key to receive silence.
       *   3. CONSENT. Scoring how someone sounded and keeping the trend is a
       *      different promise from remembering what they told you. It belongs to
       *      whoever wrote the consent form, not to a default.
       *
       * NOTHING ON THE VOICE PATH READS THIS. The analysis runs in the memory
       * worker; `recall_mood` reads what it wrote. See ADR 0009.
       */
      enabled: opt("CARE_SIGNALS_ENABLED", "false") === "true",
      /**
       * Hard cap on the analysis round trip. Generous, because nobody is waiting on
       * it — but bounded, because a wedged HTTP call becomes consumer lag, and
       * consumer lag is how long the companion has been out of date.
       */
      deadlineMs: num("CARE_SIGNALS_DEADLINE_MS", 8000),
      /**
       * Confidence floor for a watch-list intent. ⚠ A GUESS: Deepgram publishes no
       * calibration for `confidence_score`. Tune it against real transcripts before
       * anyone acts on the output. See mapIntents in src/domain/care-signals.ts.
       */
      intentConfidence: num("CARE_SIGNALS_INTENT_CONFIDENCE", 0.5),
    },

    /** get_weather. Open-Meteo is EU-hosted - see src/tools/external.ts. */
    weather: {
      // --- External tools -------------------------------------------------------

      /**
       * Weather, via Open-Meteo. OFF BY DEFAULT, for the reason ASR failover is.
       *
       * Open-Meteo needs no key and charges nothing, which makes it the obvious
       * choice on every axis except the one this product cares about: it is
       * EU-hosted, so a weather question sends a place name out of India. That is
       * a much smaller exposure than routing a user's VOICE to Deepgram — a city
       * name against an audio stream — but it is the same decision, and it belongs
       * to whoever owns the data-protection posture. See docs/05-open-questions.md
       * Q14 and the divider above `createGetWeather`.
       *
       * Swapping providers is a config change plus the response mapping in
       * builtin.ts, which assumes Open-Meteo's `current`/`daily` shape.
       */
      enabled: opt("WEATHER_ENABLED", "false") === "true",
      apiBase: opt("WEATHER_API_BASE", "https://api.open-meteo.com"),
      geocodeBase: opt("WEATHER_GEOCODE_BASE", "https://geocoding-api.open-meteo.com"),
      /**
       * Only used when the model sends a blank place — never to override one it
       * gave. Unset means the companion asks which city, which is the right answer
       * far more often than a guess is.
       */
      defaultPlace: process.env["WEATHER_DEFAULT_PLACE"]?.trim() || null,
      /**
       * Country tried FIRST when geocoding, then abandoned if it finds nothing.
       *
       * Not cosmetic. Asked for "Allahabad", an unbiased Open-Meteo query returns
       * ten Iranian villages and no Indian hit — a live call returned weather for
       * Razavi Khorasan, fluently and with nothing to mark it wrong. A preference
       * rather than a filter, so "London" still resolves to Britain on the retry.
       * Empty disables it. See PLACE_ALIASES in src/tools/builtin.ts.
       */
      countryBias: opt("WEATHER_COUNTRY_BIAS", "IN") || null,
      /**
       * India Post, for six-digit PIN codes — which Open-Meteo cannot geocode at
       * all. Empty disables pincode support and the tool asks for a place name.
       *
       * One for the residency ledger: this host is in India, so the lookup most
       * likely to be phrased as a number never leaves the country.
       */
      pincodeApiBase: opt("WEATHER_PINCODE_API", "https://api.postalpincode.in") || null,
    },

    /** get_news. Feeds are per deployment; unconfigured is unregistered. */
    news: {
      /**
       * News, via RSS. Also off by default, and configured as feed URLs rather
       * than a vendor — which is deliberate: it lets a deployment point at a
       * domestic outlet and keep the hop in India, where a news API would not.
       *
       * Format: `category=url` pairs, comma-separated. Categories outside
       * NEWS_CATEGORIES are ignored at registration, and only the categories
       * actually configured are offered to the model as enum values.
       *
       *   NEWS_FEEDS="top=https://…/national.rss,sports=https://…/sport.rss"
       *
       * No default feeds ship, and that is not laziness. A wrong URL here is a
       * companion confidently reading someone else's headlines, and the repo has
       * no way to verify a feed it has never fetched — the same honesty the
       * Sarvam API bases carry above (Q12).
       */
      feeds: news.pairs,
      /**
       * Comma-separated segments that carried no `=`, in order.
       *
       * Almost always the tail of a URL that contained a literal comma: the pair
       * splits, the first half stays a perfectly valid URL, and the rest lands
       * here. Surfaced rather than dropped because the alternative is a feed that
       * 404s at request time with nothing in the log pointing at the config.
       */
      feedsDropped: news.dropped,
      headlineLimit: num("NEWS_HEADLINE_LIMIT", 5),
    },

    /** play_music. Live radio always; YouTube only with a key. */
    music: {
      /**
       * Music. Radio needs nothing; songs need a YouTube key.
       *
       * Off by default like the other external tools — but note the egress here is
       * larger than weather's. Station METADATA comes from Radio Browser (EU), and
       * the audio streams from whichever third-party host the station runs on.
       * See docs/05-open-questions.md Q14.
       */
      enabled: opt("MUSIC_ENABLED", "false") === "true",
      /**
       * Drop every non-stop transcript while media plays.
       *
       * OFF. It was on, and it was wrong: asking for the weather over the radio
       * got silence, and a companion that stops listening the moment it starts
       * entertaining you is not a companion.
       *
       * The cost of leaving it off is real — the ASR transcribes song lyrics as
       * user speech, and the model will sometimes answer them. Turn this on if
       * that becomes intolerable before ducking exists. "Stop" is matched locally
       * either way and is never affected by this setting.
       */
      restrictListening: opt("MUSIC_RESTRICT_LISTENING", "false") === "true",
      /**
       * Playback volume, 0-100, applied when a stream starts.
       *
       * Below 100 because there is still no device-side AEC. It used to be the
       * ONLY defence: with no ducking, any real volume meant the microphone heard
       * the loudspeaker instead of the person, the ASR never reported speech, and
       * the companion appeared to stop listening — reported live at 55.
       *
       * The device now ducks under both voices (MUSIC_DUCK_VOLUME), so this is a
       * comfort setting again rather than the thing keeping the product usable.
       */
      volume: num("MUSIC_VOLUME", 70),
      radioApi: opt("MUSIC_RADIO_API", "https://de1.api.radio-browser.info"),
      /**
       * How often to refill the station list. Never inside a turn — a refresh of
       * six languages measured 4.4 s against the live directory, and it is
       * somebody's volunteer server.
       */
      refreshMinutes: num("MUSIC_REFRESH_MINUTES", 180),
      /** Fallbacks handed to the device per lookup. Stations rot; one is not enough. */
      stationsPerLanguage: num("MUSIC_STATIONS_PER_LANGUAGE", 3),
      /**
       * Drop plain-http streams. 15% of Indian stations are unencrypted, and the
       * device fetches whatever URL a community-edited directory returns.
       */
      secureOnly: opt("MUSIC_SECURE_ONLY", "true") !== "false",
      /**
       * Offered — never taken silently — when a language has no stations at all.
       * Gujarati has zero in the directory. Empty means say so and stop.
       */
      fallbackLanguage: opt("MUSIC_FALLBACK_LANGUAGE", "hi-IN") || null,
      /**
       * YouTube Data API key. Absent means `song` mode is not offered at all — the
       * `mode` enum shrinks to ["radio"].
       *
       * Quota: search costs 100 of 10,000 free daily units, so 100 searches a day.
       * Fine for a prototype, not for users.
       */
      youtubeApiKey: process.env["YOUTUBE_API_KEY"]?.trim() || null,
      youtubeApiBase: opt("YOUTUBE_API_BASE", "https://www.googleapis.com"),
    },

    /** get_appointments and add_appointment. iCal and Google. */
    calendar: {
      /**
       * Calendars, as iCal feed URLs. `label=url` pairs, same parsing as NEWS_FEEDS.
       *
       * The CREDENTIAL-FREE path, and still the fallback: Google publishes a
       * per-calendar "secret address in iCal format" under Settings > Integrate
       * calendar, and a caregiver pastes that one URL. No OAuth, no tokens, no
       * Google Cloud project. Read-only.
       *
       * ⚠ THE URL IS THE CREDENTIAL. It carries a `private-<hash>` segment and
       * anyone holding it can read that diary indefinitely, with no login and no
       * audit trail. It is a secret shaped like a link — never log it whole.
       *
       * The label is SPOKEN, so name it as a person would: `amma=https://...`.
       *
       *   CALENDAR_FEEDS="mine=https://calendar.google.com/calendar/ical/.../basic.ics"
       */
      feeds: calendars.pairs,
      feedsDropped: calendars.dropped,
      eventLimit: num("CALENDAR_EVENT_LIMIT", 6),
      /**
       * Google Calendar API v3 — the upgrade over the iCal feed.
       *
       * Worth it mainly because `singleEvents=true` makes GOOGLE expand the
       * recurrences. Our own expander had seven defects in it (D10), every one of
       * which spoke a wrong appointment aloud; Google's handles BYSETPOS,
       * BYMONTHDAY, RDATE and real TZID conversion, which ours does not.
       *
       * `label=calendarId` pairs. The id is an email-shaped string — a user's own
       * calendar is their Gmail address, and "primary" works ONLY with a
       * credential that has a user identity (never an API key).
       */
      googleIds: googleCalendars.pairs,
      googleIdsDropped: googleCalendars.dropped,
      /**
       * ⚠ AN API KEY READS PUBLIC CALENDARS AND NOTHING ELSE.
       *
       * A key answers "which project is calling"; it carries no user identity and
       * therefore no OAuth scope. Google's discovery document lists a required
       * scope on every write method (events.insert/update/patch/delete), and
       * there is no public-write scope the way there is a
       * `calendar.events.public.readonly` for reads. So with a key alone:
       *
       *   read a PUBLIC calendar ....... yes
       *   read a PRIVATE calendar ...... no
       *   write anything ............... no
       *
       * Use it for public data — a holidays calendar — and nothing more.
       */
      googleApiKey: process.env["GOOGLE_CALENDAR_API_KEY"]?.trim() || null,
      /**
       * A service account, as either inline JSON or a path to the file Google
       * Cloud downloads. THE credential for a private diary and for writing.
       *
       * The setup a caregiver can actually complete: create the service account,
       * then in Google Calendar use "Share with specific people" and paste its
       * `client_email` exactly as they would share with a person. No consent
       * screen, no refresh-token lifecycle, and it works on a consumer Gmail
       * calendar — not only Workspace.
       *
       * Sharing as "Make changes to events" is what enables add_appointment;
       * "See all event details" keeps it read-only.
       */
      googleServiceAccountJson: process.env["GOOGLE_SERVICE_ACCOUNT_JSON"]?.trim() || null,
      /**
       * Which calendar `add_appointment` writes to, by label. A write target is
       * always explicit: with two calendars configured and no target named, the
       * write tool is not registered at all rather than guessing which diary a
       * hospital appointment belongs in.
       */
      writeTarget: process.env["CALENDAR_WRITE_TARGET"]?.trim() || null,
    },

    /** raise_alarm. Inert unless contacts AND a relay are configured. */
    emergency: {
      /**
       * Emergency contacts, alerted when the user asks for help.
       *
       * `Name=email` pairs, comma-separated; the name is optional and is derived
       * from the address when absent. THE NAME IS SPOKEN — "I'm telling Harsh and
       * Aman" — because naming a person the user knows is the reassurance that
       * actually helps, where "I have called for help" is vague and frightening.
       *
       * ⚠ Unset means the alarm path is INERT: neither the local matcher nor the
       * `raise_alarm` tool is wired up. That is deliberate — a companion that
       * recognises "help" and has nowhere to send it would say help is coming
       * when nothing is. The server warns loudly at boot, because this is the one
       * capability whose absence should be noisy.
       */
      contacts: process.env["EMERGENCY_CONTACTS"]?.trim() || null,
      /** How long a repeated cry for help folds into the alert already sent. */
      cooldownMs: num("EMERGENCY_COOLDOWN_MS", 120_000),
    },

    /** How an alert actually leaves the process. One seam, two transports. */
    mail: {
      /**
       * How the alert leaves the building: `smtp`, or one of the HTTP APIs.
       *
       * WEB API IS PREFERRED FOR THIS PATH, and not as a matter of taste. SMTP is
       * a dozen round trips (EHLO, STARTTLS, EHLO, AUTH, MAIL, RCPT per contact,
       * DATA, body, terminator) where the API is one — on a bad mobile link that
       * is seconds against tens of seconds. And 465/587 are blocked outbound on
       * many campus and hostel networks, while 443 is not blocked anywhere the
       * device could reach Sarvam from in the first place.
       *
       * SMTP is NOT deprecated: it is the only way to point at a relay inside
       * India, which the residency thread in docs/05 Q14 cares about, and the
       * only one that works with no third party at all.
       */
      transport: opt("MAIL_TRANSPORT", "smtp") as "smtp" | "sendgrid" | "resend" | "brevo",
      /**
       * For any transport other than `smtp`.
       *
       * `SENDGRID_API_KEY` is accepted as an alias because that is the name in
       * SendGrid's own quickstart, and it is what anyone following their docs
       * will already have exported.
       */
      apiKey:
        process.env["MAIL_API_KEY"]?.trim() || process.env["SENDGRID_API_KEY"]?.trim() || null,
      /**
       * Sender address for the HTTP transports, `a@b.c` or `Name <a@b.c>`.
       * Falls back to SMTP_FROM so switching transports needs one variable.
       *
       * ⚠ It must be an address you have VERIFIED with the provider. All three
       * refuse to send from a domain you have not proved you control, and the
       * rejection reads like an auth error.
       */
      from:
        process.env["MAIL_FROM"]?.trim() ||
        process.env["SMTP_FROM"]?.trim() ||
        process.env["SMTP_USER"]?.trim() ||
        null,

      /** The SMTP transport, used when `transport` is "smtp". */
      smtp: {
        /**
         * SMTP, for the alert. No API key and no vendor: any relay works, so a
         * deployment can point at one inside India and keep the hop domestic.
         *
         * `SMTP_SECURITY` is `tls` (implicit, port 465), `starttls` (587) or `none`
         * (a relay on localhost). Gmail wants an APP PASSWORD, not the account
         * password — an ordinary password fails with a 535 that says nothing useful.
         */
        host: process.env["SMTP_HOST"]?.trim() || null,
        port: num("SMTP_PORT", 465),
        security: opt("SMTP_SECURITY", "tls") as "tls" | "starttls" | "none",
        user: process.env["SMTP_USER"]?.trim() || null,
        pass: process.env["SMTP_PASS"] || null,
        /** Envelope sender. Defaults to SMTP_USER, which is what most relays require. */
        from: process.env["SMTP_FROM"]?.trim() || process.env["SMTP_USER"]?.trim() || null,
      },
    },
  };
}

/**
 * `a=1,b=2` → `{a:"1", b:"2"}`, plus whatever could not be read as a pair.
 *
 * Split on the FIRST `=` only, because a URL query string contains more of them
 * and splitting on all would truncate every feed at its first parameter. `&` is
 * untouched, so `?hl=en-IN&gl=IN` survives.
 *
 * `,` is the one character a value cannot contain. `?ids=1,2,3` splits into a
 * still-valid `?ids=1` plus two orphan segments — which is why the orphans are
 * RETURNED rather than skipped. They are the only evidence that truncation
 * happened: the surviving half parses as a URL and looks entirely healthy.
 * Percent-encode a literal comma as %2C.
 */
function parsePairs(raw: string | undefined): {
  pairs: Record<string, string>;
  dropped: string[];
} {
  const pairs: Record<string, string> = {};
  const dropped: string[] = [];
  if (!raw || raw.trim() === "") return { pairs, dropped };

  for (const segment of raw.split(",")) {
    if (segment.trim() === "") continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) {
      dropped.push(segment.trim());
      continue;
    }
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key !== "" && value !== "") pairs[key] = value;
    else dropped.push(segment.trim());
  }
  return { pairs, dropped };
}
