import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import type { TaskPlan } from "@nexus/devices";
import { PrismaTaskStore } from "../src/services/persistence/prisma-task-store.js";
import { PrismaAgentRunStore } from "../src/services/persistence/prisma-agent-run-store.js";
import { PrismaUserStore } from "../src/services/persistence/prisma-user-store.js";
import { PrismaDeviceStore } from "../src/services/persistence/prisma-device-store.js";
import { PrismaAgentRunClaimStore } from "../src/services/persistence/prisma-agent-run-claim-store.js";
import { PrismaMissionGrantRegistry } from "../src/services/persistence/prisma-mission-grant-registry.js";
import { PrismaScheduleGrantRegistry } from "../src/services/persistence/prisma-schedule-grant-registry.js";
import { PrismaDeviceCredentialStore } from "../src/services/persistence/prisma-device-credential-store.js";

/**
 * Prisma stores against real PostgreSQL.
 *
 * Verifies real queries, constraints, enum casing, and foreign keys against Postgres.
 */

const DATABASE_URL = process.env.DATABASE_URL;

/** Identifiers for this test run. */
const deviceId = randomUUID();
const planId = randomUUID();
const stepId = randomUUID();
const executionId = randomUUID();
const runId = randomUUID();
const email = `pg-${randomUUID()}@example.test`;

let ownerId: string;
let prisma: PrismaClient;

beforeAll(async () => {
  if (DATABASE_URL === undefined) {
    throw new Error(
      "DATABASE_URL is required: these tests write to a real PostgreSQL. " + "See pnpm test:pg.",
    );
  }
  prisma = createDatabaseClient({ url: DATABASE_URL });

  const owner = await new PrismaUserStore(prisma).create({
    email,
    displayName: "PostgreSQL Integration",
    passwordHash: "scrypt$65536$8$1$aaaa$bbbb",
  });
  ownerId = owner.id;

  await new PrismaDeviceStore(prisma).save({
    id: deviceId,
    userId: ownerId,
    name: "Test Workstation",
    type: "LINUX",
    platform: "LINUX",
    role: "WORKER",
    status: "ONLINE",
    trust: "TRUSTED",
    agentVersion: "1.0.0",
    health: { activeTasks: 0, maxConcurrentTasks: 1 },
    grantedPermissions: [],
    metadata: {},
    capabilities: [
      {
        name: "shell.exec",
        version: "1.0.0",
        description: "Executes a command",
        enabled: true,
        metadata: {},
      },
    ],
    lastSeenAt: null,
    pairedAt: new Date(),
    revokedAt: null,
    authenticated: false,
  });
});

