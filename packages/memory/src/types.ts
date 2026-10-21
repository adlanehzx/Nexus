import { z } from "zod";

/**
 * Memory contracts — see docs/architecture/10-memory.md.
 *
 * Six distinct concerns are categorized under "memory", each with distinct lifecycles,
 * ownership models, and retention rules:
 *
 * | Layer                     | Stored In                 | Lifetime                  |
 * |---------------------------|---------------------------|---------------------------|
 * | 1. Conversation history   | `ConversationStore`       | permanent (archived)      |
 * | 2. Short-term context     | `ShortTermContext`        | session end               |
 * | 3. Long-term memory       | `MemoryProvider`          | until explicitly purged   |
 * | 4. User preferences       | `MemoryProvider` (layer)  | until updated/superseded  |
 * | 5. Device state           | `DeviceRegistry`          | until revocation          |
 * | 6. Task execution history | `TaskStore`               | until retention cleanup   |
 *
 * **Only layers 3 and 4 are stored here.** The other four maintain dedicated owners elsewhere.
 * This package accesses them via ports (`sources.ts`) when assembling prompt contexts.
 */

/**
 * Context layer categorization for memories.
 *
 * `WORKING` and `SHORT_TERM` represent runtime prompt assembly layers;
 * they are never persisted as long-term storage records.
 */
export const memoryLayerSchema = z.enum([
  "WORKING",
  "SHORT_TERM",
  "CONVERSATION",
  "LONG_TERM",
  "PREFERENCE",
]);
export type MemoryLayer = z.infer<typeof memoryLayerSchema>;

/** Layers persisted by `MemoryProvider`. */
export const storableLayerSchema = z.enum(["LONG_TERM", "PREFERENCE"]);
export type StorableLayer = z.infer<typeof storableLayerSchema>;

export const memoryKindSchema = z.enum(["SEMANTIC", "EPISODIC", "PROCEDURAL"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/**
 * Origin of the memory item.
 *
 * Differentiates explicit user declarations ("Remember that...") from agent-inferred insights.
 */
export const memoryOriginSchema = z.enum(["USER", "AGENT", "SYSTEM"]);
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

/** Sensitivity classification evaluated upon storage. */
export const sensitivitySchema = z.enum(["ORDINARY", "PERSONAL"]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

/**
 * Memory records are superseded rather than overwritten.
 * `validFrom`/`validUntil` and `supersededById` track lineage over time.
 */
export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  layer: storableLayerSchema.default("LONG_TERM"),
  kind: memoryKindSchema,
  content: z.string().min(1),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()).default([]),
  origin: memoryOriginSchema.default("USER"),
  sensitivity: sensitivitySchema.default("ORDINARY"),
  /** Recognized sensitive categories — e.g. health, finance, identity. */
  sensitiveCategories: z.array(z.string()).default([]),
  sourceRunId: z.string().nullable().default(null),
  sourceConversationId: z.string().nullable().default(null),
  sourceMessageId: z.string().nullable().default(null),
  sourceUri: z.string().nullable().default(null),
  contentHash: z.string().min(1),
  embeddingModel: z.string().nullable().default(null),
  extractedAt: z.date().nullable().default(null),
  validFrom: z.date(),
  validUntil: z.date().nullable().default(null),
  supersededById: z.string().nullable().default(null),
  /** Previous record ID replaced by this one, preserving history lineage. */
  supersedesId: z.string().nullable().default(null),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export interface MemoryQuery {
  userId: string;
  text: string;
  kinds?: MemoryKind[];
  limit?: number;
  /** Token budget allocated to memories within context window. */
  tokenBudget?: number;
}
