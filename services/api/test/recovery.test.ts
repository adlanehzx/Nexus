import { describe, it, expect, vi } from "vitest";
import type {
  StepStatus,
  TaskCoordinatorOptions,
  TaskPlan,
  TaskStatus,
  TaskStep,
} from "@nexus/devices";
import { TaskCoordinator, InMemoryTaskStore } from "@nexus/devices";
import { uuidv7 } from "@nexus/shared";

describe("Phase 5 - Recovery", () => {
  const mockNow = new Date("2024-01-01T12:00:00Z");
  // Test doubles only supply what recover() touches. Typing them this way
  // rather than any retains check integrity on these methods.
  const createBaseOptions = () => ({
    registry: { get: vi.fn() } as unknown as TaskCoordinatorOptions["registry"],
    selector: { select: vi.fn() } as unknown as TaskCoordinatorOptions["selector"],
    router: {
      route: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as TaskCoordinatorOptions["router"],
    transport: { send: vi.fn() } as unknown as TaskCoordinatorOptions["transport"],
    now: () => mockNow,
    newId: uuidv7,
  });

  const createPlan = (status: TaskStatus, stepStatus: StepStatus): TaskPlan => ({
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
        timeoutMs: 10_000,
        dependsOn: [],
        // Completed rather than asserted to conform with domain types.
        selectedDeviceId: null,
        preferredDeviceId: null,
        retry: { attempts: 1, backoffMs: 1_000, failoverToAnotherDevice: false },
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
      } satisfies TaskStep,
    ],
  });

  it("Test 1 — Task COMPLETED: Does not re-run completed task", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("succeeded", "succeeded");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("succeeded");
  });

  it("Test 2 — Task QUEUED: Restores task", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("pending", "pending");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    const executeSpy = vi.spyOn(coordinator, "execute").mockResolvedValue(plan);
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("pending");
    expect(executeSpy).toHaveBeenCalled();
  });

  it("Test 3 — Task RUNNING: Detects interruption", async () => {
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

  it("Test 4 — Task FAILED: Remains failed", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("failed", "failed");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("failed");
  });

  it("Test 5 — Task CANCELLED: Does not re-run", async () => {
    const store = new InMemoryTaskStore();
    const plan = createPlan("cancelled", "cancelled");
    await store.save(plan);

    const coordinator = new TaskCoordinator({ ...createBaseOptions(), store });
    await coordinator.recover();

    const recovered = await store.get(plan.id);
    expect(recovered?.status).toBe("cancelled");
  });

  it("Test 9 — Duplicate recovery: Is idempotent", async () => {
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
