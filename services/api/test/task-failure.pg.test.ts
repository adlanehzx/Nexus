import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import { assignStepIds, createTaskPlan } from "@nexus/devices";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaTaskStore } from "../src/services/persistence/prisma-task-store.js";

/** The bug this guards was only visible on real storage: the memory store accepts any id. */
describe("a plan labelled step-1 on PostgreSQL", () => {
  let prisma: PrismaClient;
  let store: PrismaTaskStore;
  let userId: string;
  let deviceId: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (url === undefined) throw new Error("DATABASE_URL required");
    prisma = createDatabaseClient({ url });
    store = new PrismaTaskStore(prisma);
    userId = randomUUID();
    deviceId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        displayName: "Planner",
      },
    });
    await prisma.device.create({
      data: {
        id: deviceId,
        userId,
        name: "phone",
        role: "CLIENT",
        type: "ANDROID",
        platform: "ANDROID",
      },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const labelled = [
    { id: "step-1", description: "a", requiredCapabilities: ["x"], tool: "device.x" },
    {
      id: "step-2",
      description: "b",
      requiredCapabilities: ["x"],
      tool: "device.x",
      dependsOn: ["step-1"],
    },
  ];

  it("is stored and listed, with its dependency intact", async () => {
    const plan = createTaskPlan({
      userId,
      title: "labelled",
      originClientDeviceId: deviceId,
      correlationId: randomUUID(),
      steps: assignStepIds(labelled),
    });
    await store.save(plan);

    const [listed] = await store.listByUser(userId);
    expect(listed?.id).toBe(plan.id);
    const first = plan.steps[0];
    const second = listed?.steps.find((step) => step.id === plan.steps[1]?.id);
    expect(second?.dependsOn).toEqual([first?.id]);
  });

  it("would have been refused without generated ids", async () => {
    const plan = createTaskPlan({
      userId,
      title: "raw",
      originClientDeviceId: deviceId,
      correlationId: randomUUID(),
      steps: labelled,
    });
    await expect(store.save(plan)).rejects.toThrow();
  });
});
