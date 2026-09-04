import { describe, it, expect, vi } from "vitest";
import type { TaskPlan } from "@nexus/devices";
import { TaskCoordinator, InMemoryTaskStore } from "@nexus/devices";
import { uuidv7 } from "@nexus/shared";

describe("Phase 5 - Recovery", () => {
  const mockNow = new Date("2024-01-01T12:00:00Z");
  const createBaseOptions = () => ({
    registry: { get: vi.fn() } as any,
    selector: { select: vi.fn() } as any,
    router: { route: vi.fn(), subscribe: vi.fn() } as any,
    transport: { send: vi.fn() } as any,
    now: () => mockNow,
    newId: uuidv7,
  });

  const createPlan = (status: any, stepStatus: any): TaskPlan => ({
    id: uuidv7(),
    userId: "user-1",
    title: "Test Task",
    status,
    originClientDeviceId: "device-1",
    createdAt: mockNow.toISOString(),
    startedAt: mockNow.toISOString(),
    conversationId: null,
    correlationId: "corr-1",
    metadata: {},
    completedAt: null,
    runId: null,
    steps: [
      {
        id: uuidv7(),
        description: "Step 1",
        tool: "dummy",
        requiredCapabilities: [],
        arguments: {},
        status: stepStatus,
        attempt: 0,
        riskLevel: "LOW",
        timeoutMs: 10000,
        dependsOn: [],
      } as any,
    ],
  });

  it("Test 1 — Task COMPLETED: Ne relance pas une tâche terminée", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("succeeded", "succeeded");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("succeeded");
  });

  it("Test 2 — Task QUEUED: Restaure la tâche", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("pending", "pending");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    const executeSpy = vi.spyOn(coordinator, "execute").mockImplementation(async () => plan);
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("pending");
    expect(executeSpy).toHaveBeenCalled();
  });

  it("Test 3 — Task RUNNING: Détecte l'interruption", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("running", "running");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered!.steps[0]!.status).toBe("failed");
    expect(recovered!.steps[0]!.error).toBeDefined();
  });

  it("Test 4 — Task FAILED: Reste failed", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("failed", "failed");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("failed");
  });

  it("Test 5 — Task CANCELLED: Ne pas relancer", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("cancelled", "cancelled");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("cancelled");
  });

  it("Test 9 — Duplicate recovery: Est idempotent", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("running", "running");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();
    
    const recovered1 = await store.get(plan.id);
    expect(recovered1?.status).toBe("failed");
    const completedAt1 = recovered1!.steps[0]!.completedAt;

    await coordinator.recover();
    
    const recovered2 = await store.get(plan.id);
    expect(recovered2?.status).toBe("failed");
    expect(recovered2!.steps[0]!.completedAt).toBe(completedAt1);
  });
});
