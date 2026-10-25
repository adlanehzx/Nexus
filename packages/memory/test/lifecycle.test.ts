import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";
import {
  AdvancedMemoryLifecycle,
  EncryptedMemorySynchronizer,
  FileMemoryLifecycleStateStore,
  InMemoryMemoryLifecycleStateStore,
  projectTag,
  type MemorySyncEvent,
} from "../src/lifecycle.js";
import { MemoryService } from "../src/service.js";

const userId = "lifecycle-user";

function harness(now = new Date("2026-10-25T10:00:00Z")) {
  const provider = new InMemoryMemoryProvider({ now: () => now });
  const service = new MemoryService({ provider });
  const state = new InMemoryMemoryLifecycleStateStore();
  return {
    provider,
    service,
    state,
    lifecycle: new AdvancedMemoryLifecycle({ provider, service, state, now: () => now }),
  };
}

describe("advanced memory lifecycle", () => {
  it("separates projects and selectively shares archival memory", async () => {
    const { service, lifecycle } = harness();
    const shared = await service.remember({
      userId,
      content: "Project Atlas decision",
      tags: [projectTag("atlas")],
    });
    await service.remember({
      userId,
      content: "Project Boreal decision",
      tags: [projectTag("boreal")],
    });
    await service.remember({
      userId,
      content: "Use compact output",
      layer: "PREFERENCE",
      tags: [projectTag("atlas")],
    });
    await lifecycle.shareWithAgents(userId, shared.id, ["agent-reviewer"]);

    const atlas = await lifecycle.hierarchy(userId, "atlas");
    expect(atlas.archival).toHaveLength(1);
    expect(atlas.preferences).toHaveLength(1);
    expect(await lifecycle.visibleToAgent(userId, "agent-reviewer", "atlas")).toHaveLength(1);
    expect(await lifecycle.visibleToAgent(userId, "agent-other", "atlas")).toEqual([]);
  });

  it("requires review for consolidation and can roll it back", async () => {
    const { provider, lifecycle } = harness();
    await provider.store({ userId, kind: "SEMANTIC", content: "Same fact" });
    await provider.store({ userId, kind: "SEMANTIC", content: "Same fact" });
    const [proposal] = await lifecycle.proposeConsolidation(userId);
    expect(proposal?.status).toBe("PENDING_REVIEW");
    await lifecycle.reviewConsolidation(userId, proposal!.id, "APPROVE");
    expect(await provider.search({ userId, query: "", includeSuperseded: true })).toHaveLength(1);
    await lifecycle.rollbackConsolidation(userId, proposal!.id);
    expect(await provider.search({ userId, query: "", includeSuperseded: true })).toHaveLength(2);
  });

  it("projects temporal contradictions and provenance into a knowledge graph", async () => {
    const { service, lifecycle } = harness();
    const oldFact = await service.remember({
      userId,
      content: "Deployment is blue",
      tags: ["fact:deployment-color"],
      sourceUri: "https://evidence.test/old",
    });
    const newFact = await service.remember({
      userId,
      content: "Deployment is green",
      tags: ["fact:deployment-color"],
      sourceRunId: "run-new",
    });
    const graph = lifecycle.projectKnowledgeGraph([oldFact, newFact]);
    expect(lifecycle.detectContradictions([oldFact, newFact])).toHaveLength(1);
    expect(graph.nodes.map((node) => node.provenance)).toEqual([
      "https://evidence.test/old",
      "run-new",
    ]);
    expect(graph.edges[0]?.type).toBe("CONTRADICTS");
  });

  it("applies project retention while preserving important and recent records", async () => {
    const now = new Date("2026-10-25T10:00:00Z");
    const oldProvider = new InMemoryMemoryProvider({ now: () => new Date("2025-01-01T00:00:00Z") });
    const oldService = new MemoryService({ provider: oldProvider });
    await oldService.remember({
      userId,
      content: "Disposable atlas note",
      importance: 0.1,
      tags: [projectTag("atlas")],
    });
    await oldService.remember({
      userId,
      content: "Important atlas note",
      importance: 0.9,
      tags: [projectTag("atlas")],
    });
    const lifecycle = new AdvancedMemoryLifecycle({
      provider: oldProvider,
      service: oldService,
      now: () => now,
    });
    await lifecycle.setRetention(userId, {
      projectId: "atlas",
      maxAgeDays: 30,
      minimumImportance: 0.5,
    });
    expect((await lifecycle.applyRetention(userId)).deletedIds).toHaveLength(1);
    expect((await oldProvider.search({ userId, query: "" }))[0]?.record.content).toBe(
      "Important atlas note",
    );
  });

  it("imports a large source with deduplication, secret rejection and cancellation", async () => {
    const { lifecycle } = harness();
    const job = await lifecycle.createImport(userId, 1_002);
    async function* entries() {
      await Promise.resolve();
      for (let index = 0; index < 1_000; index += 1)
        yield { userId, content: `Imported fact ${index}` };
      yield { userId, content: "Imported fact 1" };
      yield { userId, content: "api_key=sk-12345678901234567890" };
    }
    const result = await lifecycle.runImport(userId, job.id, entries());
    expect(result).toMatchObject({
      status: "COMPLETED",
      processed: 1_002,
      stored: 1_000,
      duplicates: 1,
      rejected: 1,
    });

    const cancelled = await lifecycle.createImport(userId, 2);
    async function* cancellable() {
      yield { userId, content: "First cancellable fact" };
      await lifecycle.cancelImport(userId, cancelled.id);
      yield { userId, content: "Never imported" };
    }
    expect((await lifecycle.runImport(userId, cancelled.id, cancellable())).status).toBe(
      "CANCELLED",
    );
  });

  it("restores lifecycle state after restart without storing raw memory content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-memory-lifecycle-"));
    const path = join(directory, "state.json");
    const first = new FileMemoryLifecycleStateStore(path);
    await first.setRetention(userId, { projectId: "atlas", maxAgeDays: 7, minimumImportance: 0.2 });
    await first.setSharing(userId, "memory-1", ["agent-1"]);
    const restarted = new FileMemoryLifecycleStateStore(path);
    expect(await restarted.retention(userId)).toHaveLength(1);
    expect(await restarted.sharing(userId, "memory-1")).toEqual(["agent-1"]);
    expect(await readFile(path, "utf8")).not.toContain("Project Atlas decision");
  });
});

