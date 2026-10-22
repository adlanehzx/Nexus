import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_MESSAGE, workerEnvelope } from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import {
  FakeWorkerSocket,
  createAccount,
  makeApi,
  registerDevice,
  settle,
  signNonce,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * Security audit — attack scenarios.
 *
 * Verifies that untrusted or compromised devices cannot forge execution,
 * inject capabilities, or bypass authorization.
 */

let harness: ApiHarness;
let account: Account;

let portable: RegisteredDevice;
let redmi: RegisteredDevice;

let sequence = 0;

function workerFrame(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
    id: `w-${String(sequence)}`,
    at: new Date(),
  });
}

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);

  portable = await registerDevice(harness, account, {
    name: "Windows Laptop",
    role: "BOTH",
    permissions: ["filesystem.read", "terminal.execute"],
  });
  redmi = await registerDevice(harness, account, {
    name: "Redmi Note 10S",
    role: "WORKER",
    type: "ANDROID",
    platform: "ANDROID",
    permissions: ["android.app.open"],
  });
});

afterEach(async () => {
  await harness.close();
});

/** Opens a worker socket without authenticating, announcing a device. */
async function announceOnly(deviceId: string, connectionId = "attacker") {
  const socket = new FakeWorkerSocket();
  harness.app.workerChannel.open(connectionId, socket);

  await harness.app.workerChannel.handle(
    connectionId,
    workerFrame("hello", { deviceId, workerVersion: "0.1.0", platform: "WINDOWS" }),
  );

  return { socket, connectionId };
}

