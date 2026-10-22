import { describe, expect, it } from "vitest";
import { createTaskPlan } from "@nexus/devices";
import { makeHarness, until, ALLOWED_ROOT, IPHONE, USER_ID } from "./fixtures.js";

/**
 * Complete end-to-end chain.
 *
 *     client (iPhone) → TaskCoordinator → DeviceSelector → WorkerTransport
 *       → Windows worker → capability → events → EventRouter → client
 *
 * Nothing is mocked in this chain: these are the real coordinator, selector,
 * gateway, and worker. Only network transport (replaced by in-memory channel)
 * and system calls are mocked.
 */

const PERMISSIONS = [
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "git.status",
  "git.diff",
];

describe("full chain", () => {
  it("executes a plan triggered from iPhone on the Windows host", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\leynai\\README.md`, "# LeynAI");
      },
    });
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Read project README",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-integration",
      steps: [
        {
          id: "read",
          description: "Read README",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\leynai\\README.md` },
          riskLevel: "SAFE",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    expect(executed.status).toBe("succeeded");
    expect(executed.steps[0]?.selectedDeviceId).toBe(harness.device.id);
    expect((executed.steps[0]?.result as { content: string }).content).toBe("# LeynAI");
  });

  it("routes all events back to origin device", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\notes.txt`, "ok");
      },
    });
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Read",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-evt",
      steps: [
        {
          id: "read",
          description: "Read notes",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\notes.txt` },
          riskLevel: "SAFE",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    const types = harness.clientEvents.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.started",
        "worker.task_started",
        "worker.task_completed",
        "task.completed",
      ]),
    );

    // Everything pertaining to the task carries the routing thread back to the
    // origin client. Worker lifecycle events — connection, availability — do not:
    // they describe the fleet, not a request, and their origin is legitimately null.
    const taskEvents = harness.clientEvents.filter(
      (event) => event.type.startsWith("task.") || event.type.startsWith("worker.task_"),
    );
    expect(taskEvents.length).toBeGreaterThan(0);
    for (const event of taskEvents) {
      expect(event.originClientDeviceId).toBe(IPHONE.id);
    }
  });

  it("selector chooses Windows host solely on capabilities", async () => {
    // Architecture principle: never "if task has X, choose desktop".
    // The plan names no device; matching is done purely on `requiredCapabilities`.
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const selection = await harness.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.status"],
      userPermissions: PERMISSIONS,
    });

    expect(selection.device.id).toBe(harness.device.id);
    // iPhone is a known candidate, but rejected: its role is CLIENT.
    expect(selection.rejected.map((r) => r.deviceId)).toContain(IPHONE.id);
  });

  it("fails cleanly when capability exists nowhere", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Notify on Android",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-absent",
      steps: [
        {
          id: "notify",
          description: "Notify",
          requiredCapabilities: ["android.notification"],
          tool: "device.android.notification",
          arguments: { title: "x", body: "y" },
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    expect(executed.status).toBe("failed");
    // Failure happens during selection, prior to any dispatch: no worker
    // declares this capability. Therefore client receives `task.failed`,
    // not `worker.task_failed`.
    const types = harness.clientEvents.map((event) => event.type);
    expect(types).toContain("task.failed");
    expect(types).not.toContain("worker.task_started");
  });

  it("reports local policy rejection back to client", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Read forbidden file",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-denial",
      steps: [
        {
          id: "read",
          description: "Read AWS credentials",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: "C:\\Users\\me\\.aws\\credentials" },
          riskLevel: "SAFE",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    expect(executed.status).toBe("failed");
    expect(executed.steps[0]?.error?.code).toBe("PATH_NOT_ALLOWED");

    // Message reaching client does not reveal directory tree.
    const failure = harness.clientEvents.find((e) => e.type === "worker.task_failed");
    expect(JSON.stringify(failure)).not.toContain(".aws");
  });

  it("chains multiple steps on same worker", async () => {
    const harness = await makeHarness({
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\source.txt`, "content");
      },
    });
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Read then write",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-chain",
      steps: [
        {
          id: "read",
          description: "Read source",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\source.txt` },
          riskLevel: "SAFE",
        },
        {
          id: "write",
          description: "Write copy",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          arguments: { path: `${ALLOWED_ROOT}\\copy.txt`, content: "copy" },
          dependsOn: ["read"],
          riskLevel: "LOW",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, {
      userPermissions: PERMISSIONS,
    });

    expect(executed.status).toBe("succeeded");
    expect(harness.fileSystem.files.get(`${ALLOWED_ROOT}\\copy.txt`)).toBe("copy");
  });

  it("redacts sensitive arguments in execution log", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Write configuration file",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-secret",
      steps: [
        {
          id: "write",
          description: "Write configuration",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          arguments: {
            path: `${ALLOWED_ROOT}\\config.json`,
            content: "{}",
            apiKey: "sk-mustdisappear12345",
          },
          riskLevel: "LOW",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });

    // Neither in client events nor in worker logs.
    expect(JSON.stringify(harness.clientEvents)).not.toContain("sk-mustdisappear12345");
    expect(harness.logger.text).not.toContain("sk-mustdisappear12345");
  });

  it("worker remains ready after failed plan", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Expected failure",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-after",
      steps: [
        {
          id: "read",
          description: "Read elsewhere",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: "C:\\Windows\\win.ini" },
          riskLevel: "SAFE",
        },
      ],
    });

    await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });
    await until(() => harness.worker.activeTaskCount === 0);

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.activeTaskCount).toBe(0);
  });
});
