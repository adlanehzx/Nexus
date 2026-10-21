import { describe, expect, it, vi } from "vitest";
import { InvalidTaskPlanError } from "../src/errors.js";
import {
  createTaskPlan,
  derivePlanStatus,
  planProgress,
  readySteps,
  type TaskPlan,
} from "../src/tasks.js";
import { InMemoryTaskStore, TaskCoordinator, type ConfirmationGate } from "../src/coordinator.js";
import {
  ALL_PERMISSIONS,
  DESKTOP,
  FakeTransport,
  IPHONE,
  LAPTOP,
  REDMI,
  USER_ID,
  makeClient,
  makeHarness,
  setupFleet,
} from "./fixtures.js";

/**
 * Multi-step task plans, origin-client routing, and client synchronization.
 */

function planFor(originClientDeviceId: string): TaskPlan {
  return createTaskPlan({
    userId: USER_ID,
    title: "Clone, test, notify",
    originClientDeviceId,
    correlationId: "corr-1",
    steps: [
      {
        id: "clone",
        description: "Clone repository",
        requiredCapabilities: ["git.execute"],
        tool: "device.git.execute",
        arguments: { command: "clone" },
        riskLevel: "LOW",
      },
      {
        id: "test",
        description: "Run test suite",
        requiredCapabilities: ["terminal.execute"],
        tool: "device.terminal.execute",
        arguments: { command: "pnpm test" },
        dependsOn: ["clone"],
        riskLevel: "LOW",
      },
      {
        id: "notify",
        description: "Notify result",
        requiredCapabilities: ["android.notification"],
        tool: "device.android.notification",
        arguments: { title: "Tests" },
        dependsOn: ["test"],
        riskLevel: "LOW",
      },
    ],
  });
}

function makeCoordinator(
  h: ReturnType<typeof makeHarness>,
  transport: FakeTransport,
  gate?: ConfirmationGate,
) {
  return new TaskCoordinator({
    registry: h.registry,
    selector: h.selector,
    router: h.router,
    transport,
    ...(gate ? { confirmations: gate } : {}),
    now: () => h.clock.now,
  });
}

