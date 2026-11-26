import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import { PrismaSessionStore } from "../src/services/persistence/prisma-session-store.js";
import { PrismaUserStore } from "../src/services/persistence/prisma-user-store.js";
import type { UserSession } from "../src/services/stores.js";

let prisma: PrismaClient;
const users: string[] = [];
beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("A disposable DATABASE_URL is required");
  prisma = createDatabaseClient({ url });
});
afterAll(async () => {
  if (!prisma) return;
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.authCredential.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

describe("atomic authentication on PostgreSQL", () => {
  it("serializes first-admin assignment across concurrent registrations", async () => {
    const before = await prisma.user.count();
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new PrismaUserStore(prisma).create({
          email: `atomic-${randomUUID()}@example.test`,
          displayName: `User ${i}`,
          passwordHash: "test-only",
        }),
      ),
    );
    users.push(...created.map((user) => user.id));
    expect(created.filter((user) => user.role === "ADMIN")).toHaveLength(before === 0 ? 1 : 0);
  });

  it("has one winner and rolls back consumption when successor insertion fails", async () => {
    const store = new PrismaSessionStore(prisma);
    const userId = users[0]!;
    const now = new Date();
    const session = (): UserSession => ({
      id: randomUUID(),
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      refreshTokenHash: randomUUID(),
    });
    const original = session();
    await store.create(original);
    const next = Array.from({ length: 8 }, session);
    const results = await Promise.all(
      next.map((successor) => store.rotate(original.id, now, successor)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.session.count({ where: { userId, revokedAt: null } })).toBe(1);
    const winner = next[results.indexOf(true)]!;
    await expect(store.rotate(winner.id, now, { ...session(), id: original.id })).rejects.toThrow();
    expect((await store.get(winner.id))?.revokedAt).toBeNull();
    expect(await store.rotate(winner.id, now, session())).toBe(true);
  });
});
