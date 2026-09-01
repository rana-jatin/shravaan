/**
 * Is the Deepgram ASR standby actually there?
 *
 * The standby's whole job is to work on the worst day this system has — the one
 * where Sarvam ASR is down and nobody has time to debug a key. A standby that
 * has never been dialled is not a standby, it is a comment in an ADR.
 *
 *   npm run verify:asr              # en-IN
 *   npm run verify:asr -- --hi      # hi-IN, the case Flux barely covers
 *
 * Four probes, cheapest first, so a dead key costs no audio:
 *   0  is the key valid at all? (REST /v1/auth/token — free, no model runs)
 *   1  does the Flux socket open, and is `Authorization: Token` the right scheme?
 *      That header is the ONE unverified line in src/providers/deepgram-asr.ts.
 *   2  does real speech come back as words? Streamed through the shipped client,
 *      not around it, so a wrong frame name fails here rather than in production.
 *   3  is `word.confidence` really present? The low-confidence reprompt
 *      (docs/05-open-questions.md Q4) is implementable on this path and no other,
 *      so its absence would quietly delete a planned feature.
 *
 * THE AUDIO IS THE PRE-RENDERED HOLDING CLIP, which is the only real speech this
 * repo owns. It is Bulbul saying the voice-unavailable line, at 24 kHz — a rate
 * Flux accepts natively, so nothing is resampled and nothing is faked. If
 * assets/holding is still empty, run `npm run render:holding` first.
 */

import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "@sp-i/shared/config/env.ts";
import { DeepgramAsr } from "../src/providers/deepgram-asr.ts";
import type { AsrTranscript } from "../src/providers/asr-client.ts";

const HINDI = process.argv.includes("--hi");
const LANG = HINDI ? "hi-IN" : "en-IN";
const CLIP = `assets/holding/degraded.voice_unavailable.${LANG}.pcm`;
const MANIFEST = "assets/holding/manifest.json";

/** Nothing here may hang. A standby check that blocks forever is worse than one that fails. */
const OPEN_TIMEOUT_MS = 10_000;
const SETTLE_MS = 4_000;

const cfg = loadConfig();

function show(label: string, value: unknown): void {
  console.log(`   ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  if (!cfg.deepgram.apiKey) {
    console.error("DEEPGRAM_API_KEY is unset. Nothing to verify.");
    process.exitCode = 1;
    return;
  }

  // ── 0 ─────────────────────────────────────────────────────────────────────
  console.log(`\n-- 0  is the key valid? (REST, before we spend any audio)`);
  const auth = await fetch("https://api.deepgram.com/v1/auth/token", {
    headers: { Authorization: `Token ${cfg.deepgram.apiKey}` },
  });
  if (!auth.ok) {
    console.log(`   ✖ HTTP ${auth.status} — ${(await auth.text()).slice(0, 200)}`);
    console.log("     The key is rejected. Every probe below would fail for this one reason.");
    process.exitCode = 1;
    return;
  }
  const who = (await auth.json()) as Record<string, unknown>;
  console.log("   ✔ 200");
  show("scopes", who["scopes"]);

  // The clip has to exist before we claim anything about recognition.
  let pcm: Buffer;
  let rate: number;
  try {
    pcm = await readFile(CLIP);
    const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as { sample_rate?: number };
    rate = manifest.sample_rate ?? cfg.audio.asrSampleRate;
  } catch {
    console.log(`\n   ✖ ${CLIP} is missing. Run \`npm run render:holding\` first —`);
    console.log("     probes 1–3 need real speech and this repo has no other.");
    process.exitCode = 1;
    return;
  }

  // The shipped client takes its sample rate from config. The clip is at the TTS
  // rate, not the ASR one, and Flux accepts both — so we hand it the clip's rate
  // rather than resampling and testing audio we do not actually send in anger.
  const asr = new DeepgramAsr(
    { ...cfg, audio: { ...cfg.audio, asrSampleRate: rate } },
    {
      languageHint: LANG.split("-")[0]!,
    },
  );

  const partials: AsrTranscript[] = [];
  const finals: AsrTranscript[] = [];
  const errors: Error[] = [];
  let opened = false;
  let closeInfo: { code: number; reason: string } | null = null;

  asr.on("open", () => {
    opened = true;
  });
  asr.on("partial", (t) => partials.push(t));
  asr.on("final", (t) => finals.push(t));
  asr.on("error", (e) => errors.push(e));
  asr.on("close", (c) => {
    closeInfo = c;
  });

  // ── 1 ─────────────────────────────────────────────────────────────────────
  console.log(
    `\n-- 1  does the Flux socket open? (${cfg.deepgram.wsBase}/v2/listen, ${cfg.deepgram.asrModel})`,
  );
  asr.connect();
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (!opened && errors.length === 0 && closeInfo === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (!opened) {
    console.log(`   ✖ never opened`);
    for (const e of errors) show("error", e.message);
    if (closeInfo) show("close", closeInfo);
    console.log("     A 401 here means `Authorization: Token` is wrong — the one line in");
    console.log("     deepgram-asr.ts that was never sourced. A 400 means the model name is.");
    asr.close();
    process.exitCode = 1;
    return;
  }
  console.log("   ✔ open — auth scheme and model name both accepted");

  // ── 2 ─────────────────────────────────────────────────────────────────────
  console.log(
    `\n-- 2  does real speech come back as words? (${LANG}, ${(pcm.length / 2 / rate).toFixed(1)}s at ${rate} Hz)`,
  );
  // Paced in 20 ms frames. Flux's end-of-turn detection is timing-dependent;
  // dumping the whole buffer at once tests a stream shape we never produce.
  const frame = Math.floor((rate * 2 * 20) / 1000);
  for (let i = 0; i < pcm.length; i += frame) {
    asr.sendAudio(pcm.subarray(i, i + frame));
    await sleep(20);
  }
  asr.flush();
  await sleep(SETTLE_MS);

  if (finals.length === 0 && partials.length === 0) {
    console.log("   ✖ SILENCE — the socket stayed open and produced nothing.");
    console.log("     This is the failure mode README warns about: healthy looking, useless.");
    console.log("     Suspect the frame names in #onMessage, or the encoding/rate pair.");
  } else {
    console.log(`   ✔ ${partials.length} partial(s), ${finals.length} final(s)`);
    for (const t of finals) show("final", t.text);
    if (finals.length === 0) show("last partial", partials[partials.length - 1]?.text);
  }
  for (const e of errors) show("⚠ error", e.message);

  // ── 3 ─────────────────────────────────────────────────────────────────────
  console.log(`\n-- 3  is word.confidence present? (the field Sarvam does not have)`);
  const scored = [...finals, ...partials].find((t) => t.confidence !== undefined);
  if (scored) {
    console.log("   ✔ present");
    show("confidence", scored.confidence);
    show("language", scored.language ?? "(not reported)");
  } else {
    console.log("   ✖ ABSENT on every frame — the low-confidence reprompt in Q4 has no input.");
    console.log(
      "     Either Flux stopped sending `words[].confidence`, or toTranscript reads it wrong.",
    );
  }

  asr.close();
  await sleep(250);
  if (closeInfo) show("closed", closeInfo);
  console.log("\nDone. Anything marked ✖ or ⚠ contradicts a claim in the source comments.");
}

void main();
