import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabaseClient } from "@nexus/database";
import { makeApi, createAccount } from "./harness.js";

it("reads durable usage through authenticated HTTP and isolates accounts", async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const prisma = createDatabaseClient({ url });
  const harness = await makeApi({ prisma });
  const first = await createAccount(harness, `usage-${randomUUID()}@example.test`);
  const second = await createAccount(harness, `usage-${randomUUID()}@example.test`);
  const users = await prisma.user.findMany({
    where: { id: { in: [first.userId, second.userId] } },
  });
  try {
    const owner = users.find((user) => user.id === first.userId);
    if (!owner) throw new Error("Missing test account");
    await harness.services.runStore.save({
      record: {
        runId: randomUUID(),
        userId: owner.id,
        conversationId: randomUUID(),
        correlationId: randomUUID(),
        startTime: new Date().toISOString(),
        endTime: null,
        status: "completed",
        stopReason: "final_answer",
        iterations: 1,
        toolsUsed: [],
        errors: [],
        usage: { inputTokens: 17, outputTokens: 23 },
        model: "integration-test",
        response: "private response must not be exposed",
        missionExternalKey: null,
      },
      messages: [],
      pendingConfirmation: null,
      consecutiveToolFailures: 0,
      toolCallCount: 0,
      callSignatures: [],
      deadlineAt: 0,
      suspendedAt: null,
    });
    const own = await harness.app.inject({
      method: "GET",
      url: "/api/v1/usage",
      headers: first.authorization,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.runs).toHaveLength(1);
    expect(own.json().data.runs[0]).toMatchObject({ inputTokens: 17, outputTokens: 23 });
    expect(own.body).not.toContain("private response");
    const other = await harness.app.inject({
      method: "GET",
      url: "/api/v1/usage",
      headers: second.authorization,
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().data.runs).toEqual([]);
  } finally {
    await harness.close();
    const cleanup = createDatabaseClient({ url });
    await cleanup.agentRunSnapshot.deleteMany({
      where: { userId: { in: users.map((user) => user.id) } },
    });
    await cleanup.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await cleanup.$disconnect();
  }
});
