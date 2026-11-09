import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabaseClient } from "@nexus/database";
import { InMemoryOsintCaseStore, osintMissionInputSchema } from "@nexus/osint";
import { PrismaOsintStore } from "../src/services/persistence/prisma-osint-store.js";

it("round-trips OSINT case and mission snapshots through PostgreSQL", async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for OSINT PostgreSQL integration tests");
  const prisma = createDatabaseClient({ url: process.env.DATABASE_URL });
  const store = new PrismaOsintStore(prisma);
  const owner = randomUUID();
  const id = randomUUID();
  const record = new InMemoryOsintCaseStore().create(owner, {
    title: "PG OSINT fixture",
    kind: "technical_asset",
    target: "example.org",
    objective: "Verify public source persistence",
    maxSources: 12,
    lawfulPurposeConfirmed: true,
  });
  try {
    await store.saveCase(record);
    expect((await store.loadCases()).find((r) => r.id === record.id)).toEqual(record);
    const input = osintMissionInputSchema.parse({
      title: "PG mission",
      targets: [{ type: "domain", value: "example.org" }],
      lawfulPurposeConfirmed: true,
    });
    const now = new Date().toISOString();
    await store.saveMission({
      id,
      ownerId: owner,
      caseId: record.id,
      input,
      status: "paused",
      createdAt: now,
      updatedAt: now,
      deadline: Date.now() + 300000,
      iterations: 0,
      tokens: 0,
      plan: [],
      frontier: [],
      visited: [],
      timeline: [{ at: now, action: "pause", detail: "fixture" }],
    });
    expect((await store.loadMissions()).find((m) => m.id === id)?.timeline[0]?.action).toBe(
      "pause",
    );
  } finally {
    await prisma.osintMissionSnapshot.deleteMany({ where: { ownerId: owner } });
    await prisma.osintCaseSnapshot.deleteMany({ where: { ownerId: owner } });
    await prisma.$disconnect();
  }
});
