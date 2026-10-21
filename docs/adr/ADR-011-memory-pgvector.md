# ADR-011 — pgvector Rather Than a Dedicated Vector Database

**Status**: Proposed · 2026-09-01

## Context

Long-term memory requires semantic retrieval. The immediate reflex in modern AI stacks is adding a
dedicated vector database (Qdrant, Weaviate, Pinecone). We must evaluate whether actual system
requirements warrant this operational complexity.

## Decision

`pgvector` inside the primary PostgreSQL database, using HNSW indexes with **hybrid search**:
dense vector embeddings combined with full-text search (`tsvector`), merged via Reciprocal Rank
Fusion (RRF), and reranked using importance, recency, and access frequency factors.

## Alternatives

- **Self-hosted Qdrant / Weaviate.** Better suited at massive scale (10⁷+ vectors), richer filtering,
  quantization. Rejected: a personal assistant generates 10⁴–10⁵ memories over its lifetime, an
  operating envelope where pgvector returns in milliseconds. Running a dedicated engine adds another
  daemon to operate, back up, secure, and maintain in sync.
- **SaaS Vector DB (Pinecone, Turbopuffer).** Zero operational maintenance, but introduces external
  network dependencies, recurring costs, and exports private memory data to a third party —
  counter to our local-first, privacy-respecting ethos.
- **Full-text search alone.** Fails on paraphrases and synonym matches, which constitute the core
  retrieval patterns of conversational memory.

## Consequences

**Positive** — **Single atomic transaction**: a memory record and its vector embedding are created,
updated, and deleted atomically within PostgreSQL, eliminating split-brain desynchronization. A
single unified backup, a single security perimeter, and a single system to monitor. Relational
filters (`userId`, `type`, `validUntil`) are native and performant.

**Negative, accepted** — HNSW indexes consume RAM on the PostgreSQL instance (negligible at this
scale); rebuilding indexes following embedding model upgrades requires scripted maintenance; scale
beyond ~10⁶ vectors will require architectural reassessment.

## Re-evaluation Trigger

If p95 latency on `memory.search` exceeds 150 ms or vector count crosses 10⁶, reopen this decision.
The `MemoryStore` port interface is already decoupled, allowing an alternative adapter implementation.
