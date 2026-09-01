/**
 * The language matrix and the pure speakability verdict.
 *
 * This is the single source of truth for what the product can speak. Nothing
 * else may hardcode a language list — three copies will drift, and the drift is
 * discovered by a user hearing silence.
 *
 * Spec: docs/06-speakability-gate.md
 */

import matrix from "@sp-i/shared/config/languages.json" with { type: "json" };
import type { LanguageCode, SpeakabilityVerdict } from "@sp-i/shared/domain/types.ts";

export type LanguageEntry = { code: LanguageCode; name: string; endonym?: string };

export const SPEAKABLE: readonly LanguageEntry[] = matrix.speakable;
export const HEARD_NOT_SPEAKABLE: readonly LanguageEntry[] = matrix.heard_not_speakable;
export const REFUSAL_LADDER: readonly LanguageCode[] = matrix.refusal_ladder;
export const MIN_REFUSAL_CONFIDENCE = matrix.thresholds.min_refusal_confidence;
export const SWITCH_CONFIRM_TURNS = matrix.thresholds.switch_confirm_turns;

const SPEAKABLE_CODES = new Set(SPEAKABLE.map((l) => l.code));
const HEARD_CODES = new Set(HEARD_NOT_SPEAKABLE.map((l) => l.code));

/**
 * Normalise a BCP-47-ish tag to the form used in the matrix.
 *
 * Sarvam returns region-qualified tags ("hi-IN"), but a detector may emit a bare
 * primary subtag ("hi") or odd casing. We resolve a bare tag to its Indian
 * variant only if that variant is one we know about — we never invent a region.
 */
export function normalizeLanguage(raw: string | null | undefined): LanguageCode | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parts = trimmed.split(/[-_]/);
  const primary = parts[0]?.toLowerCase();
  if (!primary) return null;

  const region = parts[1]?.toUpperCase();
  if (region) {
    const candidate = `${primary}-${region}`;
    if (SPEAKABLE_CODES.has(candidate) || HEARD_CODES.has(candidate)) return candidate;
    // Known primary with an unexpected region (e.g. "en-US"): fall through to
    // the bare-tag resolution below rather than rejecting outright.
  }

  const indian = `${primary}-IN`;
  if (SPEAKABLE_CODES.has(indian) || HEARD_CODES.has(indian)) return indian;

  return region ? `${primary}-${region}` : primary;
}

export function isSpeakable(code: string | null | undefined): boolean {
  const norm = normalizeLanguage(code);
  return norm !== null && SPEAKABLE_CODES.has(norm);
}

/**
 * The core verdict. Pure: a code and an optional confidence in, a verdict out.
 *
 * The asymmetry here is deliberate and is the most important property of this
 * function: we only ever return `heard_not_speakable` (which leads to a refusal)
 * when we are CONFIDENT. Anything doubtful becomes `uncertain`, which leads to a
 * fallback or a reprompt — never a refusal. Bouncing a Hinglish speaker is a far
 * worse failure than mis-labelling one turn.
 */
export function speakabilityOf(
  rawCode: string | null | undefined,
  confidence?: number,
): SpeakabilityVerdict {
  const code = normalizeLanguage(rawCode);

  if (code === null) {
    return confidence === undefined
      ? { status: "uncertain", code: null }
      : { status: "uncertain", code: null, confidence };
  }

  if (SPEAKABLE_CODES.has(code)) {
    // A speakable language is accepted regardless of confidence. A low-confidence
    // read of a language we can speak costs nothing; refusing it costs a user.
    return { status: "speakable", code };
  }

  const belowThreshold = confidence !== undefined && confidence < MIN_REFUSAL_CONFIDENCE;
  if (belowThreshold) {
    return { status: "uncertain", code, confidence };
  }

  if (HEARD_CODES.has(code)) {
    return confidence === undefined
      ? { status: "heard_not_speakable", code }
      : { status: "heard_not_speakable", code, confidence };
  }

  return { status: "out_of_scope", code };
}

/**
 * Pick the language a refusal or acknowledgement is SPOKEN in.
 *
 * Never returns an unspeakable code. Order: profile preference, then the
 * session's previous language, then the configured ladder.
 *
 * On Hindi as the refusal language for Urdu speakers: spoken Hindi and Urdu are
 * broadly mutually intelligible, so a Hindi refusal will very likely be
 * understood. That justifies it for a one-time refusal. It is NOT licence to
 * conduct the conversation in Hindi — see docs/adr/0005.
 */
export function resolveRespondIn(opts: {
  preferred?: LanguageCode | undefined;
  previous?: LanguageCode | undefined;
}): LanguageCode {
  const candidates = [opts.preferred, opts.previous, ...REFUSAL_LADDER];
  for (const c of candidates) {
    if (c && isSpeakable(c)) return normalizeLanguage(c)!;
  }
  // The ladder is validated at load (see assertMatrixIntegrity), so this is
  // unreachable in practice. Kept total rather than throwing at a refusal.
  return "en-IN";
}

/**
 * Fail fast at boot if the matrix is malformed. A silent typo here becomes a
 * user hearing nothing, which is the one failure this whole subsystem exists to
 * prevent — so we would rather not start.
 */
export function assertMatrixIntegrity(): void {
  if (SPEAKABLE.length === 0) throw new Error("languages.json: speakable set is empty");

  const overlap = SPEAKABLE.filter((l) => HEARD_CODES.has(l.code));
  if (overlap.length > 0) {
    throw new Error(
      `languages.json: codes in both speakable and heard_not_speakable: ${overlap
        .map((l) => l.code)
        .join(", ")}`,
    );
  }

  const badLadder = REFUSAL_LADDER.filter((c) => !SPEAKABLE_CODES.has(c));
  if (badLadder.length > 0) {
    throw new Error(
      `languages.json: refusal_ladder contains unspeakable codes: ${badLadder.join(", ")}. ` +
        `A refusal spoken in a language we cannot speak is silence.`,
    );
  }

  if (MIN_REFUSAL_CONFIDENCE < 0 || MIN_REFUSAL_CONFIDENCE > 1) {
    throw new Error("languages.json: min_refusal_confidence must be within 0..1");
  }
  if (!Number.isInteger(SWITCH_CONFIRM_TURNS) || SWITCH_CONFIRM_TURNS < 1) {
    throw new Error("languages.json: switch_confirm_turns must be a positive integer");
  }
}
