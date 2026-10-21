# 10 — Memory Strategy

## 1. Five Layers, Five Lifespans

The term "memory" encompasses five distinct mechanisms that must not be conflated:

| Layer                    | Content                                                     | Lifespan             | Storage                  | Injected into Prompt       |
| ------------------------ | ----------------------------------------------------------- | -------------------- | ------------------------ | -------------------------- |
| **Working context**      | Immediate token window passed to the model                  | Current turn         | RAM                      | In full (defines context)  |
| **Short-term memory**    | Active run execution: plan, tool observations, drafts       | Duration of run      | `AgentStep` + Redis      | Yes, intelligently trimmed |
| **Conversation history** | Chat messages in a conversation                             | Indefinite           | `Message`                | Last K turns + summary     |
| **Long-term memory**     | Extracted facts, implicit preferences, procedural knowledge | Indefinite           | `Memory` + local vector  | Hybrid top-K retrieval     |
| **User preferences**     | Explicit structured settings                                | Until changed        | `UserPreference`         | Always, compact format     |

Two auxiliary audit stores exist which are **not** prompt memory, but are queryable via tools:
`Task` (task execution history) and `ToolExecution` (audit trail of tool calls). The agent queries
these via `history.search` rather than polluting its immediate context window.

## 2. Writing to Long-Term Memory

Memory extraction is **asynchronous and post-run** — never on the critical latency path of a user response:

```
Run Completed → ControlledMemoryExtractor
  1. Extractor proposes candidate facts { type, content, importance, confidence, provenance }
  2. Filtering: No secrets, no ephemeral comments ("I feel tired"), no duplicates
  3. Exact deduplication via normalized content hash
     → Paraphrases are flagged for confirmation to avoid merging contradictions
  4. Vector embedding generation + database insertion
  5. Emits WS memory.updated → Dashboard displays subtle "Remembered that…" indicator
```

Three core design rules:

- **Memory is inspectable and editable.** A dedicated Settings → Memory screen lists all memories,
  allowing users to edit, pin, or delete entries. Uncorrectable memory is a product flaw.
- **Facts are superseded, never overwritten.** `supersededById` + `validFrom/validUntil` preserve
  chronological truth over time (§07).
- **Inferred preferences are suggested, not silently applied.** Marked with `source=INFERRED` +
  `confidence`; exceeding a threshold triggers a prompt asking user confirmation before making it a rule.

## 3. Retrieval: Hybrid Search

Dense vector search alone struggles with proper nouns, model numbers, and IDs; full-text search misses
semantic paraphrases. The local retrieval engine combines both within application logic:

```
Candidates = User/Validity Filter + Full-Text Lexical + Dense Cosine Similarity
Score = 0.45·lexical + 0.35·similarity + 0.12·importance + 0.08·recency
Filters: userId, type, validUntil IS NULL OR validUntil > now()
Return: Top-K (default 8) bounded by token budget
```

`EmbeddingProvider` keeps the vectorizer pluggable. The default `nexus-hash-v1` is deterministic,
local, and requires zero API keys. Embeddings are stored with provenance in PostgreSQL. pgvector/HNSW
and Reciprocal Rank Fusion remain an optimization layer as dataset sizes scale.

## 4. Context Compaction

Triggered when prompt token consumption crosses ~70% of the model window, or after N conversational turns.

```
1. Plan: ContextWindowPlanner reserves output tokens and safety headroom per model
2. Protect: System prompt, preferences, last 3 turns, active plan DAG, pending confirmations
3. Summarize: Older turns via MemoryProvider.summarize port
4. Degrade: ContextCompactor caches original messages and returns { summary, artifactId }
5. Prune: Redundant or obsolete tool observations from earlier steps of current run
6. Verify: Recount token usage via injected TokenCounter; fallback to conservative estimation
```

Information is never permanently lost: it is **relocated outside the prompt context** and remains
accessible via `artifact.read` and `history.search`. This is the distinction between compaction and destruction.

## 5. Memory Pruning and Decay

A memory store that only expands accumulates noise and inflates retrieval costs. A weekly background job:

- Applies exponential decay to `importance` scores for facts unaccessed for >90 days;
- Archives items dropping below threshold out of search indexes without deletion;
- Flags semantic contradictions for user review rather than making silent assumptions;
- Performs immediate, comprehensive deletion upon user command ("forget this"), removing embeddings as well.

## 6. Why Not a Dedicated Vector Database

A personal assistant starts with a scale that standard PostgreSQL with vector support handles in
milliseconds without operational overhead. When dataset volume justifies approximate nearest-neighbor
(ANN) indexes, pgvector with HNSW keeps embeddings in **the same atomic transaction** as domain entities.
Separate clusters like Qdrant or Weaviate add unwarranted operational complexity at this scale
(→ [ADR-011](../adr/ADR-011-memory-pgvector.md)).
