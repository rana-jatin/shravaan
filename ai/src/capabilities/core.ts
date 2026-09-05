/**
 * The tools that need nothing but the session.
 *
 * Always registered, on every deployment, because they need no key, no URL and
 * no network — a fresh clone has a working companion. See tools/builtin.ts for
 * why that split is load-bearing.
 */

import { BUILTIN_TOOLS } from "../tools/builtin.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const coreCapability: Capability = {
  name: "core",
  isConfigured: () => true,
  register(registry): CapabilityReport {
    for (const spec of BUILTIN_TOOLS) registry.register(spec);
    return {
      name: "core",
      registered: true,
      tools: BUILTIN_TOOLS.map((t) => t.name),
      detail: {},
    };
  },
};
