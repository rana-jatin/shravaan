/**
 * Vitals — two tools in front of somebody else's database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THINNEST CAPABILITY IN THE SET, AND THAT IS THE RESULT RATHER THAN THE
 * AMBITION. Every other elder-care feature here grew a store, a ladder and a
 * copy table; this one gets a base URL. `elderguard-backend/` already ingests
 * telemetry from three directions and checks it against its bands, so the work
 * was not to build vitals — it was to not build them twice.
 *
 * ⚠ WHAT IT DOES WITH A READING IS WRITE IT DOWN. The whole capability is
 * built to make judgement impossible from here: the tools return numbers and
 * units, the log line carries the metric and never the value, and nothing in
 * this file compares a reading to anything. The one place a vital sign is
 * judged is the safety service's bands, and the one thing that follows from a
 * judgement is a question asked in reviewed copy.
 *
 * BOTH HALVES OF THE CONFIG OR NEITHER. A base URL without a key reaches a
 * service that will answer 401 to everything, which would register two tools
 * that always fail — the exact "offers it and then withdraws it" failure
 * `isConfigured` exists to prevent.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { nodeFetch } from "@sp-i/shared/providers/http.ts";
import { isHttpUrl, redactUrl } from "../domain/url.ts";
import { ElderguardClient } from "../providers/elderguard.ts";
import {
  createLogVital,
  createRecentVitals,
  VITALS_CAPABILITY,
  type VitalsDeps,
} from "../tools/vitals.ts";
import { notRegistered, type Capability, type CapabilityReport } from "./types.ts";

export const vitalsCapability: Capability = {
  name: VITALS_CAPABILITY,

  isConfigured: (cfg) => cfg.vitals.apiBase !== null && cfg.vitals.apiKey !== null,

  register(registry, { cfg, log }): CapabilityReport {
    const apiBase = cfg.vitals.apiBase;
    const apiKey = cfg.vitals.apiKey;
    // `isConfigured` already said both are present; this is the narrowing, and
    // it is also the guard for a future caller that skips the check.
    if (!apiBase || !apiKey) return notRegistered(VITALS_CAPABILITY);

    // A URL somebody typed. Registering against `localhost:8000` — no scheme —
    // would produce two tools that throw on every call, and the boot log is
    // where that should be found rather than the first time somebody recites
    // their blood pressure.
    if (!isHttpUrl(apiBase)) {
      log("error", "vitals NOT registered — VITALS_API_BASE is not an http(s) URL", {
        given: apiBase,
        effect: "readings the user says out loud are heard and not kept",
      });
      return notRegistered(VITALS_CAPABILITY, { vitals: false });
    }

    const client = new ElderguardClient({
      apiBase,
      apiKey,
      fetch: nodeFetch(),
      timeoutMs: cfg.vitals.timeoutMs,
    });

    const deps: VitalsDeps = { sink: client, log };
    const specs = [createLogVital(deps), createRecentVitals(deps)];
    for (const spec of specs) registry.register(spec);

    log("info", "vitals ARMED", {
      // Host only. A base URL is configuration and generally safe to print,
      // but this one is pasted by hand next to a key, `http://user:pass@host`
      // is a thing people write, and boot logs get shipped.
      service: redactUrl(apiBase),
      stores: "nothing locally — the safety service owns every reading",
      // Said at boot because it is the promise the design rests on, and an
      // operator reading this line is the person who would notice it breaking.
      never: "the device does not say whether a reading is high, low or normal",
      residency: "our own service, wherever this deployment put it (docs/05 Q14)",
    });

    return {
      name: VITALS_CAPABILITY,
      registered: true,
      tools: specs.map((s) => s.name),
      detail: { vitals: "log+read" },
    };
  },
};
