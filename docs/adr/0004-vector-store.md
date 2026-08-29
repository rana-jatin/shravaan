# ADR 0004 — Postgres + pgvector for long-term memory

**Status:** Proposed · **Date:** 2026-08-29

> **Research caveat.** Unlike ADRs 0001, 0003, 0005 and 0006, **no vendor documentation was
> fetched for this decision**. The research brief scoped live-doc research to the speech
> providers and orchestration frameworks. The reasoning below rests on the shape of our own
> data ([02](../02-data-contracts.md)) and on the residency constraint, not on verified
> vendor claims. **Status stays Proposed until pricing, limits and India-region availability
> are confirmed against live docs.**

## Context

Long-term memory has two stores with genuinely different shapes
([02 §4](../02-data-contracts.md#4-long-term-memory)):

- **Facts** — semantic, vector-searched, with supersede chains and soft deletes
- **Episodes** — longitudinal, append-only, queried by time and by join from facts

Neither is on the turn's critical path. Both are warmed into Redis at session open. That
relaxes the latency requirement enormously and makes this a correctness and operability
decision rather than a performance one.

Under strong continuity this store *is* the product. Losing it loses the relationship.

## Decision

**Postgres with the pgvector extension**, holding both stores: facts in a table with a
vector column, episodes in an ordinary append-only table, joined by `fact_ids`.

## Options considered

### Postgres + pgvector — chosen

- **One store, one transaction.** A fact and its supersede edge commit atomically with the
  episode that produced them. Two separate systems would need a reconciliation path for a
  partial write, and reconciliation bugs in a memory system surface as a companion
  contradicting itself.
- **The relational half is not incidental.** Supersede chains, soft deletes with reasons,
  provenance back to `source_event_id`, and joins from episode to fact are all ordinary SQL.
  A pure vector database treats these as metadata filters, which is a worse fit than it
  looks once deletion and audit are real requirements.
- **Latency is not the constraint.** Off the turn path, warmed at session open. pgvector's
  performance ceiling is far above what this workload needs at the scale it will start at.
- **India residency is straightforward** — any Indian cloud region, or self-hosted. This
  matters given Sarvam is India-resident by design and Deepgram offers only EU and AU
  ([00 §5](../00-provider-research.md#5-commercials)).
- **Operationally boring.** Backups, point-in-time recovery and access control are solved
  problems. For a store holding personal conversational history, boring is the feature.

### Dedicated vector database (Qdrant, Weaviate, Milvus) — rejected for now

Better pure-vector performance and richer index tuning. Rejected because it solves a problem
we do not have — our bottleneck is the supersede/soft-delete/provenance model, not ANN
throughput — and adds a second store to keep consistent with the episode log.

**Revisit if** fact volume per user grows past what a single Postgres can serve comfortably,
or if retrieval quality becomes the limiting factor on the companion's feel.

### Managed vector API (Pinecone and similar) — rejected

Lowest operational burden. Rejected on two grounds: **data residency**, which is the
strongest argument in the whole stack for keeping Indic sessions in India, and the same
two-store consistency problem as above. A managed API also puts the most sensitive data in
the system — a person's conversational history — outside our direct control.

### Redis vector search — rejected

Attractive because Redis is already in the stack, and warm-to-Redis is the read path anyway.
Rejected because long-term memory must be **durable, backed up and auditable**, and our Redis
is deliberately configured as an ephemeral working-memory tier with idle TTLs
([02 §2](../02-data-contracts.md#2-redis--working-memory)). Conflating the two tiers would
mean either weakening Redis's ephemerality or pretending a cache is a system of record.

## Consequences

- **One store to back up, and it must actually be backed up.** This holds everything the
  companion knows about a person. Restore should be rehearsed, not assumed.
- **Embedding model choice is deferred and is not neutral.** Facts are multilingual —
  Hindi, English and Hinglish in the same table — so the embedding model must handle
  code-mixed Indic text. A model that quietly degrades on Hinglish would make retrieval
  worse in exactly the register our users speak. Worth evaluating alongside
  [slice 4](../04-milestones.md#slice-4--continuity-across-days).
- **Dimensionality is a migration.** Changing embedding models means re-embedding every
  fact. Pick once, deliberately.
- **Deletion must be soft, always.** `deleted_at` plus `deleted_reason`, never `DELETE`.
  Required for the supersede model to stay explicable, and for a defensible answer when
  someone asks what the system knows about them.
- **Scale assumption stated plainly:** a few thousand facts and a few hundred episodes per
  user. If usage produces an order of magnitude more, revisit.
