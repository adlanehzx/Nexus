import { describe, expect, it, vi } from "vitest";
import { routeEngines, TaskBoundaryEngineRouter, type EngineDescriptor } from "../src/routing.js";

function engine(overrides: Partial<EngineDescriptor> = {}): EngineDescriptor {
  return {
    id: "local",
    transport: "local",
    quality: 80,
    latencyMs: 100,
    costPerMillionTokens: 0,
    maxContextTokens: 32_000,
    privacy: "local_only",
    quotaRemainingPercent: null,
    available: true,
    ...overrides,
  };
}

describe("engine routing", () => {
  it("routes across all required factors and keeps missing quota explicitly unknown", () => {
    const decision = routeEngines(
      [
        engine(),
        engine({
          id: "cloud",
          transport: "cloud",
          quality: 95,
          latencyMs: 50,
          costPerMillionTokens: 3,
          privacy: "external_cloud",
          quotaRemainingPercent: 80,
        }),
        engine({ id: "exhausted", quotaRemainingPercent: 0 }),
        engine({ id: "small", maxContextTokens: 1_000 }),
      ],
      { requiredContextTokens: 8_000, privacy: "local_only" },
    );

    expect(decision.selectedEngineId).toBe("local");
    expect(decision.quotaStates.local).toBe("unknown");
    expect(decision.rejected.cloud).toContain("privacy_boundary");
    expect(decision.rejected.exhausted).toContain("quota_exhausted");
    expect(decision.rejected.small).toContain("context_too_small");
  });

  it("persists the decision before returning a task-boundary migration", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const router = new TaskBoundaryEngineRouter({ persist });
    const decision = await router.select("task-1", 2, [engine()], {
      requiredContextTokens: 1_000,
      privacy: "external_cloud",
    });
    expect(decision.selectedEngineId).toBe("local");
    expect(persist).toHaveBeenCalledWith({ taskId: "task-1", boundary: 2, decision });
    await expect(
      router.select("task-1", -1, [engine()], {
        requiredContextTokens: 1_000,
        privacy: "external_cloud",
      }),
    ).rejects.toThrow("persisted task boundary");
  });
});
