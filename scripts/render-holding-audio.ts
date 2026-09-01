/**
 * Render the pre-rendered apology audio. Build-time tool, not part of the server.
 *
 *   npm run render:holding
 *
 * WHY THIS SCRIPT EXISTS AT ALL: Bulbul is the only voice in this system and
 * there is no Indic TTS failover anywhere in either provider
 * ([ADR 0005](../docs/adr/0005-tts-provider-split.md)). When it goes, the bot has
 * nothing to say and no way to say it — the same silent failure the speakability
 * gate was built to prevent, arriving from a different direction. So the one
 * message that matters is synthesised ahead of time and shipped as bytes.
 *
 * THE OBVIOUS TRAP, STATED PLAINLY: **you cannot run this during the outage it
 * exists for.** It needs a working Bulbul and a live key. Generate it now, commit
 * the output, and regenerate whenever TTS_SPEAKER or the copy changes — otherwise
 * the outage apology arrives in a different voice from the rest of the
 * conversation, which is its own small horror.
 *
 * OUTPUT: headerless linear16 PCM, mono, at TTS_SAMPLE_RATE — byte-identical to
 * what Bulbul streams, so the device playback path needs no special case.
 *
 * ⚠ UNVERIFIED, same caveat as src/providers/*: the REST path and auth header
 * below come from Sarvam's guide pages. The API-reference pages that would
 * confirm them returned 404 during research (docs/05-open-questions.md Q12).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/env.ts";
import { COPY } from "../src/copy/refusals.ts";
import { SPEAKABLE } from "../src/domain/languages.ts";
import { REQUIRED_CLIPS } from "../src/audio/holding-audio.ts";

const cfg = loadConfig();

async function renderOne(text: string, language: string): Promise<Buffer> {
  const res = await fetch(new URL("/text-to-speech", cfg.sarvam.apiBase), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": cfg.sarvam.apiKey,
    },
    body: JSON.stringify({
      text,
      target_language_code: language,
      speaker: cfg.audio.ttsSpeaker,
      model: cfg.sarvam.ttsModel,
      pace: cfg.audio.ttsPace,
      speech_sample_rate: cfg.audio.ttsSampleRate,
    }),
  });

  if (!res.ok) {
    throw new Error(`${language}: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const body = (await res.json()) as { audios?: string[] };
  const b64 = body.audios?.[0];
  if (!b64) throw new Error(`${language}: response contained no audio`);
  return stripWavHeader(Buffer.from(b64, "base64"));
}

/**
 * Sarvam's REST endpoint returns WAV; the streaming socket returns raw frames.
 * We want the raw frames so the two paths are interchangeable at the device.
 *
 * Parses the chunk table rather than assuming a 44-byte header — a `LIST` or
 * `fact` chunk before `data` is legal and would otherwise be played as audio,
 * which sounds exactly like a click of static at the start of every apology.
 */
function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV response had no data chunk");
}

async function main(): Promise<void> {
  const dir = cfg.holdingAudioDir;
  mkdirSync(dir, { recursive: true });

  let ok = 0;
  const failures: string[] = [];

  for (const key of REQUIRED_CLIPS) {
    const table = COPY[key];
    for (const lang of SPEAKABLE) {
      const entry = table[lang.code];
      if (!entry) {
        failures.push(`${key}.${lang.code}: no copy`);
        continue;
      }
      if (entry.needsNativeReview) {
        // Rendering placeholder copy produces a file that LOOKS complete and
        // ships machine-quality text as the last thing a user ever hears. Refuse.
        failures.push(`${key}.${lang.code}: copy still needs native review`);
        continue;
      }
      try {
        const pcm = await renderOne(entry.text, lang.code);
        writeFileSync(join(dir, `${key}.${lang.code}.pcm`), pcm);
        process.stdout.write(`  rendered ${key}.${lang.code}  (${pcm.length} bytes)\n`);
        ok += 1;
      } catch (err) {
        failures.push(`${key}.${lang.code}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        sample_rate: cfg.audio.ttsSampleRate,
        encoding: "linear16",
        speaker: cfg.audio.ttsSpeaker,
        rendered_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(`\n${ok} clip(s) written to ${dir}\n`);
  if (failures.length > 0) {
    process.stdout.write(
      `\n${failures.length} not rendered — those languages will fall back down the\n` +
        `refusal ladder to Hindi or English during a Bulbul outage:\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        `\n`,
    );
  }
}

await main();