describe("encrypted installation sync", () => {
  it("encrypts payloads, rejects tampering and applies policy-checked updates", async () => {
    const key = new Uint8Array(32).fill(7);
    const sync = new EncryptedMemorySynchronizer(key);
    const events: MemorySyncEvent[] = [
      {
        kind: "upsert",
        memory: { content: "Private synchronized fact", projectId: "atlas", tags: [] },
      },
    ];
    const envelope = sync.encrypt("installation-a", events);
    expect(JSON.stringify(envelope)).not.toContain("Private synchronized fact");
    expect(() =>
      new EncryptedMemorySynchronizer(new Uint8Array(32).fill(8)).decrypt(envelope),
    ).toThrow();
    expect(() =>
      sync.decrypt({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` }),
    ).toThrow();
    const { provider, service } = harness();
    expect(await sync.apply(envelope, { userId, provider, service })).toEqual({
      upserted: 1,
      deleted: 0,
    });
    expect((await provider.search({ userId, query: "" }))[0]?.record.tags).toContain(
      "project:atlas",
    );
  });

  it("propagates deletion and refuses synchronized secrets", async () => {
    const sync = new EncryptedMemorySynchronizer(new Uint8Array(32).fill(4));
    const { provider, service } = harness();
    const stored = await service.remember({ userId, content: "Delete through sync" });
    const deletion = sync.encrypt("installation-a", [{ kind: "delete", memoryId: stored.id }]);
    expect(await sync.apply(deletion, { userId, provider, service })).toEqual({
      upserted: 0,
      deleted: 1,
    });
    const secret = sync.encrypt("installation-a", [
      {
        kind: "upsert",
        memory: { content: "api_key=sk-12345678901234567890", projectId: null, tags: [] },
      },
    ]);
    await expect(sync.apply(secret, { userId, provider, service })).rejects.toThrow(
      "Memory storage refused",
    );
  });
});