describe("task plan", () => {
  it("rejects dependencies referencing nonexistent steps", () => {
    expect(() =>
      createTaskPlan({
        userId: USER_ID,
        title: "x",
        originClientDeviceId: IPHONE.id,
        correlationId: "c",
        steps: [
          {
            id: "a",
            description: "a",
            requiredCapabilities: ["x.y"],
            tool: "t",
            dependsOn: ["phantom"],
          },
        ],
      }),
    ).toThrow(InvalidTaskPlanError);
  });

  it("rejects circular dependencies", () => {
    const error = (() => {
      try {
        createTaskPlan({
          userId: USER_ID,
          title: "x",
          originClientDeviceId: IPHONE.id,
          correlationId: "c",
          steps: [
            {
              id: "a",
              description: "a",
              requiredCapabilities: ["x.y"],
              tool: "t",
              dependsOn: ["b"],
            },
            {
              id: "b",
              description: "b",
              requiredCapabilities: ["x.y"],
              tool: "t",
              dependsOn: ["a"],
            },
          ],
        });
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(InvalidTaskPlanError);
    expect((error as InvalidTaskPlanError).details.join(" ")).toContain("cycle");
  });

  it("marks as ready only steps whose dependencies have succeeded", () => {
    const plan = planFor(IPHONE.id);
    expect(readySteps(plan).map((s) => s.id)).toEqual(["clone"]);

    const afterClone: TaskPlan = {
      ...plan,
      steps: plan.steps.map((s) => (s.id === "clone" ? { ...s, status: "succeeded" as const } : s)),
    };
    expect(readySteps(afterClone).map((s) => s.id)).toEqual(["test"]);
  });

  it("derives partial status when all steps finish without all succeeding", () => {
    const plan = planFor(IPHONE.id);
    const mixed: TaskPlan = {
      ...plan,
      steps: [
        { ...plan.steps[0]!, status: "succeeded" },
        { ...plan.steps[1]!, status: "failed" },
        { ...plan.steps[2]!, status: "skipped" },
      ],
    };

    expect(derivePlanStatus(mixed)).toBe("partial");
    expect(planProgress(mixed)).toBe(100);
  });
});

describe("distributed execution", () => {
  it("distributes steps according to capabilities without hardcoding devices", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();

    const result = await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("succeeded");

    const notifyDevice = transport.deviceFor("device.android.notification");
    expect(notifyDevice).toBe(REDMI.id);
    expect([DESKTOP.id, LAPTOP.id]).toContain(transport.deviceFor("device.git.execute"));
    expect([DESKTOP.id, LAPTOP.id]).toContain(transport.deviceFor("device.terminal.execute"));
  });

  it("respects dependency execution order", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();

    await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(transport.dispatched.map((d) => d.tool)).toEqual([
      "device.git.execute",
      "device.terminal.execute",
      "device.android.notification",
    ]);
  });

  it("skips steps when an upstream dependency fails", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();
    transport.responses.set("device.terminal.execute", {
      ok: false,
      error: { code: "TESTS_FAILED", message: "3 tests failed", retryable: false },
    });

    const result = await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("partial");
    expect(result.steps.map((s) => s.status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(transport.deviceFor("device.android.notification")).toBeUndefined();
  });

  it("fails over to another device after a retryable failure", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });
    const transport = new FakeTransport();
    transport.failuresBeforeSuccess.set("device.git.execute", 1);

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "clone",
      originClientDeviceId: LAPTOP.id,
      correlationId: "c",
      steps: [
        {
          id: "clone",
          description: "Clone",
          requiredCapabilities: ["git.execute"],
          tool: "device.git.execute",
          riskLevel: "LOW",
          retry: { attempts: 2, failoverToAnotherDevice: true },
        },
      ],
    });

    const result = await makeCoordinator(h, transport).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("succeeded");
    expect(transport.dispatched).toHaveLength(2);
    expect(transport.dispatched[0]?.deviceId).not.toBe(transport.dispatched[1]?.deviceId);
  });

  it("refuses to execute a capability a device no longer has", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    const transport = new FakeTransport();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "docker",
      originClientDeviceId: LAPTOP.id,
      correlationId: "c",
      steps: [
        {
          id: "run",
          description: "Launch container",
          requiredCapabilities: ["docker.execute"],
          tool: "device.docker.execute",
          riskLevel: "LOW",
        },
      ],
    });

    // Capability is revoked between planning and execution.
    await h.registry.updateCapabilities(DESKTOP.id, []);

    const result = await makeCoordinator(h, transport).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]?.error?.code).toBe("NO_ELIGIBLE_WORKER");
    expect(transport.dispatched).toHaveLength(0);
  });

  it("fails cleanly when the sole candidate device was revoked", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [REDMI] });
    await h.registry.revokeDevice(REDMI.id);
    const transport = new FakeTransport();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "notify",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "notify",
          description: "Notify",
          requiredCapabilities: ["android.notification"],
          tool: "device.android.notification",
          riskLevel: "LOW",
        },
      ],
    });

    const result = await makeCoordinator(h, transport).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("failed");
    expect(transport.dispatched).toHaveLength(0);
    expect(result.steps[0]?.error?.message).toContain("revoked");
  });
});

describe("origin client", () => {
  it("preserves origin client throughout task lifecycle", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();

    const result = await makeCoordinator(h, transport).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.originClientDeviceId).toBe(IPHONE.id);
    expect(new Set(transport.dispatched.map((d) => d.deviceId)).has(IPHONE.id)).toBe(false);
  });

  it("tags each event with originClientDeviceId", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    await h.router.attach(iphone);

    await makeCoordinator(h, new FakeTransport()).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(iphone.received.length).toBeGreaterThan(0);
    expect(iphone.received.every((e) => e.originClientDeviceId === IPHONE.id)).toBe(true);
  });

  it("routes to laptop when task originates from laptop", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(laptop);

    const result = await makeCoordinator(h, new FakeTransport()).execute(planFor(LAPTOP.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.originClientDeviceId).toBe(LAPTOP.id);
    expect(laptop.received.every((e) => e.originClientDeviceId === LAPTOP.id)).toBe(true);
  });
});

