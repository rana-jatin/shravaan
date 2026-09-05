/**
 * `get_weather` — Open-Meteo.
 *
 * ⚠ THE ONE HOP THAT LEAVES INDIA on the default path. Every other provider is
 * Sarvam, in-country, on purpose (ADR 0003); Open-Meteo is EU-hosted, so a
 * weather question sends a place name abroad. What crosses is a city name, not
 * the user's voice — smaller than the ASR failover, but not zero, and not ours
 * to decide silently. That is why it is opt-in. See docs/05-open-questions.md
 * Q14 and tools/external.ts.
 */

import { createGetWeather } from "../tools/weather.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const weatherCapability: Capability = {
  name: "weather",
  isConfigured: (cfg) => cfg.weather.enabled,
  register(registry, { cfg }): CapabilityReport {
    const spec = createGetWeather({
      apiBase: cfg.weather.apiBase,
      geocodeBase: cfg.weather.geocodeBase,
      defaultPlace: cfg.weather.defaultPlace,
      countryBias: cfg.weather.countryBias,
      pincodeApiBase: cfg.weather.pincodeApiBase,
    });
    registry.register(spec);
    return { name: "weather", registered: true, tools: [spec.name], detail: { weather: true } };
  },
};
