import { describe, expect, it } from "vitest";
import { stepStatusSchema, taskStatusSchema } from "@nexus/devices";
import {
  executionFromRow,
  planFromRow,
  planStatusFromDb,
  planStatusToDb,
  stepFromRow,
  stepStatusFromDb,
  stepStatusToDb,
  stepToRow,
  type TaskExecutionRow,
  type TaskPlanRow,
  type TaskStepRow,
} from "../src/services/persistence/task-mapping.js";

/**
 * Domain <-> PostgreSQL correspondence for tasks.
 *
 * Verifies case mapping between lowercase domain statuses and uppercase PostgreSQL enums.
 */

const PLAN_ENUM = [
  "PENDING",
  "RUNNING",
  "WAITING_FOR_CONFIRMATION",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "PARTIAL",
];

const STEP_ENUM = [
  "PENDING",
  "READY",
  "ASSIGNED",
  "RUNNING",
  "WAITING_FOR_CONFIRMATION",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
];

describe("task statuses", () => {
  it("translates every domain status to an accepted enum value", () => {
    for (const status of taskStatusSchema.options) {
      expect(PLAN_ENUM).toContain(planStatusToDb(status));
    }
    for (const status of stepStatusSchema.options) {
      expect(STEP_ENUM).toContain(stepStatusToDb(status));
    }
  });

  it("round-trips without loss", () => {
    for (const status of taskStatusSchema.options) {
      expect(planStatusFromDb(planStatusToDb(status))).toBe(status);
    }
    for (const status of stepStatusSchema.options) {
      expect(stepStatusFromDb(stepStatusToDb(status))).toBe(status);
    }
  });

  it("covers entire database enum", () => {
    const produced = taskStatusSchema.options.map(planStatusToDb);
    expect([...produced].sort()).toEqual([...PLAN_ENUM].sort());
    const steps = stepStatusSchema.options.map(stepStatusToDb);
    expect([...steps].sort()).toEqual([...STEP_ENUM].sort());
  });

  it("does not preserve domain casing", () => {
    expect(planStatusToDb("succeeded")).toBe("SUCCEEDED");
    expect(stepStatusToDb("waiting_for_confirmation")).toBe("WAITING_FOR_CONFIRMATION");
  });

  it("reads unknown status as failure rather than propagating it", () => {
    expect(planStatusFromDb("THIS_STATUS_DOES_NOT_EXIST")).toBe("failed");
    expect(stepStatusFromDb("")).toBe("failed");
  });
});

function stepRow(overrides: Partial<TaskStepRow> = {}): TaskStepRow {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    description: "Clone repository",
    requiredCapabilities: ["shell.exec"],
    tool: "shell.exec",
    arguments: { cmd: "git clone" },
    dependsOn: [],
    selectedDeviceId: null,
    preferredDeviceId: null,
    constraints: null,
    riskLevel: "MEDIUM",
    retryPolicy: { attempts: 2, backoffMs: 500, failoverToAnotherDevice: true },
    timeoutMs: 1_000,
    status: "SUCCEEDED",
    attempt: 1,
    result: { ok: true },
    error: null,
    startedAt: new Date("2026-10-20T10:00:00.000Z"),
    completedAt: new Date("2026-10-20T10:00:05.000Z"),
    ...overrides,
  };
}