/** Full legitimate handshake. */
async function authenticate(device: RegisteredDevice, connectionId: string) {
  const socket = new FakeWorkerSocket();
  harness.app.workerChannel.open(connectionId, socket);

  await harness.app.workerChannel.handle(
    connectionId,
    workerFrame("hello", {
      deviceId: device.device.id,
      workerVersion: "0.1.0",
      platform: "WINDOWS",
    }),
  );

  const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string };

  await harness.app.workerChannel.handle(
    connectionId,
    workerFrame("authenticate", {
      deviceId: device.device.id,
      nonce: challenge.nonce,
      signature: signNonce(device.privateKeyPem, challenge.nonce),
      capabilities: [],
      requestId: `auth-${connectionId}-${String(sequence)}`,
      timestamp: new Date().toISOString(),
    }),
  );

  return { socket, connectionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — Post-handshake frames on unauthenticated connection
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 — an unauthenticated connection writes nothing", () => {
  it("cannot rewrite device capabilities", async () => {
    const { connectionId } = await announceOnly(portable.device.id);

    await harness.app.workerChannel.handle(
      connectionId,
      workerFrame("register", {
        capabilities: [
          {
            name: "terminal.execute",
            version: "1",
            description: "injected capability",
            enabled: true,
            metadata: {},
          },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 99 },
      }),
    );

    const device = await harness.services.deviceRegistry.requireDevice(portable.device.id);
    expect(device.capabilities).toEqual([]);
  });

  it("cannot declare a device online", async () => {
    const { connectionId } = await announceOnly(redmi.device.id);

    await harness.app.workerChannel.handle(
      connectionId,
      workerFrame("heartbeat", {
        health: { activeTasks: 0, maxConcurrentTasks: 8 },
        requestId: "hb-attacker",
        timestamp: new Date().toISOString(),
      }),
    );

    const device = await harness.services.deviceRegistry.requireDevice(redmi.device.id);
    expect(device.health.maxConcurrentTasks).not.toBe(8);
  });

  it("connection is closed, not merely ignored", async () => {
    const { socket, connectionId } = await announceOnly(portable.device.id);

    await harness.app.workerChannel.handle(
      connectionId,
      workerFrame("register", { capabilities: [], health: { activeTasks: 0 } }),
    );

    expect(socket.closed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 — Forged step result
// ─────────────────────────────────────────────────────────────────────────────

describe("C2 — a worker only responds for its own steps", () => {
  it("a compromised Redmi cannot forge the result of a laptop step", async () => {
    const laptop = await authenticate(portable, "portable");

    await harness.app.workerChannel.handle(
      "portable",
      workerFrame("register", {
        capabilities: [
          {
            name: "filesystem.read",
            version: "1",
            description: "Read",
            enabled: true,
            metadata: {},
          },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 2 },
      }),
    );

    const attacker = await authenticate(redmi, "redmi");
    expect(attacker.socket.last(WORKER_MESSAGE.session)).toBeDefined();

    const plan = createTaskPlan({
      userId: account.userId,
      title: "Read a file",
      originClientDeviceId: portable.device.id,
      correlationId: "corr-c2",
      steps: [
        {
          id: "s1",
          description: "Read",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE",
        },
      ],
    });

    const running = harness.services.coordinator.execute(plan, {
      userPermissions: ["filesystem.read"],
    });

    await until(() => laptop.socket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);
    const dispatch = laptop.socket.last(WORKER_MESSAGE.taskDispatch) as {
      taskId: string;
      stepId: string;
    };

    // Redmi, authenticated for itself, attempts to respond for the laptop step
    await harness.app.workerChannel.handle(
      "redmi",
      workerFrame("taskResult", {
        taskId: dispatch.taskId,
        stepId: dispatch.stepId,
        ok: true,
        result: { content: "FORGED ATTACKER CONTENT" },
        sensitiveResult: false,
        error: null,
        durationMs: 1,
      }),
    );

    await settle(40);

    const executed = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve("still-in-flight"), 50)),
    ]);

    expect(executed).toBe("still-in-flight");
    expect(attacker.socket.closed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — Detachment from unauthenticated connection
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — an unauthenticated connection detaches no one", () => {
  it("announcing then disconnecting does not take the device offline", async () => {
    const legitimate = await authenticate(portable, "portable");
    expect(legitimate.socket.last(WORKER_MESSAGE.session)).toBeDefined();
    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);

    await announceOnly(portable.device.id, "attacker");
    await harness.app.workerChannel.close("attacker", "socket closed");
    await settle();

    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);

    const device = await harness.services.deviceRegistry.requireDevice(portable.device.id);
    expect(device.status).not.toBe("OFFLINE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Challenge bounding
// ─────────────────────────────────────────────────────────────────────────────

describe("challenges", () => {
  it("a single socket cannot claim challenges indefinitely", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("flood", socket);

    for (let index = 0; index < 40; index += 1) {
      await harness.app.workerChannel.handle(
        "flood",
        workerFrame("hello", {
          deviceId: portable.device.id,
          workerVersion: "0.1.0",
          platform: "WINDOWS",
        }),
      );
    }

    expect(socket.ofType(WORKER_MESSAGE.challenge).length).toBeLessThan(40);
    expect(socket.closed).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H3 — Approval of someone else's confirmation
// ─────────────────────────────────────────────────────────────────────────────

describe("H3 — a confirmation is decided only by its owner", () => {
  function pendingConfirmation(userId: string, confirmationId = "conf-target") {
    const decided = harness.services.confirmationBroker.request({
      confirmationId,
      userId,
      action: "docker.execute",
      description: "Launch privileged container",
      riskLevel: "CRITICAL",
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    return { confirmationId, decided };
  }

  it("another account cannot approve via REST API", async () => {
    const intruder = await createAccount(harness, "intruder@example.com");
    const { confirmationId, decided } = pendingConfirmation(account.userId);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/confirmations/${confirmationId}/respond`,
      headers: intruder.authorization,
      payload: { decision: "approved" },
    });

    expect(response.json<{ data: { accepted: boolean } }>().data.accepted).toBe(false);

    expect(harness.services.confirmationBroker.pendingIds(account.userId)).toContain(
      confirmationId,
    );
    void decided;
  });

  it("another account cannot approve via real-time channel", async () => {
    const intruder = await createAccount(harness, "intruder2@example.com");
    const { confirmationId } = pendingConfirmation(account.userId, "conf-ws");

    const accepted = await harness.services.confirmationBroker.respondAndRecord(
      confirmationId,
      "approved",
      intruder.userId,
    );

    expect(accepted).toBe(false);
    expect(harness.services.confirmationBroker.pendingIds(account.userId)).toContain(
      confirmationId,
    );
  });

  it("owner resolves the confirmation", async () => {
    const { confirmationId, decided } = pendingConfirmation(account.userId, "conf-own");

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/confirmations/${confirmationId}/respond`,
      headers: account.authorization,
      payload: { decision: "approved" },
    });

    expect(response.json<{ data: { accepted: boolean } }>().data.accepted).toBe(true);
    await expect(decided).resolves.toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H4 — Cancellation of another account's execution
// ─────────────────────────────────────────────────────────────────────────────

describe("H4 — an execution is cancelled only by its owner", () => {
  it("another account cannot stop a task", async () => {
    const intruder = await createAccount(harness, "intruder3@example.com");

    const plan = createTaskPlan({
      userId: account.userId,
      title: "Long task",
      originClientDeviceId: portable.device.id,
      correlationId: "corr-h4",
      steps: [
        {
          id: "s1",
          description: "Work",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
        },
      ],
    });

    harness.services.supervisor.start(plan, ["filesystem.read"]);

    expect(harness.services.supervisor.cancel(plan.id, intruder.userId)).toBe(false);
    expect(harness.services.supervisor.runningIds(account.userId)).toContain(plan.id);

    expect(harness.services.supervisor.cancel(plan.id, account.userId)).toBe(true);
  });

  it("REST route also rejects", async () => {
    const intruder = await createAccount(harness, "intruder4@example.com");

    const plan = createTaskPlan({
      userId: account.userId,
      title: "Private task",
      originClientDeviceId: portable.device.id,
      correlationId: "corr-h4b",
      steps: [
        {
          id: "s1",
          description: "Work",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
        },
      ],
    });
    await harness.services.taskStore.save(plan);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${plan.id}/cancel`,
      headers: intruder.authorization,
      payload: { reason: "malicious" },
    });

    expect(response.statusCode).toBe(403);
  });
});
