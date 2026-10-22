import { describe, expect, it } from "vitest";
import { createTaskPlan, SENSITIVE_RESULT_PLACEHOLDER, InMemoryTaskStore } from "@nexus/devices";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { TaskCoordinator } from "@nexus/devices";
import {
  ANDROID_PERMISSIONS,
  IPHONE,
  USER_ID,
  makeHarness,
  settle,
  until,
  type AndroidHarness,
} from "./fixtures.js";

/**
 * End-to-end integration path.
 *
 *     iPhone → TaskCoordinator → DeviceSelector → WorkerTransport
 *       → Android worker → capability → events → EventRouter → iPhone
 */

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-1",
      stepId: `step-${String(sequence)}`,
      capability: "android.notification",
      tool: "device.android.notification",
      arguments: { title: "Hello", body: "Test" },
      timeoutMs: 10_000,
      riskLevel: "MEDIUM",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: AndroidHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: AndroidHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

describe("full chain", () => {
  it("executes a notification requested from iPhone", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Notify on phone",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-android",
      steps: [
        {
          id: "notify",
          description: "Notify tests completed",
          requiredCapabilities: ["android.notification"],
          tool: "device.android.notification",
          arguments: { title: "Tests", body: "Completed" },
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(executed.status).toBe("succeeded");
    expect(executed.steps[0]?.selectedDeviceId).toBe(harness.device.id);
    expect(harness.platform.notifications.posted).toEqual([{ title: "Tests", body: "Completed" }]);
  });

  it("routes task events back to origin device", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Open Spotify",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-open",
      steps: [
        {
          id: "open",
          description: "Open Spotify",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { packageName: "com.spotify.music" },
          riskLevel: "LOW",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: ANDROID_PERMISSIONS });

    const taskEvents = harness.clientEvents.filter(
      (event) => event.type.startsWith("task.") || event.type.startsWith("worker.task_"),
    );

    expect(taskEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.started",
        "worker.task_started",
        "worker.task_completed",
        "task.completed",
      ]),
    );
    for (const event of taskEvents) {
      expect(event.originClientDeviceId).toBe(IPHONE.id);
    }
  });

  it("selector chooses phone based on capabilities, never on device name", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const selection = await harness.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["android.ui.click"],
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(selection.device.id).toBe(harness.device.id);
    expect(selection.rejected.map((r) => r.deviceId)).toContain(IPHONE.id);
  });

  it("does not select phone when accessibility is disabled", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.ui.accessibilityEnabled = false;
      },
    });
    await harness.connectWorker();

    const selection = await harness.selector.trySelect({
      userId: USER_ID,
      requiredCapabilities: ["android.ui.click"],
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(selection).toBeUndefined();
  });

  it("reports Android policy denial back to client", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Open settings",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-denial",
      steps: [
        {
          id: "open",
          description: "Open system settings",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { packageName: "com.android.settings" },
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(executed.status).toBe("failed");
    expect(executed.steps[0]?.error?.code).toBe("WORKER_POLICY_VIOLATION");
    expect(harness.platform.apps.opened).toHaveLength(0);
  });

  it("fails cleanly when no worker supports the capability", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Launch a terminal",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-absent",
      steps: [
        {
          id: "shell",
          description: "Execute a command",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          arguments: {},
          riskLevel: "HIGH",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: ANDROID_PERMISSIONS,
    });

    expect(executed.status).toBe("failed");
    expect(harness.clientEvents.map((e) => e.type)).toContain("task.failed");
  });

  it("does not store screenshots in execution log", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const store = new InMemoryTaskStore();
    const coordinator = new TaskCoordinator({
      registry: harness.registry,
      selector: harness.selector,
      router: harness.router,
      transport: harness.gateway,
      store,
    });

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "View screen",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-capture",
      steps: [
        {
          id: "capture",
          description: "Capture screen",
          requiredCapabilities: ["android.ui.screenshot"],
          tool: "device.android.ui.screenshot",
          arguments: {},
          riskLevel: "MEDIUM",
        },
      ],
    });

    const executed = await coordinator.execute(plan, { userPermissions: ANDROID_PERMISSIONS });
    expect(executed.status).toBe("succeeded");

    expect(JSON.stringify(executed.steps[0]?.result)).toContain("aW1hZ2UtZmFjdGljZQ==");

    const executions = await store.listExecutions(plan.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.result).toBe(SENSITIVE_RESULT_PLACEHOLDER);
    expect(JSON.stringify(executions)).not.toContain("aW1hZ2UtZmFjdGljZQ==");
  });

  it("never includes screenshot image in an event", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "View screen",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-capture-evt",
      steps: [
        {
          id: "capture",
          description: "Capture screen",
          requiredCapabilities: ["android.ui.screenshot"],
          tool: "device.android.ui.screenshot",
          arguments: {},
          riskLevel: "MEDIUM",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: ANDROID_PERMISSIONS });

    expect(JSON.stringify(harness.clientEvents)).not.toContain("aW1hZ2UtZmFjdGljZQ==");
    expect(harness.logger.text).not.toContain("aW1hZ2UtZmFjdGljZQ==");
  });

  it("worker remains ready after a failed plan", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "com.android.settings" },
    });
    await settle(20);

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.activeTaskCount).toBe(0);
  });
});