describe("reading a task row", () => {
  it("returns plan conforming to domain", () => {
    const row: TaskPlanRow = {
      id: "22222222-2222-7222-8222-222222222222",
      userId: "33333333-3333-7333-8333-333333333333",
      title: "Update repository",
      originClientDeviceId: "44444444-4444-7444-8444-444444444444",
      runId: null,
      conversationId: null,
      correlationId: "corr-1",
      status: "RUNNING",
      metadata: { source: "chat", ignored: 42 },
      createdAt: new Date("2026-10-20T09:59:00.000Z"),
      startedAt: new Date("2026-10-20T10:00:00.000Z"),
      completedAt: null,
      steps: [stepRow()],
    };

    const plan = planFromRow(row);

    expect(plan.status).toBe("running");
    expect(plan.createdAt).toBe("2026-10-20T09:59:00.000Z");
    expect(plan.startedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(plan.completedAt).toBeNull();
    expect(plan.metadata).toEqual({ source: "chat" });
    expect(plan.steps[0]?.status).toBe("succeeded");
  });

  it("renames retry policy which differs on each side", () => {
    const step = stepFromRow(stepRow());
    expect(step.retry).toEqual({ attempts: 2, backoffMs: 500, failoverToAnotherDevice: true });
    expect(step).not.toHaveProperty("retryPolicy");
  });

  it("falls back to default policy when column is unreadable", () => {
    expect(stepFromRow(stepRow({ retryPolicy: null })).retry).toEqual({
      attempts: 1,
      backoffMs: 1_000,
      failoverToAnotherDevice: false,
    });
  });

  it("omits missing constraints instead of setting them to undefined", () => {
    expect("constraints" in stepFromRow(stepRow({ constraints: null }))).toBe(false);
    expect(stepFromRow(stepRow({ constraints: { requireMainsPower: true } })).constraints).toEqual({
      requireMainsPower: true,
    });
  });

  it("accepts step error only if it matches expected shape", () => {
    expect(
      stepFromRow(stepRow({ error: { code: "E", message: "m", retryable: true } })).error,
    ).toEqual({ code: "E", message: "m", retryable: true });
    expect(stepFromRow(stepRow({ error: { code: "E" } })).error).toBeNull();
    expect(stepFromRow(stepRow({ error: "boom" })).error).toBeNull();
  });

  it("returns execution conforming to domain", () => {
    const row: TaskExecutionRow = {
      id: "55555555-5555-7555-8555-555555555555",
      taskId: "22222222-2222-7222-8222-222222222222",
      stepId: "11111111-1111-7111-8111-111111111111",
      deviceId: "44444444-4444-7444-8444-444444444444",
      attempt: 1,
      status: "FAILED",
      startedAt: new Date("2026-10-20T10:00:00.000Z"),
      completedAt: null,
      durationMs: null,
      input: null,
      result: null,
      error: { code: "E", message: "m", retryable: false },
    };

    const execution = executionFromRow(row);
    expect(execution.status).toBe("failed");
    expect(execution.startedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(execution.error?.code).toBe("E");
  });
});

describe("writing a step", () => {
  it("writes status in enum casing", () => {
    const written = stepToRow({
      ...stepFromRow(stepRow()),
      status: "running",
    });
    expect(written.status).toBe("RUNNING");
  });

  it("converts dates and names retry column", () => {
    const written = stepToRow(stepFromRow(stepRow()));
    expect(written.startedAt).toEqual(new Date("2026-10-20T10:00:00.000Z"));
    expect(written.retryPolicy).toEqual({
      attempts: 2,
      backoffMs: 500,
      failoverToAnotherDevice: true,
    });
  });

  it("round-trips a step without altering it", () => {
    const original = stepFromRow(stepRow());
    const written = stepToRow(original);

    const reread = stepFromRow({
      id: written.id,
      description: written.description,
      requiredCapabilities: written.requiredCapabilities,
      tool: written.tool,
      arguments: written.arguments,
      dependsOn: written.dependsOn,
      selectedDeviceId: written.selectedDeviceId,
      preferredDeviceId: written.preferredDeviceId,
      constraints: null,
      riskLevel: written.riskLevel,
      retryPolicy: written.retryPolicy,
      timeoutMs: written.timeoutMs,
      status: written.status,
      attempt: written.attempt,
      result: written.result,
      error: null,
      startedAt: written.startedAt,
      completedAt: written.completedAt,
    });

    expect(reread).toEqual(original);
  });
});
