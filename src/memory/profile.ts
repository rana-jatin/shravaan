/**
 * Builds the distilled profile that gets warmed into Redis at session open.
 *
 * This is the ONLY long-term memory on the turn path. It sits in every prompt,
 * so its size is charged against both the latency budget and the token bill on
 * every single turn. The caps in docs/02-data-contracts.md are a design decision,
 * not a formality: growth here is silent and compounding, and an uncapped profile
 * is how a companion slowly becomes slow and expensive.
 */

import type { Episode, Fact, Profile } from "../domain/types.ts";
import type { LongTermStore } from "./long-term-store.ts";

export const PROFILE_CAPS = {
  facts: 30,
  episodes: 10,
  openThreads: 5,
} as const;

/**
 * Salience decays without reinforcement, so a fact mentioned once six months ago
 * ranks below one that keeps coming up. Half-life is deliberately long — a
 * companion forgetting your sister's name after a quiet fortnight would be worse
 * than carrying a slightly stale fact.
 */
const SALIENCE_HALF_LIFE_DAYS = 90;

export function decayedSalience(fact: Fact, now: Date): number {
  const days = (now.getTime() - Date.parse(fact.last_reinforced)) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return fact.salience;
  return fact.salience * Math.pow(0.5, days / SALIENCE_HALF_LIFE_DAYS);
}

export async function buildProfile(
  uid: string,
  store: LongTermStore,
  opts: { preferredLanguage: string; now?: Date } ,
): Promise<Profile> {
  const now = opts.now ?? new Date();

  const [facts, episodes] = await Promise.all([
    store.listFacts(uid, PROFILE_CAPS.facts * 3),
    store.listEpisodes(uid, PROFILE_CAPS.episodes),
  ]);

  const ranked = facts
    .map((f) => ({ f, s: decayedSalience(f, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, PROFILE_CAPS.facts);

  return {
    uid,
    distilled_at: now.toISOString(),
    preferred_language: opts.preferredLanguage,
    facts: ranked.map(({ f, s }) => ({ id: f.id, text: f.text, salience: round2(s) })),
    recent_episodes: episodes.map((e) => ({ id: e.id, summary: e.summary, at: e.ended_at })),
    open_threads: collectOpenThreads(episodes),
  };
}

/**
 * Newest threads win, and a thread mentioned in a later episode replaces its
 * earlier form rather than appearing twice.
 */
function collectOpenThreads(episodes: Episode[]): Profile["open_threads"] {
  const seen = new Set<string>();
  const out: Profile["open_threads"] = [];

  for (const ep of episodes) {
    for (const t of ep.open_threads) {
      const norm = t.text.trim().toLowerCase();
      if (norm === "" || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ id: t.id, text: t.text, last_touched: ep.ended_at });
      if (out.length >= PROFILE_CAPS.openThreads) return out;
    }
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
