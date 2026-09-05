/**
 * Word and number games.
 *
 * Unconditional, and the first capability with NOTHING to gate on. The
 * unconfigured-means-unregistered rule is about capabilities a deployment
 * cannot serve — no key, no feed, no upstream — and the question bank ships in
 * this repo, so there is no state in which registering these offers something
 * that will not work.
 *
 * What they do cost is three more schemas in every request. A flag with nothing
 * behind it would be a knob for a problem nobody has measured yet. See
 * tools/games.ts and docs/adr/0010-games-and-activities.md.
 */

import { GAME_TOOLS } from "../tools/games.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const gamesCapability: Capability = {
  name: "games",
  isConfigured: () => true,
  register(registry): CapabilityReport {
    for (const spec of GAME_TOOLS) registry.register(spec);
    return { name: "games", registered: true, tools: GAME_TOOLS.map((t) => t.name), detail: {} };
  },
};