afterAll(async () => {
  if (prisma === undefined) return;
  await prisma.taskExecution.deleteMany({ where: { taskId: planId } });
  await prisma.taskStep.deleteMany({ where: { taskId: planId } });
  await prisma.taskPlan.deleteMany({ where: { id: planId } });
  await prisma.agentCoreRunClaim.deleteMany({ where: { userId: ownerId } });
  await prisma.missionGrant.deleteMany({ where: { userId: ownerId } });
  await prisma.scheduleGrant.deleteMany({ where: { userId: ownerId } });
  await prisma.agentRunSnapshot.deleteMany({ where: { userId: ownerId } });
  await prisma.deviceCredential.deleteMany({ where: { deviceId } });
  await prisma.deviceCapability.deleteMany({ where: { deviceId } });
  await prisma.device.deleteMany({ where: { id: deviceId } });
  await prisma.authCredential.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: planId,
    userId: ownerId,
    title: "Update repository",
    originClientDeviceId: deviceId,
    runId: null,
    conversationId: null,
    correlationId: `corr-${planId}`,
    status: "pending",
    createdAt: new Date("2026-10-20T09:00:00.000Z").toISOString(),
    startedAt: null,
    completedAt: null,
    metadata: { source: "integration" },
    steps: [
      {
        id: stepId,
        description: "Clone repository",
        requiredCapabilities: ["shell.exec"],
        tool: "shell.exec",
        arguments: { cmd: "git clone" },
        dependsOn: [],
        selectedDeviceId: null,
        preferredDeviceId: null,
        riskLevel: "MEDIUM",
        retry: { attempts: 2, backoffMs: 500, failoverToAnotherDevice: true },
        timeoutMs: 10_000,
        status: "pending",
        attempt: 0,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

describe("Task store on PostgreSQL", () => {
  it("writes a plan that the database accepts and reads it back identically", async () => {
    const store = new PrismaTaskStore(prisma);
    const original = plan();

    await store.save(original);
    const reread = await store.get(planId);

    expect(reread).toBeDefined();
    expect(reread?.status).toBe("pending");
    expect(reread?.metadata).toEqual({ source: "integration" });
    expect(reread?.steps).toHaveLength(1);
    const step = reread?.steps[0];
    expect(step?.status).toBe("pending");
    expect(step?.retry).toEqual({ attempts: 2, backoffMs: 500, failoverToAnotherDevice: true });
    expect(step).not.toHaveProperty("retryPolicy");
    expect(typeof reread?.createdAt).toBe("string");
  });

  it("actually stores statuses in enum casing", async () => {
    const store = new PrismaTaskStore(prisma);
    await store.save(plan({ status: "running" }));

    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM task_plans WHERE id = $1`,
      planId,
    );
    expect(rows[0]?.status).toBe("RUNNING");
  });

  it("advances state of a task and its step", async () => {
    const store = new PrismaTaskStore(prisma);
    const advanced = plan({
      status: "succeeded",
      startedAt: new Date("2026-10-20T09:01:00.000Z").toISOString(),
      completedAt: new Date("2026-10-20T09:02:00.000Z").toISOString(),
    });
    advanced.steps[0] = {
      ...advanced.steps[0]!,
      status: "succeeded",
      attempt: 1,
      selectedDeviceId: deviceId,
      result: { ok: true },
      startedAt: new Date("2026-10-20T09:01:00.000Z").toISOString(),
      completedAt: new Date("2026-10-20T09:02:00.000Z").toISOString(),
    };

    await store.save(advanced);
    const reread = await store.get(planId);

    expect(reread?.status).toBe("succeeded");
    expect(reread?.completedAt).toBe("2026-10-20T09:02:00.000Z");
    expect(reread?.steps[0]?.status).toBe("succeeded");
    expect(reread?.steps[0]?.attempt).toBe(1);
    expect(reread?.steps[0]?.selectedDeviceId).toBe(deviceId);
    expect(reread?.steps[0]?.result).toEqual({ ok: true });
  });

  it("writes and reads back an execution", async () => {
    const store = new PrismaTaskStore(prisma);
    await store.saveExecution({
      id: executionId,
      taskId: planId,
      stepId,
      deviceId,
      attempt: 1,
      status: "failed",
      startedAt: new Date("2026-10-20T09:01:00.000Z").toISOString(),
      completedAt: new Date("2026-10-20T09:01:30.000Z").toISOString(),
      durationMs: 30_000,
      input: { cmd: "git clone" },
      result: null,
      error: { code: "E_SHELL", message: "exit 1", retryable: true },
    });

    const executions = await store.listExecutions(planId);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("failed");
    expect(executions[0]?.error).toEqual({
      code: "E_SHELL",
      message: "exit 1",
      retryable: true,
    });
    expect(executions[0]?.durationMs).toBe(30_000);
  });

  it("finds task by user and by active state", async () => {
    const store = new PrismaTaskStore(prisma);
    await store.save(plan({ status: "running" }));

    const mine = await store.listByUser(ownerId, 10);
    expect(mine.map((item) => item.id)).toContain(planId);

    const active = await store.listActive();
    expect(active.map((item) => item.id)).toContain(planId);

    await store.save(plan({ status: "succeeded" }));
    const stillActive = await store.listActive();
    expect(stillActive.map((item) => item.id)).not.toContain(planId);
  });

  it("lets database reject a status outside enum", async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE task_plans SET status = 'succeeded' WHERE id = $1`, planId),
    ).rejects.toThrow();
  });

  it("lets database reject a task without origin device", async () => {
    const store = new PrismaTaskStore(prisma);
    const orphan = plan({ id: randomUUID(), originClientDeviceId: randomUUID() });
    await expect(store.save(orphan)).rejects.toThrow();
  });
});

describe("Agent Core run store on PostgreSQL", () => {
  it("persists a run and its mission, then reads it back", async () => {
    const store = new PrismaAgentRunStore(prisma);
    const state = {
      record: {
        runId,
        userId: ownerId,
        conversationId: randomUUID(),
        correlationId: `corr-${runId}`,
        startTime: new Date("2026-10-20T09:00:00.000Z").toISOString(),
        endTime: null,
        status: "waiting_for_confirmation" as const,
        stopReason: null,
        iterations: 1,
        toolsUsed: [],
        errors: [],
        usage: { inputTokens: 10, outputTokens: 20 },
        model: "test",
        response: null,
        missionExternalKey: "nexus-integration-mission",
      },
      messages: [],
      pendingConfirmation: null,
      consecutiveToolFailures: 0,
      toolCallCount: 0,
      callSignatures: [],
      deadlineAt: 0,
      suspendedAt: null,
    };

    await store.save(state);
    const loaded = await store.load(runId);

    expect(loaded?.record.status).toBe("waiting_for_confirmation");
    expect(loaded?.record.missionExternalKey).toBe("nexus-integration-mission");

    const rows = await prisma.$queryRawUnsafe<{ key: string | null }[]>(
      `SELECT "missionExternalKey" AS key FROM agent_run_snapshots WHERE id = $1`,
      runId,
    );
    expect(rows[0]?.key).toBe("nexus-integration-mission");
  });

  it("updates an existing run without creating a second one", async () => {
    const store = new PrismaAgentRunStore(prisma);
    const loaded = await store.require(runId);
    loaded.record.status = "completed";
    loaded.record.response = "done";

    await store.save(loaded);

    const reread = await store.require(runId);
    expect(reread.record.status).toBe("completed");
    expect(reread.record.response).toBe("done");
    const count = await prisma.agentRunSnapshot.count({ where: { userId: ownerId } });
    expect(count).toBe(1);
  });

  it("lets database reject a run without owner", async () => {
    const store = new PrismaAgentRunStore(prisma);
    const orphan = await store.require(runId);
    orphan.record.runId = randomUUID();
    orphan.record.userId = randomUUID();

    await expect(store.save(orphan)).rejects.toThrow();
  });
});

describe("Agent Core run claims on PostgreSQL", () => {
  const mission = "nexus-uniqueness-mission";

  it("grants claim once and returns existing thereafter", async () => {
    const store = new PrismaAgentRunClaimStore(prisma);
    const key = { missionExternalKey: mission, taskKey: "task", attemptId: "attempt-1" };
    const first = randomUUID();

    expect(await store.claim({ ...key, runId: first, userId: ownerId })).toEqual({
      claimed: true,
    });

    const second = await store.claim({ ...key, runId: randomUUID(), userId: ownerId });
    expect(second.claimed).toBe(false);
    expect(second.claimed === false && second.existing.runId).toBe(first);
  });

  it("arbitrates in favor of a single caller under real concurrency", async () => {
    const store = new PrismaAgentRunClaimStore(prisma);
    const key = { missionExternalKey: mission, taskKey: "concurrent", attemptId: "attempt-1" };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim({ ...key, runId: randomUUID(), userId: ownerId }),
      ),
    );

    expect(results.filter((item) => item.claimed)).toHaveLength(1);
    const winner = await store.find(key);
    const granted = results.find((item) => item.claimed === false);
    expect(granted?.claimed === false && granted.existing.runId).toBe(winner?.runId);
  });

  it("separates claims by task, attempt, and mission", async () => {
    const store = new PrismaAgentRunClaimStore(prisma);
    const base = { userId: ownerId, runId: randomUUID() };

    for (const key of [
      { missionExternalKey: mission, taskKey: "a", attemptId: "attempt-1" },
      { missionExternalKey: mission, taskKey: "b", attemptId: "attempt-1" },
      { missionExternalKey: mission, taskKey: "a", attemptId: "attempt-2" },
      { missionExternalKey: `${mission}-bis`, taskKey: "a", attemptId: "attempt-1" },
    ]) {
      expect(await store.claim({ ...base, ...key, runId: randomUUID() })).toEqual({
        claimed: true,
      });
    }
  });

  it("lets database reject duplicate inserted outside store", async () => {
    const duplicate = prisma.agentCoreRunClaim.create({
      data: {
        id: randomUUID(),
        missionExternalKey: mission,
        taskKey: "concurrent",
        attemptId: "attempt-1",
        runId: randomUUID(),
        userId: ownerId,
      },
    });
    await expect(duplicate).rejects.toThrow();
  });
});

