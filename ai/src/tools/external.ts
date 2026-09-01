/**
 * What every tool that leaves the process shares.
 *
 * This was the divider halfway down tools/builtin.ts. It is a module now
 * because weather and news moved into files of their own and both still need
 * the same two numbers and the same residency argument — and that argument is
 * the kind that must not be paraphrased into two drifting copies.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXTERNAL TOOLS — the ones that leave the process.
 *
 * These are NOT in `BUILTIN_TOOLS`, and that is the whole point. Everything in
 * tools/builtin.ts needs nothing but the session, so server.ts can register it
 * blindly and it works on a laptop with no configuration. These need an
 * upstream, a URL, and a decision about where a user's request is allowed to
 * travel — so they are FACTORIES, and a deployment that has not configured one
 * never registers it.
 *
 * The alternative — shipping them in `BUILTIN_TOOLS` and returning
 * `upstream_error` when unconfigured — produces exactly the failure
 * registry.ts's entitlement note warns about: an agent that offers a capability
 * and then withdraws it. A tool the deployment cannot serve must never be
 * DESCRIBED to the user.
 *
 * ⚠ RESIDENCY. Every other hop in this product is Sarvam, in India, on purpose
 * (ADR 0003). These tools reach a third party, and Open-Meteo in particular is
 * EU-hosted — so a weather question sends a place name out of the country. That
 * is the same trade `asrFailoverEnabled` documents and defaults to off, for the
 * same reason, and it is why these are opt-in. What crosses the border here is a
 * city name and a topic, not the user's voice, which is a smaller exposure than
 * the ASR failover — but it is not zero, and it is not our call to make
 * silently. See docs/05-open-questions.md Q14.
 *
 * The same reasoning governs tools/calendar.ts, tools/music.ts and
 * tools/emergency.ts, which reach their own upstreams and carry their own
 * deadlines for the same reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A network round trip, not an in-process call. Sized for two hops. */
export const NETWORK_MS = 6000;

/**
 * Low enough that the progress line actually fires. `progress.weather` and
 * `progress.news` have existed in src/copy/fillers.ts since slice 6, written
 * ahead of these tools; this is the threshold that finally lets them be heard.
 */
export const NETWORK_FILLER_MS = 600;
