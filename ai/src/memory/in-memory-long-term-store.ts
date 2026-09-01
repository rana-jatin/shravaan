/**
 * In-memory LongTermStore.
 *
 * The reference implementation for the supersede / soft-delete semantics. A
 * Postgres+pgvector implementation should be checked against the same contract
 * suite once ADR 0004 is settled and a real Postgres is reachable.
 */

import { randomUUID } from "node:crypto";
import type { Episode, Fact } from "@sp-i/shared/domain/types.ts";
import {
  cosine,
  type Embedder,
  type FactDraft,
  type LongTermStore,
  type SearchHit,
} from "./long-term-store.ts";

const isLive = (f: Fact): boolean => f.deleted_at === null && f.superseded_by === null;

export class InMemoryLongTermStore implements LongTermStore {
  readonly #facts = new Map<string, Fact>();
  readonly #episodes: Episode[] = [];
  readonly #embedder: Embedder;
  readonly #now: () => Date;

  constructor(embedder: Embedder, now: () => Date = () => new Date()) {
    this.#embedder = embedder;
    this.#now = now;
  }

  async putFact(draft: FactDraft): Promise<Fact> {
    const at = this.#now().toISOString();
    const fact: Fact = {
      id: randomUUID(),
      uid: draft.uid,
      text: draft.text,
      embedding: await this.#embedder.embed(draft.text),
      kind: draft.kind,
      salience: draft.salience,
      confidence: draft.confidence,
      first_seen: at,
      last_reinforced: at,
      supersedes: draft.supersedes ?? null,
      superseded_by: null,
      deleted_at: null,
      deleted_reason: null,
      source_event_id: draft.source_event_id,
      source_sid: draft.source_sid,
    };

    // The supersede chain. The old fact is retired, not removed: the agent must
    // stop asserting it, but the history is what lets it say "you mentioned
    // you'd moved".
    if (draft.supersedes) {
      const old = this.#facts.get(draft.supersedes);
      if (old) {
        old.superseded_by = fact.id;
        old.deleted_at = at;
        old.deleted_reason = "superseded";
      }
    }

    this.#facts.set(fact.id, fact);
    return fact;
  }

  async listFacts(uid: string, limit = 100): Promise<Fact[]> {
    return [...this.#facts.values()]
      .filter((f) => f.uid === uid && isLive(f))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit);
  }

  async getFact(id: string): Promise<Fact | null> {
    return this.#facts.get(id) ?? null;
  }

  async search(uid: string, query: string, limit: number): Promise<SearchHit[]> {
    const q = await this.#embedder.embed(query);
    return [...this.#facts.values()]
      .filter((f) => f.uid === uid && isLive(f))
      .map((fact) => ({ fact, score: cosine(q, fact.embedding) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async softDelete(id: string, reason: NonNullable<Fact["deleted_reason"]>): Promise<void> {
    const f = this.#facts.get(id);
    if (!f || f.deleted_at !== null) return;
    f.deleted_at = this.#now().toISOString();
    f.deleted_reason = reason;
  }

  async reinforce(id: string, at: string): Promise<void> {
    const f = this.#facts.get(id);
    if (!f || !isLive(f)) return;
    f.last_reinforced = at;
    // Reinforcement raises salience with diminishing returns, so a fact
    // mentioned twice does not outrank one mentioned constantly.
    f.salience = Math.min(1, f.salience + (1 - f.salience) * 0.25);
  }

  async appendEpisode(episode: Episode): Promise<void> {
    this.#episodes.push(episode);
  }

  async listEpisodes(uid: string, limit: number): Promise<Episode[]> {
    return this.#episodes
      .filter((e) => e.uid === uid)
      .sort((a, b) => b.ended_at.localeCompare(a.ended_at))
      .slice(0, limit);
  }

  async close(): Promise<void> {
    this.#facts.clear();
    this.#episodes.length = 0;
  }

  /** Test/debug only — includes retired rows, which listFacts never returns. */
  allFactsIncludingDeleted(uid: string): Fact[] {
    return [...this.#facts.values()].filter((f) => f.uid === uid);
  }
}
