/**
 * `recall_mood` — how recent sessions have been going.
 *
 * Registered only where the memory worker is actually writing care signals.
 * Otherwise the model would carry a tool whose only possible answer is
 * "nothing recorded", which is a worse answer than not offering it.
 *
 * A LOCAL READ. No provider is called on any turn — the analysis already ran in
 * the worker. See ADR 0009.
 */

import { createRecallMood } from "../tools/wellbeing.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const wellbeingCapability: Capability = {
  name: "wellbeing",
  isConfigured: (cfg) => cfg.careSignals.enabled,
  register(registry): CapabilityReport {
    const spec = createRecallMood();
    registry.register(spec);
    return { name: "wellbeing", registered: true, tools: [spec.name], detail: {} };
  },
};
