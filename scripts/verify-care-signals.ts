/**
 * Does Deepgram's `/v1/read` behave the way src/providers/deepgram-read.ts says?
 *
 * EVERY FIELD NAME IN THAT CLIENT IS RECONSTRUCTED FROM DOCUMENTATION. That is
 * the exact situation README's table describes, where five guesses about Sarvam
 * were wrong and two of them failed SILENTLY — the socket stayed open, healthy
 * looking, and produced nothing. A wrong field here fails the same way: a 200
 * with a shape we do not read, mapped to `null`, logged as "no signals", and
 * indistinguishable from a quiet week. Forever, and nobody notices.
 *
 * So this script exists to be run once against a live key before anybody trusts
 * a trend line:
 *
 *   npm run verify:care            # all probes
 *   npm run verify:care -- --raw   # plus the full response bodies
 *
 * Each probe answers one question that changes what we build:
 *   1  does the endpoint exist at /v1/read, and is `Authorization: Token` right?
 *   2  is the sentiment shape `results.sentiments.{segments,average}`?
 *   3  is the intent shape `results.intents.segments[].intents[]`, and does
 *      `custom_intent_mode=strict` really return ONLY our watch-list?
 *   4  what actually happens on a non-English input — 400, or a confident
 *      wrong answer? (This one decides how much the language gate is carrying.)
 *
 * It calls DeepgramRead itself, unlike verify:tools — the client is thin enough
 * that going around it would test a different thing than the one we ship.
 */

import { loadConfig } from "../src/config/env.ts";
import { DeepgramRead, DeepgramReadError } from "../src/providers/deepgram-read.ts";
import { CARE_INTENTS, toCareSignals } from "../src/domain/care-signals.ts";

const RAW = process.argv.includes("--raw");
const cfg = loadConfig();
const read = new DeepgramRead(cfg);

/**
 * Long enough to clear Deepgram's 50-word floor, and written to trip three of
 * the watch-list intents on purpose — sleeping, pain, loneliness — so probe 3
 * has something to find. Invented; not a real person's words.
 */
const SAMPLE = [
  "I have not been sleeping very well this last week, not since the weather turned.",
  "My knee has been aching again in the mornings, worse than it was in the winter.",
  "The house is very quiet now that the children have gone back to their own homes.",
  "I did go out to the market on Tuesday and bought some good tomatoes, which was nice.",
  "But mostly I have been sitting indoors and the days feel quite long to me.",
  "I keep meaning to ring my sister but I never seem to get round to it.",
].join(" ");

const HINDI_SAMPLE = [
  "मुझे इस हफ्ते ठीक से नींद नहीं आई, जब से मौसम बदला है।",
  "सुबह मेरे घुटने में फिर दर्द हो रहा है, सर्दियों से भी ज़्यादा।",
  "बच्चों के अपने घर लौट जाने के बाद घर बहुत सूना लगता है।",
  "मंगलवार को मैं बाज़ार गया था और अच्छे टमाटर लाया, वह अच्छा लगा।",
  "लेकिन ज़्यादातर मैं घर में ही बैठा रहता हूँ और दिन बहुत लंबे लगते हैं।",
  "बहन को फोन करने का मन करता है पर कभी हो नहीं पाता।",
].join(" ");

function show(label: string, value: unknown): void {
  console.log(`   ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function probe(n: number, question: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n-- ${n}  ${question}`);
  try {
    await fn();
  } catch (err) {
    if (err instanceof DeepgramReadError) {
      console.log(`   ✖ HTTP ${err.status} — ${err.message}`);
    } else {
      console.log(`   ✖ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  if (!cfg.deepgramApiKey) {
    console.error("DEEPGRAM_API_KEY is unset. Nothing to verify.");
    process.exitCode = 1;
    return;
  }
  console.log(`Deepgram /v1/read at ${cfg.deepgramReadBase}`);

  await probe(1, "endpoint and auth", async () => {
    const body = await read.analyse({ text: SAMPLE, sentiment: true });
    const meta = (body as { metadata?: Record<string, unknown> }).metadata;
    console.log("   ✔ 200");
    show("request_id", meta?.["request_id"]);
    show("language", meta?.["language"]);
    if (RAW) console.dir(body, { depth: null });
  });

  await probe(2, "sentiment shape — results.sentiments.{segments,average}", async () => {
    const body = await read.analyse({ text: SAMPLE, sentiment: true });
    const signals = toCareSignals(body, {
      intentConfidence: 0,
      analysedAt: new Date().toISOString(),
    });
    if (!signals?.sentiment) {
      console.log("   ✖ MAPPED TO NOTHING — the documented path did not resolve.");
      console.log("     This is the silent failure. Inspect with --raw before shipping.");
      if (!RAW) console.dir(body, { depth: null });
      return;
    }
    console.log("   ✔ mapped");
    show("average", signals.sentiment);
    show("segments", signals.sentiment_segments?.length ?? 0);
  });

  await probe(3, "intents, and whether strict mode really means only ours", async () => {
    const body = await read.analyse({
      text: SAMPLE,
      intents: true,
      customIntents: [...CARE_INTENTS],
      customIntentMode: "strict",
    });
    const signals = toCareSignals(body, {
      intentConfidence: 0,
      analysedAt: new Date().toISOString(),
    });
    const found = signals?.flagged_intents ?? [];

    console.log(found.length > 0 ? "   ✔ intents returned" : "   ✖ no intents in the response");
    for (const f of found) show(f.intent, f.confidence);

    // The claim under test: strict returns ONLY submitted intents. If anything
    // outside CARE_INTENTS comes back, the watch-list is not a watch-list and a
    // caregiver could be shown a category nobody reviewed.
    const stray = found.filter((f) => !CARE_INTENTS.includes(f.intent));
    if (stray.length > 0) {
      console.log(`   ⚠ STRICT MODE LEAKED ${stray.length} unreviewed intent(s):`);
      for (const s of stray) show("stray", s.intent);
    }
    if (RAW) console.dir(body, { depth: null });
  });

  await probe(
    4,
    "what a Hindi transcript actually does — 400, or a confident wrong answer?",
    async () => {
      const body = await read.analyse({ text: HINDI_SAMPLE, sentiment: true, intents: true });
      const signals = toCareSignals(body, {
        intentConfidence: 0,
        analysedAt: new Date().toISOString(),
      });

      // A 400 here would be the kind answer and lands in the catch above. Reaching
      // this line means it returned something — which is exactly why the language
      // gate in care-signals.ts refuses BEFORE the call rather than trusting them
      // to refuse for us.
      console.log("   ⚠ accepted a non-English input rather than rejecting it");
      show("mapped", signals ?? "nothing");
      if (RAW) console.dir(body, { depth: null });
    },
  );

  console.log("\nDone. Anything marked ✖ or ⚠ contradicts a claim in the source comments.");
}

void main();