describe("task protocol", () => {
  it("rejects capability that phone does not have", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "terminal.execute",
      tool: "device.terminal.execute",
      arguments: { executable: "sh" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
  });

  it("rejects arguments that violate schema", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, { arguments: { invalidField: "bad field" } });
    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_INPUT_INVALID" } });
    expect(harness.platform.notifications.posted).toHaveLength(0);
  });

  it("does not execute the same request ID twice", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const envelope = dispatchEnvelope();
    harness.link.deliver(envelope);
    await until(() => results(harness).length === 1);

    harness.link.deliver(envelope);
    await settle(30);

    expect(harness.platform.notifications.posted).toHaveLength(1);
    expect(results(harness)).toHaveLength(1);
  });

  it("rejects extra step when phone is saturated", async () => {
    const harness = await makeHarness({
      config: { maxConcurrentTasks: 1 },
    });
    await harness.connectWorker();
    harness.platform.ui.hangUntilAborted = true;

    harness.link.deliver(
      dispatchEnvelope({
        capability: "android.ui.click",
        tool: "device.android.ui.click",
        arguments: { selector: { kind: "text", value: "Search" } },
      }),
    );
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(dispatchEnvelope());
    await until(() => results(harness).length > 0);

    expect(results(harness)[0]).toMatchObject({
      ok: false,
      error: { code: "WORKER_SATURATED", retryable: true },
    });
  });

  it("cancels an in-progress step on core order", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.platform.ui.hangUntilAborted = true;

    const envelope = dispatchEnvelope({
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "text", value: "Search" } },
    });
    const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
    harness.link.deliver(envelope);
    await until(() => harness.worker.activeTaskCount === 1);

    harness.link.deliver(
      workerEnvelope(
        WORKER_MESSAGE.taskCancel,
        { taskId: payload.taskId, stepId: payload.stepId, reason: "cancelled by NEXUS" },
        { id: "cancel-1", at: new Date() },
      ),
    );

    await until(() => results(harness).length > 0);
    expect(results(harness)[0]?.ok).toBe(false);
  });

  it("releases step core-side when phone disconnects", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.platform.ui.hangUntilAborted = true;

    const controller = new AbortController();
    const pending = harness.gateway.dispatch({
      deviceId: harness.device.id,
      taskId: "task-outage",
      stepId: "step-1",
      tool: "device.android.ui.click",
      capability: "android.ui.click",
      arguments: { selector: { kind: "text", value: "Search" } },
      timeoutMs: 60_000,
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await until(() => harness.worker.activeTaskCount === 1);
    await harness.gateway.detach(harness.device.id, "cellular network lost");

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKER_DISCONNECTED", retryable: true },
    });
  });
});
