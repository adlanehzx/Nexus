import type { MemoryKind, MemoryOrigin, MemoryRecord, StorableLayer } from "./types.js";

export interface MemorySearchQuery {
  userId: string;
  /**
   * Free text query: user question, or an excerpt from the current conversation turn.
   *
   * **Empty string = scan all records**, ordered newest to oldest.
   * Used by memory management interfaces to inspect all items without guessing search terms.
   */
  query: string;
  kinds?: readonly MemoryKind[];
  layers?: readonly StorableLayer[];
  limit?: number;
  /** Includes superseded or expired records to trace memory item history. */
  includeSuperseded?: boolean;
}

export interface MemoryHit {
  record: MemoryRecord;
  /** Normalized relevance score in [0, 1]. */
  score: number;
}

export interface MemoryStoreInput {
  userId: string;
  kind: MemoryKind;
  content: string;
  layer?: StorableLayer;
  origin?: MemoryOrigin;
  importance?: number;
  confidence?: number;
  tags?: readonly string[];
  sourceRunId?: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  sourceUri?: string;
  /** Automatic extraction timestamp. Omitted for explicit user commands. */
  extractedAt?: Date;
  /** Sensitivity already arbitrated by `MemoryService`. */
  sensitivity?: MemoryRecord["sensitivity"];
  sensitiveCategories?: readonly string[];
}

/**
 * Attributes modifiable during memory updates.
 *
 * Modifying `content` supersedes the record to preserve lineage.
 * Metadata attributes (tags, importance, confidence) update in-place.
 */
export interface MemoryUpdateInput {
  userId: string;
  id: string;
  content?: string;
  importance?: number;
  confidence?: number;
  tags?: readonly string[];
  layer?: StorableLayer;
  kind?: MemoryKind;
}

export interface MemorySummarizeInput {
  userId: string;
  /** Text content to summarize — conversation transcript or memory batch. */
  text: string;
  /** Target character length for summary. Indicative rather than strict. */
  maxChars?: number;
}

/**
 * Port `MemoryProvider`.
 *
 * Agent core relies on this interface independently of storage backends (pgvector, SQLite, in-memory).
 *
 * **Every method enforces `userId` scoping**, ensuring authorization checks cannot be bypassed
 * via guessable record identifiers.
 */
export interface MemoryProvider {
  search(query: MemorySearchQuery): Promise<MemoryHit[]>;
  store(input: MemoryStoreInput): Promise<MemoryRecord>;
  /**
   * Updates an existing memory record.
   *
   * Changing `content` creates a new record and marks the prior record superseded.
   * Metadata adjustments apply in-place.
   *
   * @returns Current active record, or `undefined` if nonexistent or unowned by `userId`.
   */
  update(input: MemoryUpdateInput): Promise<MemoryRecord | undefined>;
  delete(input: { userId: string; id: string }): Promise<boolean>;
  summarize(input: MemorySummarizeInput): Promise<string>;
}
