import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import { PostgresMemoryProvider } from "../src/postgres.js";
import type { EmbeddingProvider } from "../src/embedding.js";

class TestNeuralEmbeddings implements EmbeddingProvider {
  readonly model = "test-neural-384";
  readonly dimensions = 384;

  embed(texts: readonly string[]): Promise<readonly number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = Array.from<number>({ length: this.dimensions }).fill(0);
        vector[text.toLowerCase().includes("train") ? 0 : 1] = 1;
        return vector;
      }),
    );
  }
}

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres("PostgresMemoryProvider", () => {
  let prisma: PrismaClient;
  let provider: PostgresMemoryProvider;
  let userId: string;

  beforeAll(async () => {
    prisma = createDatabaseClient({ url: databaseUrl! });
    userId = uuidv7();
    await prisma.user.create({
      data: { id: userId, email: `${userId}@memory.test`, displayName: "Memory test" },
    });
  });

  beforeEach(async () => {
    await prisma.memory.deleteMany({ where: { userId } });
    provider = new PostgresMemoryProvider({ prisma });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("persists records across provider instances and lists them with an empty query", async () => {
    const stored = await provider.store({ userId, kind: "SEMANTIC", content: "Préfère le train" });
    const reloaded = new PostgresMemoryProvider({ prisma });

    const hits = await reloaded.search({ userId, query: "" });

    expect(hits.map((hit) => hit.record.id)).toEqual([stored.id]);
  });

  it("supports lexical search and multiple independent records", async () => {
    await provider.store({ userId, kind: "SEMANTIC", content: "Préfère le train" });
    await provider.store({ userId, kind: "EPISODIC", content: "Visité Lyon en mai" });

    const hits = await provider.search({ userId, query: "train" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.kind).toBe("SEMANTIC");
  });

  it("persists embeddings and provenance for hybrid retrieval", async () => {
    const sourceRunId = uuidv7();
    const stored = await provider.store({
      userId,
      kind: "SEMANTIC",
      content: "J'aime le vélo",
      sourceRunId,
      sourceUri: "https://example.test/source",
      extractedAt: new Date("2026-10-20T10:00:00Z"),
    });

    const hits = await new PostgresMemoryProvider({ prisma }).search({
      userId,
      query: "J'adore la bicyclette",
    });

    expect(hits[0]?.record.id).toBe(stored.id);
    expect(hits[0]?.record.sourceRunId).toBe(sourceRunId);
    expect(hits[0]?.record.sourceUri).toBe("https://example.test/source");
    expect(hits[0]?.record.embeddingModel).toMatch(/^nexus-hash-v1-/);
  });

  it("synchronise et interroge les embeddings neuronaux dans pgvector", async () => {
    provider = new PostgresMemoryProvider({
      prisma,
      embeddings: new TestNeuralEmbeddings(),
    });
    const train = await provider.store({
      userId,
      kind: "SEMANTIC",
      content: "Voyage habituel en train",
    });
    await provider.store({ userId, kind: "SEMANTIC", content: "Cuisine italienne" });

    const hits = await provider.search({ userId, query: "train de nuit", limit: 1 });

    expect(hits[0]?.record.id).toBe(train.id);
    expect(hits[0]?.record.embeddingModel).toBe("test-neural-384");
  });

  it("persists updates and supersession", async () => {
    const previous = await provider.store({ userId, kind: "SEMANTIC", content: "Habite à Lyon" });
    const current = await provider.update({ userId, id: previous.id, content: "Habite à Paris" });

    expect(current?.supersedesId).toBe(previous.id);

    const history = await provider.search({ userId, query: "habite", includeSuperseded: true });
    const old = history.find((hit) => hit.record.id === previous.id)?.record;
    expect(old?.supersededById).toBe(current?.id);
    expect(old?.validUntil).not.toBeNull();
  });

  it("persists deletion", async () => {
    const stored = await provider.store({ userId, kind: "SEMANTIC", content: "À oublier" });

    expect(await provider.delete({ userId, id: stored.id })).toBe(true);
    expect(await new PostgresMemoryProvider({ prisma }).search({ userId, query: "" })).toEqual([]);
  });

  it("does not cross user boundaries", async () => {
    const otherUserId = uuidv7();
    await prisma.user.create({
      data: {
        id: otherUserId,
        email: `${otherUserId}@memory.test`,
        displayName: "Other memory test",
      },
    });
    const other = await provider.store({
      userId: otherUserId,
      kind: "SEMANTIC",
      content: "Secret utilisateur autre",
    });

    try {
      expect(await provider.search({ userId, query: "secret" })).toEqual([]);
      expect(await provider.update({ userId, id: other.id, content: "détourné" })).toBeUndefined();
      expect(await provider.delete({ userId, id: other.id })).toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: otherUserId } });
    }
  });
});
