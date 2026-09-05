/**
 * `play_music` — radio, and songs where a YouTube key is set.
 *
 * THE ONLY CAPABILITY THAT OWNS A TIMER. The station directory is filled ONCE
 * at boot and then on an interval — never inside a turn, where a 4.4 s
 * directory query would blow every deadline in the system. That interval used
 * to be created inside the shared registration function with no way to stop it;
 * it lives in this closure now, and the `dispose` on the report clears it.
 */

import { createPlayMusic } from "../tools/music.ts";
import { RadioCatalogue } from "../domain/radio-catalogue.ts";
import { SPEAKABLE } from "../domain/languages.ts";
import { pendingStopReview } from "../copy/stop-intent.ts";
import type { Capability, CapabilityReport } from "./types.ts";

export const musicCapability: Capability = {
  name: "music",
  isConfigured: (cfg) => cfg.music.enabled,

  register(registry, { cfg, log }): CapabilityReport {
    const catalogue = new RadioCatalogue({
      apiBase: cfg.music.radioApi,
      languages: SPEAKABLE.map((l) => l.code),
      fallbackLanguage: cfg.music.fallbackLanguage,
      perLanguage: cfg.music.stationsPerLanguage,
      secureOnly: cfg.music.secureOnly,
      log,
    });

    // Boot does not WAIT for it. The directory is a volunteer server and may be
    // slow or down; a companion that will not start because radio is unreachable
    // has its priorities backwards. The tool reports no stations until it fills.
    void catalogue.refresh().catch((err: unknown) => {
      log("error", "initial radio refresh failed — music starts with no stations", {
        err: err instanceof Error ? err.message : String(err),
      });
    });

    const everyMs = Math.max(1, cfg.music.refreshMinutes) * 60_000;
    const refreshTimer = setInterval(() => {
      void catalogue.refresh().catch(() => {});
    }, everyMs);
    refreshTimer.unref?.();

    // Stop phrases are the one copy table where a bad translation means the
    // music DOES NOT STOP. Louder than the other review warnings for that reason.
    const pending = pendingStopReview();
    if (pending.length > 0) {
      log("warn", "stop-the-music phrases are unreviewed — music may not stop in these", {
        languages: pending,
        note: "src/copy/stop-intent.ts — a native speaker must confirm before shipping",
      });
    }

    const spec = createPlayMusic({
      catalogue,
      youtubeApiKey: cfg.music.youtubeApiKey,
      youtubeApiBase: cfg.music.youtubeApiBase,
    });
    registry.register(spec);

    return {
      name: "music",
      registered: true,
      tools: [spec.name],
      detail: { music: cfg.music.youtubeApiKey ? "radio+song" : "radio only" },
      dispose: () => clearInterval(refreshTimer),
    };
  },
};