describe("Assertion registry on PostgreSQL", () => {
  const mission = "nexus-registry-mission";

  it("records, reads back, and retires", async () => {
    const registry = new PrismaMissionGrantRegistry(prisma);
    const grantId = randomUUID();
    const expiresAt = new Date(Date.now() + 86_400_000);

    await registry.record({
      grantId,
      missionExternalKey: mission,
      userId: ownerId,
      service: "mission-engine",
      issuedAt: new Date(),
      expiresAt,
    });

    expect(await registry.find(grantId)).toMatchObject({
      grantId,
      status: "ACTIVE",
      retiredAt: null,
    });

    const at = new Date();
    expect(await registry.retireMission(mission, "COMPLETED", at)).toBe(1);
    expect(await registry.find(grantId)).toMatchObject({ status: "COMPLETED" });
    expect(await registry.retireMission(mission, "COMPLETED", new Date())).toBe(0);
  });

  it("retires all active assertions of a mission in a single write", async () => {
    const registry = new PrismaMissionGrantRegistry(prisma);
    const rotated = `${mission}-rotation`;
    for (let index = 0; index < 3; index += 1) {
      await registry.record({
        grantId: randomUUID(),
        missionExternalKey: rotated,
        userId: ownerId,
        service: "mission-engine",
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }

    expect(await registry.retireMission(rotated, "REVOKED", new Date())).toBe(3);
    const all = await registry.listByMission(rotated);
    expect(all.every((grant) => grant.status === "REVOKED")).toBe(true);
    expect(all.every((grant) => grant.retiredAt !== null)).toBe(true);
  });

  it("lets database reject contradictory state and timestamp", async () => {
    const invalid = prisma.missionGrant.create({
      data: {
        id: randomUUID(),
        missionExternalKey: mission,
        userId: ownerId,
        service: "mission-engine",
        expiresAt: new Date(Date.now() + 86_400_000),
        status: "ACTIVE",
        retiredAt: new Date(),
      },
    });
    await expect(invalid).rejects.toThrow();
  });
});

describe("Schedule grants on PostgreSQL", () => {
  it("retains only the hash, links schedule, and revokes atomically", async () => {
    const registry = new PrismaScheduleGrantRegistry(prisma);
    const id = randomUUID();
    const scheduleId = randomUUID();
    const tokenHash = "a".repeat(64);
    await registry.record({
      id,
      tokenHash,
      userId: ownerId,
      missionExternalKey: "nexus-scheduled-pg",
      scheduleId,
      status: "ACTIVE",
      createdAt: new Date(),
      revokedAt: null,
    });

    expect(await registry.findByTokenHash(tokenHash)).toMatchObject({
      id,
      scheduleId,
      status: "ACTIVE",
    });
    await registry.revoke(id, new Date());
    expect(await registry.findByTokenHash(tokenHash)).toMatchObject({
      status: "REVOKED",
    });
  });

  it("lets PostgreSQL reject two grants for the same schedule", async () => {
    const scheduleId = randomUUID();
    const base = {
      userId: ownerId,
      missionExternalKey: "nexus-scheduled-unique",
      scheduleId,
      status: "ACTIVE" as const,
      createdAt: new Date(),
      revokedAt: null,
    };
    await prisma.scheduleGrant.create({
      data: { ...base, id: randomUUID(), tokenHash: "b".repeat(64) },
    });
    await expect(
      prisma.scheduleGrant.create({
        data: { ...base, id: randomUUID(), tokenHash: "c".repeat(64) },
      }),
    ).rejects.toThrow();
  });
});

describe("PrismaDeviceCredentialStore", () => {
  const ed25519 = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;

  it("writes, reads back, and survives a new instance", async () => {
    await new PrismaDeviceCredentialStore(prisma).set(deviceId, ed25519);

    const afterRestart = new PrismaDeviceCredentialStore(prisma);
    expect(await afterRestart.publicKeyFor(deviceId)).toBe(ed25519);
  });

  it("infers algorithm from key, not from provided label", async () => {
    const store = new PrismaDeviceCredentialStore(prisma);
    await store.set(deviceId, ed25519);
    const first = await prisma.deviceCredential.findFirst({
      where: { deviceId, revokedAt: null },
    });
    expect(first?.kind).toBe("ED25519_PUBLIC_KEY");

    await store.set(deviceId, p256);
    const second = await prisma.deviceCredential.findFirst({
      where: { deviceId, revokedAt: null },
    });
    expect(second?.kind).toBe("ECDSA_P256_PUBLIC_KEY");
    expect(await store.publicKeyFor(deviceId)).toBe(p256);
  });

  it("rotation leaves a single active key and keeps trace of legacy", async () => {
    const store = new PrismaDeviceCredentialStore(prisma);
    await store.set(deviceId, ed25519);
    await store.set(deviceId, p256);

    const active = await prisma.deviceCredential.findMany({ where: { deviceId, revokedAt: null } });
    expect(active).toHaveLength(1);

    const rotated = await prisma.deviceCredential.findMany({
      where: { deviceId, rotatedAt: { not: null } },
    });
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    expect(rotated[0]?.material).toBe(ed25519);
  });

  it("revoking makes key invisible without deleting row", async () => {
    const store = new PrismaDeviceCredentialStore(prisma);
    await store.set(deviceId, ed25519);
    await store.revoke(deviceId);

    expect(await store.publicKeyFor(deviceId)).toBeUndefined();
    const rows = await prisma.deviceCredential.findMany({ where: { deviceId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("ignores an expired key", async () => {
    await new PrismaDeviceCredentialStore(prisma).set(deviceId, ed25519);
    await prisma.deviceCredential.updateMany({
      where: { deviceId, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await new PrismaDeviceCredentialStore(prisma).publicKeyFor(deviceId)).toBeUndefined();
  });

  it("rejects PEM that is not a key", async () => {
    const store = new PrismaDeviceCredentialStore(prisma);
    await expect(store.set(deviceId, "not a key")).rejects.toThrow(/PEM/);
    await store.set(deviceId, ed25519);
    await expect(
      store.set(deviceId, "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"),
    ).rejects.toThrow();
    expect(await store.publicKeyFor(deviceId)).toBe(ed25519);
  });

  afterEach(async () => {
    await prisma.deviceCredential.deleteMany({ where: { deviceId } });
  });
});
