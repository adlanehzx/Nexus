/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument --
   Test doubles implement async/Promise-returning interfaces without awaiting and use loose fetch mocks. */
import { expect, it, vi } from "vitest";
import type { PrismaClient } from "@nexus/database";
import { InMemoryOsintCaseStore } from "@nexus/osint";
import { PrismaOsintStore } from "../src/services/persistence/prisma-osint-store.js";
import { OsintService } from "../src/services/osint-service.js";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("imports a real legacy JSON file once, preserves newer PostgreSQL data and switches writes to Prisma", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nexus-osint-import-"));
  try {
    const runtime = new RuntimeConfigurationStore(dir);
    const legacy = new InMemoryOsintCaseStore();
    const record = legacy.create("owner", {
      title: "Legacy investigation",
      kind: "organization",
      target: "Example",
      objective: "Verify public corporate records",
      maxSources: 12,
      lawfulPurposeConfirmed: true,
    });
    await runtime.saveOsintCases(legacy.snapshot());
    const rows = new Map<string, { payload: unknown }>();
    let imported = false;
    const fake = {
      osintCaseSnapshot: {
        upsert: vi.fn(async ({ where, create, update }) => {
          if (!rows.has(where.id)) rows.set(where.id, create);
          else if (update.payload) rows.set(where.id, update);
        }),
        findMany: vi.fn(async () => [...rows.values()]),
      },
      osintImport: {
        findUnique: vi.fn(async () => (imported ? { id: "osint-cases.json" } : null)),
        create: vi.fn(async () => {
          imported = true;
        }),
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(fake),
    };
    const persistence = new PrismaOsintStore(fake as unknown as PrismaClient);
    const first = new OsintService({ runtime, persistence });
    expect((await first.list("owner"))[0]?.id).toBe(record.id);
    await first.addEntity("owner", record.id, {
      type: "domain",
      label: "example.org",
      confidence: 0.5,
    });
    const second = new OsintService({ runtime, persistence });
    expect((await second.get("owner", record.id))?.entities).toHaveLength(1);
    expect(fake.osintImport.create).toHaveBeenCalledOnce();
    expect((await runtime.loadOsintCases())[0]?.entities).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
