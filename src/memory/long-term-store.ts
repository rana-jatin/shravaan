/**
 * Long-term memory: the semantic (fact) store and the longitudinal (episode) log.
 *
 * Two stores with deliberately different shapes. Semantic answers "what do I know
 * about them"; longitudinal answers "what happened, in order". One store cannot
 * do both well — see docs/adr/0004-vector-store.md.
 *
 * BEHIND AN INTERFACE ON PURPOSE. ADR 0004 (Postgres + pgvector) is still marked
 * *Proposed*: no vendor documentation was ever fetched for it, because the
 * research brief scoped live-doc research to the speech providers. Building the
 * pipeline against an interface means the distillation logic — which is the part
 * that actually carries the product — is testable and correct regardless of how
 * that decision lands.
 *
 * TWO INVARIANTS THIS INTERFACE EXISTS TO PROTECT:
 *
 *   1. SUPERSEDE, NEVER OVERWRITE. If a user says they live in Pune and later in
 *      Bengaluru, the old fact stays with `superseded_by` set. The agent must
 *      never assert the stale one, but the history is why it can say "you
 *      mentioned you'd moved". Overwriting destroys that.
 *
 *   2. SOFT DELETE, ALWAYS. A `user_requested` deletion stops being retrieved
 *      immediately but remains auditable. A companion holding personal data needs
 *      a defensible deletion story more than it needs reclaimed rows.
 */

import type { Episode, Fact, FactKind } from "../domain/types.ts";

export type FactDraft = {
  uid: string;
  text: string;
  kind: FactKind;
  salience: number;
  confidence: number;
  source_event_id: string;
  source_sid: string;
  /** When set, the new fact supersedes this one. */
  supersedes?: string | undefined;
};

export type SearchHit = { fact: Fact; score: number };

export interface LongTermStore {
  /** Insert a fact, applying the supersede chain if `supersedes` is set. */
  putFact(draft: FactDraft): Promise<Fact>;

  /** Live facts only — never returns soft-deleted or superseded rows. */
  listFacts(uid: string, limit?: number): Promise<Fact[]>;

  getFact(id: string): Promise<Fact | null>;

  /** Semantic search over live facts. */
  search(uid: string, query: string, limit: number): Promise<SearchHit[]>;

  /** Soft delete. `reason` is recorded; the row is never removed. */
  softDelete(id: string, reason: NonNullable<Fact["deleted_reason"]>): Promise<void>;

  /** Reinforce an existing fact rather than duplicating it. */
  reinforce(id: string, at: string): Promise<void>;

  appendEpisode(episode: Episode): Promise<void>;
  /** Newest first. */
  listEpisodes(uid: string, limit: number): Promise<Episode[]>;

  close(): Promise<void>;
}

/**
 * Turns text into a vector.
 *
 * DELIBERATELY UNDECIDED. ADR 0004 flags that the embedding model is not a
 * neutral choice here: facts are multilingual — Hindi, English and Hinglish in
 * the same table — so a model that quietly degrades on code-mixed Indic text
 * would make retrieval worst in exactly the register our users speak. Choosing
 * one is a real evaluation, not a default.
 *
 * Dimensionality is also a migration: changing models means re-embedding every
 * fact. Pick once.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

/**
 * A deterministic bag-of-tokens embedder.
 *
 * NOT FOR PRODUCTION. It captures lexical overlap and nothing else — no
 * synonymy, no cross-lingual matching, so "I live in Bengaluru" and "मैं बेंगलुरु
 * में रहता हूँ" score near zero against each other. That is precisely the
 * failure a real multilingual embedder has to fix.
 *
 * It exists so the pipeline is testable and the retrieval path is exercised
 * end to end without a network call or a vendor decision.
 */
export class HashingEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 128) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[.,!?;:—…"'`()[\]{}।॥]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      vec[Math.abs(h) % this.dimensions]! += 1;
    }

    const norm = Math.hypot(...vec);
    return norm === 0 ? vec : vec.map((v) => v / norm);
  }
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
