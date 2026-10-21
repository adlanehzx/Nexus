import { uuidv7 } from "@nexus/shared";
import type { MemoryRecord } from "./types.js";
import type {
  MemoryHit,
  MemoryProvider,
  MemorySearchQuery,
  MemoryStoreInput,
  MemorySummarizeInput,
  MemoryUpdateInput,
} from "./provider.js";
import {
  cosineSimilarity,
  LocalHashEmbeddingProvider,
  memoryContentHash,
  type EmbeddingProvider,
} from "./embedding.js";

/**
 * In-memory memory provider.
 *
 * This is not a test mock: it is a functional reference implementation for
 * development and the behavioral baseline that the pgvector implementation conforms to.
 *
 * Search uses hybrid scoring (lexical overlap + cosine vector similarity weighted
 * by importance and recency).
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  readonly #records = new Map<string, MemoryRecord>();
  readonly #vectors = new Map<string, readonly number[]>();
  readonly #now: () => Date;
  readonly #embeddings: EmbeddingProvider;

  constructor(options: { now?: () => Date; embeddings?: EmbeddingProvider } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#embeddings = options.embeddings ?? new LocalHashEmbeddingProvider();
  }

  async store(input: MemoryStoreInput): Promise<MemoryRecord> {
    const now = this.#now();
    const [embedding = []] = await this.#embeddings.embed([input.content]);
    const record: MemoryRecord = {
      id: uuidv7(now.getTime()),
      userId: input.userId,
      layer: input.layer ?? "LONG_TERM",
      kind: input.kind,
      content: input.content,
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.8,
      tags: [...(input.tags ?? [])],
      origin: input.origin ?? "USER",
      sensitivity: input.sensitivity ?? "ORDINARY",
      sensitiveCategories: [...(input.sensitiveCategories ?? [])],
      sourceRunId: input.sourceRunId ?? null,
      sourceConversationId: input.sourceConversationId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceUri: input.sourceUri ?? null,
      contentHash: memoryContentHash(input.content),
      embeddingModel: this.#embeddings.model,
      extractedAt: input.extractedAt ?? null,
      validFrom: now,
      validUntil: null,
      supersededById: null,
      supersedesId: null,
    };
    this.#records.set(record.id, record);
    this.#vectors.set(record.id, embedding);
    return record;
  }

  /**
   * Updates an existing memory record.
   *
   * Revisions to stated content supersede previous records to preserve history,
   * while metadata updates apply in-place.
   */
  async update(input: MemoryUpdateInput): Promise<MemoryRecord | undefined> {
    const existing = this.#owned(input.userId, input.id);
    if (existing === undefined) return undefined;

    const changesContent = input.content !== undefined && input.content !== existing.content;

    if (!changesContent) {
      const patched: MemoryRecord = {
        ...existing,
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
        ...(input.layer === undefined ? {} : { layer: input.layer }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
      };
      this.#records.set(patched.id, patched);
      return patched;
    }

    const now = this.#now();
    const replacement: MemoryRecord = {
      ...existing,
      id: uuidv7(now.getTime()),
      content: input.content ?? existing.content,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
      ...(input.layer === undefined ? {} : { layer: input.layer }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      validFrom: now,
      validUntil: null,
      supersededById: null,
      supersedesId: existing.id,
      contentHash: memoryContentHash(input.content ?? existing.content),
      embeddingModel: this.#embeddings.model,
    };
    const [embedding = []] = await this.#embeddings.embed([replacement.content]);

    // The old record is not deleted: it ceases to be active starting from now.
    this.#records.set(existing.id, {
      ...existing,
      validUntil: now,
      supersededById: replacement.id,
    });
    this.#records.set(replacement.id, replacement);
    this.#vectors.set(replacement.id, embedding);

    return replacement;
  }

  delete(input: { userId: string; id: string }): Promise<boolean> {
    if (this.#owned(input.userId, input.id) === undefined) return Promise.resolve(false);
    this.#vectors.delete(input.id);
    return Promise.resolve(this.#records.delete(input.id));
  }

  async search(query: MemorySearchQuery): Promise<MemoryHit[]> {
    const terms = tokenize(query.query);
    const [queryVector = []] =
      terms.length === 0 ? [[]] : await this.#embeddings.embed([query.query]);
    const now = this.#now().getTime();
    const limit = query.limit ?? 8;
    const hits: MemoryHit[] = [];

    for (const record of this.#records.values()) {
      if (record.userId !== query.userId) continue;
      if (query.kinds !== undefined && !query.kinds.includes(record.kind)) continue;
      if (query.layers !== undefined && !query.layers.includes(record.layer)) continue;

      // Superseded or expired facts are excluded from standard search by default
      // but retained for historical lineage queries.
      if (query.includeSuperseded !== true) {
        if (record.supersededById !== null) continue;
        if (record.validUntil !== null && record.validUntil.getTime() <= now) continue;
      }

      // Empty query returns recent records (used for management UI).
      if (terms.length === 0) {
        hits.push({ record, score: recency(record, now) });
        continue;
      }

      const recordTerms = new Set(tokenize(record.content));
      const overlap = terms.filter((term) => recordTerms.has(term)).length;
      const semantic = Math.max(
        0,
        cosineSimilarity(queryVector, this.#vectors.get(record.id) ?? []),
      );
      if (overlap === 0 && semantic < 0.08) continue;

      const lexical = overlap / terms.length;
      hits.push({
        record,
        score:
          0.45 * lexical + 0.35 * semantic + 0.12 * record.importance + 0.08 * recency(record, now),
      });
    }

    hits.sort((left, right) => right.score - left.score || compareIds(left, right));
    return hits.slice(0, limit);
  }

  /**
   * Extractive summarization: first sentences within character budget.
   *
   * Kept non-generative to avoid LLM dependencies in the memory provider core.
   */
  summarize(input: MemorySummarizeInput): Promise<string> {
    const budget = input.maxChars ?? 500;
    const sentences = input.text
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);

    const kept: string[] = [];
    let length = 0;
    for (const sentence of sentences) {
      if (length + sentence.length > budget) break;
      kept.push(sentence);
      length += sentence.length + 1;
    }

    return Promise.resolve(kept.length > 0 ? kept.join(" ") : input.text.slice(0, budget));
  }

  /** Total number of stored memory records — useful for diagnostics and tests. */
  get size(): number {
    return this.#records.size;
  }

  /** Retrieves a record scoped strictly to the given user ID. */
  #owned(userId: string, id: string): MemoryRecord | undefined {
    const record = this.#records.get(id);
    return record?.userId === userId ? record : undefined;
  }
}

/**
 * Recency weight of a memory, from 0 to 1 with a 30-day half-life.
 */
function recency(record: MemoryRecord, now: number): number {
  const ageDays = (now - record.validFrom.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / 30);
}

/** Tie-breaker for identical scores ensuring deterministic sort order. */
function compareIds(left: MemoryHit, right: MemoryHit): number {
  return left.record.id < right.record.id ? 1 : -1;
}

/** Extracts lowercase alphanumeric words (>= 3 chars) without diacritics. */
function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
}
