/**
 * Turning what somebody said into a reading, or refusing to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE, AND IT IS THE HALF THAT DECIDES WHETHER THIS FEATURE IS SAFE. The model
 * hears "my sugar was one thirty this morning" and calls a tool with a number.
 * Everything between that number and the database is here: which metric it is,
 * what unit it is in, and whether a human body produces it at all.
 *
 * ⚠ IT NEVER DECIDES WHAT A READING MEANS. Nothing in this file says high, low,
 * normal, or worrying. That judgement lives in one place — the bands in the
 * safety service — and it produces an alert that the escalation ladder asks
 * about in reviewed copy. A second opinion here would be a device improvising
 * about somebody's health, which is the one thing this whole design is built to
 * prevent.
 *
 * THE RANGES BELOW ARE THEREFORE NOT THRESHOLDS. They are "no person has this"
 * bounds — a transposed digit, a thermometer in the wrong scale, a sensor fault
 * read aloud. Refusing those is not a health judgement; it is refusing to store
 * something that is not a reading. They mirror the ingest limits in
 * elderguard-backend/app/schemas/telemetry.py, deliberately, so a value that
 * would bounce off the API is refused here with a reason the device can SAY
 * instead of a round trip that ends in an apology.
 *
 * FAHRENHEIT IS ACCEPTED AND CONVERTED, and that is not a nicety. Household
 * thermometers in India are overwhelmingly Fahrenheit, so "ninety-eight point
 * six" is the single most likely temperature this product will ever hear — and
 * 98.6 as Celsius is out of range, so without this the commonest case would be
 * the one that fails.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type VitalKind = "heart_rate" | "spo2" | "temperature" | "blood_pressure" | "glucose";

/** When a sugar reading was taken. A closed set — see the copy note below. */
export type GlucoseContext = "fasting" | "after_meal" | "unspecified";

export type Reading = {
  kind: VitalKind;
  /** The number. Systolic, for a blood pressure. */
  value: number;
  /** Diastolic. Present only for a blood pressure. */
  second?: number;
  context?: GlucoseContext;
};

export const VITAL_KINDS: readonly VitalKind[] = [
  "heart_rate",
  "spo2",
  "temperature",
  "blood_pressure",
  "glucose",
];

/**
 * What each metric is called out loud, and the bounds outside which it is not
 * a person.
 *
 * `unit` is here so a tool result can carry it and the model renders "one
 * hundred and thirty milligrams per decilitre" rather than a bare number.
 */
export const VITALS: Record<
  VitalKind,
  { unit: string; min: number; max: number; secondMin?: number; secondMax?: number }
> = {
  heart_rate: { unit: "bpm", min: 20, max: 250 },
  spo2: { unit: "%", min: 50, max: 100 },
  temperature: { unit: "°C", min: 25, max: 45 },
  // Systolic first, diastolic second. Both bounds are wide enough to hold a
  // hypertensive crisis, because refusing to record one would be the worst
  // possible time to be fussy about input.
  blood_pressure: { unit: "mmHg", min: 50, max: 260, secondMin: 30, secondMax: 160 },
  glucose: { unit: "mg/dL", min: 20, max: 700 },
};

export type ParseFailure =
  "unknown_kind" | "not_a_number" | "implausible" | "needs_both_pressures" | "pressures_inverted";

export type ParseResult =
  { ok: true; reading: Reading } | { ok: false; reason: ParseFailure; kind?: VitalKind };

/**
 * The model's arguments into a reading.
 *
 * A DISCRIMINATED RESULT RATHER THAN A THROW, because none of these outcomes is
 * infrastructure failing. A person saying a number the device cannot use is an
 * ordinary conversational event, and the tool answers it with a sentence rather
 * than a `spoken_fallback_key` — see the header of src/tools/builtin.ts.
 */
