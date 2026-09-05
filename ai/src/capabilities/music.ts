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
import { RadioCatalogue } from "../providers/radio-catalogue.ts";
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

    /**
     * Cancels a refresh that is still running at shutdown.
     *
     * ⚠ A PASS IS ELEVEN SEQUENTIAL QUERIES against a volunteer directory
     * measured at ~1.7 s each, so one can be most of twenty seconds long. The
     * interval was already unref'd, but an in-flight `fetch` is not: clearing
     * the timer left up to eleven more requests to make and a process that
     * would not exit until they had. `npm run dev`, Ctrl-C, and a twenty-second
     * wait was the visible version of that.
     *
     * Owned by this closure, like the timer, because a Capability is a
     * module-level singleton and two servers in one process must not share one
     * controller — the first to shut down would abort the second's refresh.
     */
    const stopping = new AbortController();

    // Boot does not WAIT for it. The directory is a volunteer server and may be
    // slow or down; a companion that will not start because radio is unreachable
    // has its priorities backwards. The tool reports no stations until it fills.
    void catalogue.refresh(stopping.signal).catch((err: unknown) => {
      log("error", "initial radio refresh failed — music starts with no stations", {
        err: err instanceof Error ? err.message : String(err),
      });
    });

    const everyMs = Math.max(1, cfg.music.refreshMinutes) * 60_000;
    const refreshTimer = setInterval(() => {
      void catalogue.refresh(stopping.signal).catch(() => {});
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
      dispose: () => {
        clearInterval(refreshTimer);
        // The timer stops new passes; this ends the one already running. Both,
        // because either alone leaves a way for the process to stay busy after
        // it has been told to stop.
        stopping.abort();
      },
    };
  },
};
