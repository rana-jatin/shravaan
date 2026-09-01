/**
 * The built-in tools — the ones that need nothing but the session.
 *
 * THE SPLIT IS LOAD-BEARING. Everything in this file needs no key, no URL and
 * no network, so server.ts registers the lot unconditionally and a fresh clone
 * has a working companion. The tools that cannot make that promise are
 * factories in files of their own — weather.ts, news.ts, wellbeing.ts,
 * calendar.ts, music.ts, emergency.ts — and tools/external.ts holds the rule
 * they share. This file used to hold the first three of those as well, which is
 * why it ran to 885 lines across three unrelated upstreams.
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
 * Deadlines here are short on purpose. The 8 s default in types.ts is sized for
 * a network call; every tool in this file is an in-process function, so a call
 * that has not returned in 250 ms is wedged, not slow. Their fillers are pinned
 * above the deadline so they can never fire: "one moment" before an instant
 * answer makes a fast companion feel slow. The external tools invert both — see
 * NETWORK_MS and NETWORK_FILLER_MS in tools/external.ts.
 */

import { SPEAKABLE } from "../domain/languages.ts";
import type { FactKind } from "../domain/types.ts";
import type { ToolSpec } from "./registry.ts";
import { INSTANT_MS, STORE_MS } from "./types.ts";

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