export function parseReading(args: {
  kind?: unknown;
  value?: unknown;
  second?: unknown;
  unit?: unknown;
  context?: unknown;
}): ParseResult {
  const kind = String(args.kind ?? "").trim() as VitalKind;
  if (!VITAL_KINDS.includes(kind)) return { ok: false, reason: "unknown_kind" };

  const spec = VITALS[kind];
  let value = toNumber(args.value);
  if (value === null) return { ok: false, reason: "not_a_number", kind };

  if (
    kind === "temperature" &&
    String(args.unit ?? "")
      .trim()
      .toLowerCase() === "f"
  ) {
    value = fahrenheitToCelsius(value);
  }

  if (kind === "blood_pressure") {
    const second = toNumber(args.second);
    if (second === null) return { ok: false, reason: "needs_both_pressures", kind };
    // Said the wrong way round — "eighty over one forty" — which is a slip
    // anybody makes and is unambiguous, so it is worth naming rather than
    // silently swapping. Swapping would store a number nobody said.
    if (second >= value) return { ok: false, reason: "pressures_inverted", kind };
    if (!within(value, spec.min, spec.max)) return { ok: false, reason: "implausible", kind };
    if (!within(second, spec.secondMin ?? spec.min, spec.secondMax ?? spec.max)) {
      return { ok: false, reason: "implausible", kind };
    }
    return { ok: true, reading: { kind, value: round(value), second: round(second) } };
  }

  if (!within(value, spec.min, spec.max)) return { ok: false, reason: "implausible", kind };

  const reading: Reading = { kind, value: round(value) };
  if (kind === "glucose") reading.context = readContext(args.context);
  return { ok: true, reading };
}

/**
 * A reading, as the safety service's API wants it.
 *
 * Kept next to `parseReading` rather than in the client, because these two
 * halves are the same decision: the shape a metric takes on the wire is part of
 * what the metric IS, and splitting them across files is how a unit gets lost.
 */
export function toWirePayload(reading: Reading): Record<string, number | string> {
  switch (reading.kind) {
    case "heart_rate":
      return { heart_rate_bpm: reading.value };
    case "spo2":
      return { spo2_percent: reading.value };
    case "temperature":
      return { temperature_c: reading.value };
    case "glucose":
      return {
        glucose_mgdl: reading.value,
        glucose_context: reading.context ?? "unspecified",
      };
    case "blood_pressure":
      return { systolic_mmhg: reading.value, diastolic_mmhg: reading.second ?? 0 };
  }
}

/** One stored row, as the safety service returns it. */
export type StoredVital = {
  recorded_at: string;
  heart_rate_bpm: number | null;
  spo2_percent: number | null;
  temperature_c: number | null;
  systolic_mmhg: number | null;
  diastolic_mmhg: number | null;
  glucose_mgdl: number | null;
  source: string;
};

export type ReadingBack = {
  kind: VitalKind;
  value: number;
  second?: number;
  unit: string;
  at: string;
  /** How it got there: "self_reported", "device", "csv_upload". */
  source: string;
};

/**
 * A stored row into the readings it contains, newest-first order preserved.
 *
 * ONE ROW CAN BE SEVERAL READINGS — a band reports a pulse and an oxygen level
 * in the same frame — and the model asking "what was my blood pressure" wants
 * the pressure, not the row it happened to share space with. Expanding here
 * keeps the tool's filter honest.
 *
 * `source` travels with each one because "you told me" and "your band measured"
 * are not interchangeable sentences to say to somebody.
 */
export function expandStored(rows: readonly StoredVital[]): ReadingBack[] {
  const out: ReadingBack[] = [];
  for (const row of rows) {
    const at = row.recorded_at;
    const src = row.source;
    if (row.heart_rate_bpm !== null && row.heart_rate_bpm !== undefined) {
      out.push({ kind: "heart_rate", value: row.heart_rate_bpm, unit: "bpm", at, source: src });
    }
    if (row.spo2_percent !== null && row.spo2_percent !== undefined) {
      out.push({ kind: "spo2", value: row.spo2_percent, unit: "%", at, source: src });
    }
    if (row.temperature_c !== null && row.temperature_c !== undefined) {
      out.push({ kind: "temperature", value: row.temperature_c, unit: "°C", at, source: src });
    }
    if (
      row.systolic_mmhg !== null &&
      row.systolic_mmhg !== undefined &&
      row.diastolic_mmhg !== null &&
      row.diastolic_mmhg !== undefined
    ) {
      out.push({
        kind: "blood_pressure",
        value: row.systolic_mmhg,
        second: row.diastolic_mmhg,
        unit: "mmHg",
        at,
        source: src,
      });
    }
    if (row.glucose_mgdl !== null && row.glucose_mgdl !== undefined) {
      out.push({ kind: "glucose", value: row.glucose_mgdl, unit: "mg/dL", at, source: src });
    }
  }
  return out;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function readContext(value: unknown): GlucoseContext {
  const token = String(value ?? "").trim();
  return token === "fasting" || token === "after_meal" ? token : "unspecified";
}

function within(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** One decimal place. A pulse of 72.0000001 is a float artefact, not a reading. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function fahrenheitToCelsius(f: number): number {
  return ((f - 32) * 5) / 9;
}
