import { assignStepIds, createTaskPlan, type TaskCoordinator } from "@nexus/devices";
import { describe, expect, it, vi } from "vitest";
import type { NotificationService } from "../src/services/notification-service.js";
import { TaskSupervisor } from "../src/services/task-supervisor.js";

describe("assignStepIds", () => {
  it("replaces labels with generated ids and repoints dependencies", () => {
    const ids = ["id-a", "id-b"];
    const steps = assignStepIds(
      [
        { id: "step-1", description: "a", requiredCapabilities: ["x"], tool: "t" },
        {
          id: "step-2",
          description: "b",
          requiredCapabilities: ["x"],
          tool: "t",
          dependsOn: ["step-1"],
        },
      ],
      () => ids.shift() ?? "",
    );
    expect(steps.map((step) => step.id)).toEqual(["id-a", "id-b"]);
    expect(steps[1]?.dependsOn).toEqual(["id-a"]);
  });

  it("refuses a plan using one label twice", () => {
    const step = { id: "same", description: "a", requiredCapabilities: ["x"], tool: "t" };
    expect(() => assignStepIds([step, step])).toThrow(/Duplicate/);
  });

  it("leaves an unknown dependency for plan validation to refuse", () => {
    const steps = assignStepIds([
      { id: "a", description: "a", requiredCapabilities: ["x"], tool: "t", dependsOn: ["missing"] },
    ]);
    expect(() =>
      createTaskPlan({
        userId: "u",
        title: "t",
        originClientDeviceId: "d",
        correlationId: "c",
        steps,
      }),
    ).toThrow();
  });
});

describe("TaskSupervisor after the request was accepted", () => {
  const plan = createTaskPlan({
    userId: "u",
    title: "t",
    originClientDeviceId: "d",
    correlationId: "c",
    steps: assignStepIds([{ description: "a", requiredCapabilities: ["x"], tool: "t" }]),
  });
  const notifications = {
    notifyTaskOutcome: () => Promise.resolve(),
  } as unknown as NotificationService;
  const broken = {
    execute: () => Promise.reject(new Error("storage down")),
  } as unknown as TaskCoordinator;

  it("reports a failure instead of losing the task silently", async () => {
    const reportFailure = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    const supervisor = new TaskSupervisor({
      coordinator: broken,
      notifications,
      reportFailure,
      onError,
    });

    supervisor.start(plan, []);

    await vi.waitFor(() => {
      expect(reportFailure).toHaveBeenCalledWith(plan);
    });
    expect(onError).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(supervisor.runningCount).toBe(0);
    });
  });

  it("survives a failure of the report itself", async () => {
    const reportFailure = vi.fn(() => Promise.reject(new Error("still down")));
    const onError = vi.fn();
    const supervisor = new TaskSupervisor({
      coordinator: broken,
      notifications,
      reportFailure,
      onError,
    });

    supervisor.start(plan, []);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(supervisor.runningCount).toBe(0);
    });
  });
});