describe("client synchronization", () => {
  it("broadcasts to all client devices not just origin", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(iphone);
    await h.router.attach(laptop);

    await makeCoordinator(h, new FakeTransport()).execute(planFor(LAPTOP.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    const iphoneTypes = iphone.received.map((e) => e.type);
    expect(iphoneTypes).toContain("task.created");
    expect(iphoneTypes).toContain("task.completed");
    expect(iphone.received).toHaveLength(laptop.received.length);
  });

  it("never broadcasts events to pure worker devices", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const desktop = makeClient(DESKTOP.id);
    await h.router.attach(desktop);

    await makeCoordinator(h, new FakeTransport()).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(desktop.received).toHaveLength(0);
  });

  it("queues events for disconnected clients and flushes on reconnect", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(laptop);

    await makeCoordinator(h, new FakeTransport()).execute(planFor(LAPTOP.id), {
      userPermissions: ALL_PERMISSIONS,
    });
    expect(h.router.pendingFor(IPHONE.id).length).toBeGreaterThan(0);

    const iphone = makeClient(IPHONE.id);
    const backlog = await h.router.attach(iphone);

    expect(backlog.length).toBe(laptop.received.length);
    expect(iphone.received.map((e) => e.type)).toEqual(laptop.received.map((e) => e.type));
    expect(h.router.pendingFor(IPHONE.id)).toHaveLength(0);
  });

  it("delivers to origin device first", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const order: string[] = [];
    const iphone = { ...makeClient(IPHONE.id), send: () => void order.push(IPHONE.id) };
    const laptop = { ...makeClient(LAPTOP.id), send: () => void order.push(LAPTOP.id) };

    await h.router.attach(laptop);
    await h.router.attach(iphone);

    await h.router.emit({
      type: "task.started",
      userId: USER_ID,
      correlationId: "c",
      originClientDeviceId: IPHONE.id,
      payload: { taskId: "t1" },
    });

    expect(order[0]).toBe(IPHONE.id);
  });
});

describe("confirmations", () => {
  it("routes confirmation to origin device and executes only after approval", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    await h.router.attach(iphone);

    const transport = new FakeTransport();
    const request = vi.fn().mockResolvedValue("approved");
    const gate: ConfirmationGate = { request };

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "delete",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "rm",
          description: "Delete build folder",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    const result = await makeCoordinator(h, transport, gate).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("succeeded");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ originClientDeviceId: IPHONE.id, riskLevel: "HIGH" }),
    );

    const required = iphone.received.find((e) => e.type === "confirmation.required");
    expect(required).toBeDefined();
    expect(required?.originClientDeviceId).toBe(IPHONE.id);
  });

  it("executes nothing if user rejects confirmation", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const transport = new FakeTransport();
    const gate: ConfirmationGate = { request: vi.fn().mockResolvedValue("rejected") };

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "delete",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "rm",
          description: "Delete",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    const result = await makeCoordinator(h, transport, gate).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(result.status).toBe("cancelled");
    expect(transport.dispatched).toHaveLength(0);
  });

  it("does not request confirmation for low-risk steps", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const request = vi.fn().mockResolvedValue("approved");
    const gate: ConfirmationGate = { request };

    await makeCoordinator(h, new FakeTransport(), gate).execute(planFor(IPHONE.id), {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("both clients observe confirmation and either can resolve it", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const iphone = makeClient(IPHONE.id);
    const laptop = makeClient(LAPTOP.id);
    await h.router.attach(iphone);
    await h.router.attach(laptop);

    const gate: ConfirmationGate = { request: vi.fn().mockResolvedValue("approved") };
    const plan = createTaskPlan({
      userId: USER_ID,
      title: "write",
      originClientDeviceId: LAPTOP.id,
      correlationId: "c",
      steps: [
        {
          id: "w",
          description: "Write file",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    await makeCoordinator(h, new FakeTransport(), gate).execute(plan, {
      userPermissions: ALL_PERMISSIONS,
    });

    expect(iphone.received.some((e) => e.type === "confirmation.required")).toBe(true);
    expect(laptop.received.some((e) => e.type === "confirmation.required")).toBe(true);
  });
});

describe("secrets in execution log", () => {
  it("redacts arguments before persisting to task log", async () => {
    const h = makeHarness();
    await setupFleet(h);
    const store = new InMemoryTaskStore();
    const transport = new FakeTransport();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "deploy",
      originClientDeviceId: IPHONE.id,
      correlationId: "c",
      steps: [
        {
          id: "deploy",
          description: "Deploy",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          arguments: { command: "deploy", apiKey: "sk-abcdefghijklmnopqrstuvwxyz" },
          riskLevel: "LOW",
        },
      ],
    });

    await new TaskCoordinator({
      registry: h.registry,
      selector: h.selector,
      router: h.router,
      transport,
      store,
      now: () => h.clock.now,
    }).execute(plan, { userPermissions: ALL_PERMISSIONS });

    const executions = await store.listExecutions(plan.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.input).toEqual({ command: "deploy", apiKey: "[REDACTED]" });
    expect(JSON.stringify(executions)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");

    // Worker receives raw values; redaction protects logs and telemetry.
    expect(transport.dispatched[0]?.arguments).toMatchObject({
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
    });
  });
});
