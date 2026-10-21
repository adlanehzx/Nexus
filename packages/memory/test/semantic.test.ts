import { describe, expect, it } from "vitest";
import {
  ContextAssembler,
  ContextCompactor,
  ContextWindowPlanner,
  ControlledMemoryExtractor,
  InMemoryMemoryProvider,
  InMemoryContextArtifactStore,
  LocalHashEmbeddingProvider,
  MemoryConsolidator,
  MemoryService,
  memoryContentHash,
  type TokenCounter,
} from "../src/index.js";

describe("semantic memory", () => {
  it("retrieves a paraphrase through the local embedding port", async () => {
    const memory = new InMemoryMemoryProvider({
      embeddings: new LocalHashEmbeddingProvider({ dimensions: 128 }),
    });
    await memory.store({ userId: "u1", kind: "SEMANTIC", content: "I like cycling" });
    await memory.store({ userId: "u1", kind: "SEMANTIC", content: "Works in Lyon" });

    const hits = await memory.search({ userId: "u1", query: "I love bicycling" });

    expect(hits[0]?.record.content).toBe("I like cycling");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("keeps provenance and a stable normalized content hash", async () => {
    const memory = new InMemoryMemoryProvider();
    const first = await memory.store({
      userId: "u1",
      kind: "SEMANTIC",
      content: "  Prefers   train ",
      sourceRunId: "run-1",
      sourceConversationId: "conversation-1",
      sourceMessageId: "message-1",
      sourceUri: "https://example.test/source",
      extractedAt: new Date("2026-10-20T10:00:00Z"),
    });

    expect(first.contentHash).toBe(memoryContentHash("prefers train"));
    expect(first.sourceRunId).toBe("run-1");
    expect(first.sourceUri).toBe("https://example.test/source");
    expect(first.embeddingModel).toMatch(/^nexus-hash-v1-/);
  });

  it("deduplicates exact normalized content through MemoryService", async () => {
    const provider = new InMemoryMemoryProvider();
    const service = new MemoryService({ provider });

    const first = await service.remember({ userId: "u1", content: "Prefers train" });
    const duplicate = await service.remember({ userId: "u1", content: "  prefers  train " });

    expect(duplicate.id).toBe(first.id);
    expect(provider.size).toBe(1);
  });

  it("extracts candidates without writing until explicit approval", async () => {
    const provider = new InMemoryMemoryProvider();
    const service = new MemoryService({ provider });
    const extractor = new ControlledMemoryExtractor();
    const candidates = extractor.extract({
      text: "I love traveling by train. Here is sk-test-12345678901234567890. What time is it?",
      sourceRunId: "run-1",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ layer: "PREFERENCE", requiresReview: true });
    expect(provider.size).toBe(0);

    await extractor.storeApproved({
      userId: "u1",
      service,
      candidates,
      approvedIndexes: [0],
      now: new Date("2026-10-20T10:00:00Z"),
    });
    expect(provider.size).toBe(1);
  });

  it("plans consolidation and only deletes explicitly approved groups", async () => {
    const provider = new InMemoryMemoryProvider();
    await provider.store({ userId: "u1", kind: "SEMANTIC", content: "Prefers train" });
    await provider.store({
      userId: "u1",
      kind: "SEMANTIC",
      content: " prefers  train ",
      importance: 0.9,
    });
    const consolidator = new MemoryConsolidator(provider);
    const plan = await consolidator.plan("u1");

    expect(plan).toHaveLength(1);
    expect(await consolidator.apply("u1", plan, [])).toEqual({ deleted: 0 });
    expect(await consolidator.apply("u1", plan, [plan[0]!.canonical.id])).toEqual({ deleted: 1 });
  });
});

describe("token-aware context", () => {
  it("enforces the injected exact token counter independently from the char budget", async () => {
    const provider = new InMemoryMemoryProvider();
    await provider.store({ userId: "u1", kind: "SEMANTIC", content: "first memory" });
    await provider.store({ userId: "u1", kind: "SEMANTIC", content: "second memory" });
    const exactWords: TokenCounter = {
      count: (text) => text.trim().split(/\s+/).filter(Boolean).length,
    };
    const assembler = new ContextAssembler({
      memory: provider,
      tokenCounter: exactWords,
      budget: { longTerm: 10_000 },
      tokenBudget: { longTerm: 3 },
    });

    const assembled = await assembler.assemble({
      userId: "u1",
      conversationId: "c1",
      query: "memory",
      model: "test-exact",
    });
    const longTerm = assembled.sections.find((section) => section.name === "longTerm")!;

    expect(longTerm.lines).toHaveLength(1);
    expect(longTerm.tokens).toBeLessThanOrEqual(3);
    expect(assembled.tokens).toBeGreaterThan(0);
  });

  it("reserves output and safety capacity by model", () => {
    const plan = new ContextWindowPlanner({
      profiles: { local: { contextWindow: 1_000, reservedOutput: 200, safetyMargin: 100 } },
    }).plan("local", 750);

    expect(plan.available).toBe(0);
    expect(plan.overflow).toBe(50);
  });

  it("offloads the original before compacting an oversized context", async () => {
    const memory = new InMemoryMemoryProvider();
    const artifacts = new InMemoryContextArtifactStore();
    const tokens: TokenCounter = { count: (text) => text.length };
    const compactor = new ContextCompactor({ memory, artifacts, tokens });

    const result = await compactor.compact({
      userId: "u1",
      text: "Une phrase utile. ".repeat(30),
      maxTokens: 100,
      sourceRunId: "run-1",
    });

    expect(result.artifactId).toBeDefined();
    expect(result.compactedTokens).toBeLessThanOrEqual(100);
    expect((await artifacts.get({ userId: "u1", id: result.artifactId! }))?.content).toContain(
      "Une phrase utile",
    );
    expect(await artifacts.get({ userId: "u2", id: result.artifactId! })).toBeUndefined();
  });
});
