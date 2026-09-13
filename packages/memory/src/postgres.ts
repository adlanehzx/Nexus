import { uuidv7 } from "@nexus/shared";
import type { Prisma, PrismaClient } from "@nexus/database";
import { memoryRecordSchema, type MemoryRecord } from "./types.js";
import type {
  MemoryHit,
  MemoryProvider,
  MemorySearchQuery,
  MemoryStoreInput,
  MemorySummarizeInput,
  MemoryUpdateInput,
} from "./provider.js";

/** Durable PostgreSQL implementation of the existing MemoryProvider contract. */
export class PostgresMemoryProvider implements MemoryProvider {
  readonly #prisma: PrismaClient;
  readonly #now: () => Date;

  constructor(options: { prisma: PrismaClient; now?: () => Date }) {
    this.#prisma = options.prisma;
    this.#now = options.now ?? (() => new Date());
  }

  async store(input: MemoryStoreInput): Promise<MemoryRecord> {
    const now = this.#now();
    const record = await this.#prisma.memory.create({
      data: {
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
        validFrom: now,
        validUntil: null,
        supersededById: null,
        supersedesId: null,
      },
    });

    return toRecord(record);
  }

  async update(input: MemoryUpdateInput): Promise<MemoryRecord | undefined> {
    return this.#prisma.$transaction(async (transaction) => {
      const existing = await transaction.memory.findFirst({
        where: { id: input.id, userId: input.userId },
      });
      if (existing === null) return undefined;

      const changesContent = input.content !== undefined && input.content !== existing.content;
      if (!changesContent) {
        const patched = await transaction.memory.update({
          where: { id: existing.id },
          data: {
            ...(input.importance === undefined ? {} : { importance: input.importance }),
            ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
            ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
            ...(input.layer === undefined ? {} : { layer: input.layer }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
          },
        });
        return toRecord(patched);
      }

      const now = this.#now();
      const replacement = await transaction.memory.create({
        data: {
          id: uuidv7(now.getTime()),
          userId: existing.userId,
          layer: input.layer ?? existing.layer,
          kind: input.kind ?? existing.kind,
          content: input.content ?? existing.content,
          importance: input.importance ?? existing.importance,
          confidence: input.confidence ?? existing.confidence,
          tags: input.tags === undefined ? existing.tags : [...input.tags],
          origin: existing.origin,
          sensitivity: existing.sensitivity,
          sensitiveCategories: existing.sensitiveCategories,
          validFrom: now,
          validUntil: null,
          supersededById: null,
          supersedesId: existing.id,
        },
      });

      await transaction.memory.update({
        where: { id: existing.id },
        data: { validUntil: now, supersededById: replacement.id },
      });

      return toRecord(replacement);
    });
  }

  async delete(input: { userId: string; id: string }): Promise<boolean> {
    const result = await this.#prisma.memory.deleteMany({
      where: { id: input.id, userId: input.userId },
    });
    return result.count > 0;
  }

  async search(query: MemorySearchQuery): Promise<MemoryHit[]> {
    const now = this.#now().getTime();
    const records = await this.#prisma.memory.findMany({
      where: {
        userId: query.userId,
        ...(query.kinds === undefined ? {} : { kind: { in: [...query.kinds] } }),
        ...(query.layers === undefined ? {} : { layer: { in: [...query.layers] } }),
        ...(query.includeSuperseded === true
          ? {}
          : {
              supersededById: null,
              OR: [{ validUntil: null }, { validUntil: { gt: new Date(now) } }],
            }),
      },
    });
    const terms = tokenize(query.query);
    const hits: MemoryHit[] = [];

    for (const stored of records) {
      const record = toRecord(stored);
      if (terms.length === 0) {
        hits.push({ record, score: recency(record, now) });
        continue;
      }

      const recordTerms = new Set(tokenize(record.content));
      const overlap = terms.filter((term) => recordTerms.has(term)).length;
      if (overlap === 0) continue;

      hits.push({
        record,
        score:
          0.7 * (overlap / terms.length) + 0.2 * record.importance + 0.1 * recency(record, now),
      });
    }

    hits.sort((left, right) => right.score - left.score || compareIds(left, right));
    return hits.slice(0, query.limit ?? 8);
  }

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
}

function toRecord(record: Prisma.MemoryModel): MemoryRecord {
  return memoryRecordSchema.parse({
    id: record.id,
    userId: record.userId,
    layer: record.layer,
    kind: record.kind,
    content: record.content,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    origin: record.origin,
    sensitivity: record.sensitivity,
    sensitiveCategories: record.sensitiveCategories,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    supersededById: record.supersededById,
    supersedesId: record.supersedesId,
  });
}

function recency(record: MemoryRecord, now: number): number {
  const ageDays = (now - record.validFrom.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / 30);
}

function compareIds(left: MemoryHit, right: MemoryHit): number {
  return left.record.id < right.record.id ? 1 : -1;
}

function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
}
