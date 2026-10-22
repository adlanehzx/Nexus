import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
  WORKER_MESSAGE,
  clientEnvelope,
  workerEnvelope,
  type WorkerPayload,
} from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import {
  FakeClientSocket,
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
 * Both real-time channels: client and worker.
 *
 * Verifies that clients never talk directly to workers, that the core routes
 * and authorizes all actions, and that all user clients stay synchronized.
 */

let harness: ApiHarness;
let account: Account;

let iphone: RegisteredDevice;
let laptop: RegisteredDevice;
let worker: RegisteredDevice;

let sequence = 0;

function clientMessage(type: string, payload: unknown, requestId?: string) {
  sequence += 1;
  return clientEnvelope(type as never, payload as never, {
    id: `c-${String(sequence)}`,
    at: new Date(),
    requestId,
  });
}

function workerMessage(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
    id: `w-${String(sequence)}`,
    at: new Date(),
  });
}

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);

  iphone = await registerDevice(harness, account, {
    name: "iPhone",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
  });
  laptop = await registerDevice(harness, account, {
    name: "Laptop",
    role: "BOTH",
    permissions: ["filesystem.read"],
  });
  worker = await registerDevice(harness, account, {
    name: "Desktop Workstation",
    role: "WORKER",
    permissions: ["filesystem.read", "terminal.execute"],
  });
});

afterEach(async () => {
  await harness.close();
});

async function connectClient(device: RegisteredDevice) {
  const socket = new FakeClientSocket();
  const context = await harness.app.clientChannel.authenticate({
    accessToken: account.accessToken,
    deviceId: device.device.id,
  });
  await harness.app.clientChannel.attach(context, socket);

  return { socket, context };
}

async function connectWorker(device: RegisteredDevice, connectionId = "w1") {
  const socket = new FakeWorkerSocket();
  harness.app.workerChannel.open(connectionId, socket);

  await harness.app.workerChannel.handle(
    connectionId,
    workerMessage("hello", {
      deviceId: device.device.id,
      workerVersion: "0.1.0",
      platform: "WINDOWS",
    }),
  );

  const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string } | undefined;
  if (challenge === undefined) return { socket, authenticated: false };

  await harness.app.workerChannel.handle(
    connectionId,
    workerMessage("authenticate", {
      deviceId: device.device.id,
      nonce: challenge.nonce,
      signature: signNonce(device.privateKeyPem, challenge.nonce),
      capabilities: ["filesystem.read"],
      requestId: `auth-${connectionId}-${String(sequence)}`,
      timestamp: new Date().toISOString(),
    }),
  );

  const session = socket.last(WORKER_MESSAGE.session);
  if (session === undefined) return { socket, authenticated: false };

  await harness.app.workerChannel.handle(
    connectionId,
    workerMessage("register", {
      capabilities: [
        {
          name: "filesystem.read",
          version: "1",
          description: "Read",
          enabled: true,
          metadata: { risk: "SAFE" },
        },
      ],
      health: { activeTasks: 0, maxConcurrentTasks: 2 },
    }),
  );

  return { socket, authenticated: true };
}

describe("client channel authentication", () => {
  it("accepts valid token and approved device", async () => {
    const context = await harness.app.clientChannel.authenticate({
      accessToken: account.accessToken,
      deviceId: iphone.device.id,
    });

    expect(context.userId).toBe(account.userId);
    expect(context.deviceId).toBe(iphone.device.id);
  });

  it("rejects invalid token", async () => {
    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: "not.a.token",
        deviceId: iphone.device.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects device belonging to someone else", async () => {
    const other = await createAccount(harness, "other@example.com");
    const theirs = await registerDevice(harness, other, { name: "His iPhone", role: "CLIENT" });

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: theirs.device.id,
      }),
    ).rejects.toThrow(/does not belong/i);
  });

  it("rejects unapproved device", async () => {
    const pending = await registerDevice(harness, account, {
      name: "New",
      role: "CLIENT",
      trust: false,
    });

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: pending.device.id,
      }),
    ).rejects.toThrow(/not approved/i);
  });

  it("rejects after logout, even with token still valid", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: account.authorization,
    });

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: iphone.device.id,
      }),
    ).rejects.toThrow();
  });
});

describe("malformed messages", () => {
  it("ignores unreadable frame without closing connection", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(context, { not: "an envelope" });
    await harness.app.clientChannel.handle(context, "raw text");
    await harness.app.clientChannel.handle(context, null);

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });

  it("ignores unknown type — newer client should not crash", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(context, clientMessage("client.telepathy", {}));

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });

  it("responds with negative ack on invalid payload", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.messageSend, { invalidField: "bad" }, "r1"),
    );

    expect(socket.acks[0]).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
  });

  it("correlates ack with request", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.deviceList, { workersOnly: false }, "request-42"),
    );

    expect(socket.ofType(SERVER_TO_CLIENT.ack)[0]?.requestId).toBe("request-42");
  });
});

describe("client requests", () => {
  it("lists user devices", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.deviceList, { workersOnly: true }, "r1"),
    );

    const ack = socket.acks[0] as { ok: boolean; data: { devices: { id: string }[] } };
    expect(ack.ok).toBe(true);
    expect(ack.data.devices.map((d) => d.id)).not.toContain(iphone.device.id);
    expect(ack.data.devices.map((d) => d.id)).toContain(worker.device.id);
  });

  it("creates a conversation and enforces origin device", async () => {
    const { socket, context } = await connectClient(laptop);

    await harness.app.clientChannel.handle(
      context,
      clientMessage(
        CLIENT_TO_SERVER.messageSend,
        { conversationId: null, text: "Hello", originClientDeviceId: iphone.device.id },
        "r1",
      ),
    );

    const ack = socket.acks[0] as { ok: boolean; data: { conversationId: string } };
    expect(ack.ok).toBe(true);

    const messages = await harness.services.conversations.listMessages(ack.data.conversationId, {
      limit: 10,
    });

    expect(messages.items[0]?.originClientDeviceId).toBe(laptop.device.id);
  });

  it("rejects conversation belonging to another user", async () => {
    const other = await createAccount(harness, "other@example.com");
    const conversation = await harness.services.conversations.create({
      userId: other.userId,
      title: "Private",
    });

    const { socket, context } = await connectClient(iphone);
    await harness.app.clientChannel.handle(
      context,
      clientMessage(
        CLIENT_TO_SERVER.messageSend,
        { conversationId: conversation.id, text: "intrusion" },
        "r1",
      ),
    );

    expect(socket.acks[0]?.ok).toBe(false);
  });

  it("refuses to cancel another user's task", async () => {
    const other = await createAccount(harness, "other@example.com");
    const theirs = await registerDevice(harness, other, { name: "His iPhone", role: "CLIENT" });

    const plan = createTaskPlan({
      userId: other.userId,
      title: "His task",
      originClientDeviceId: theirs.device.id,
      correlationId: "c",
      steps: [{ description: "x", requiredCapabilities: ["filesystem.read"], tool: "t" }],
    });
    await harness.services.taskStore.save(plan);

    const { socket, context } = await connectClient(iphone);
    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.taskCancel, { taskId: plan.id, reason: "x" }, "r1"),
    );

    expect(socket.acks[0]).toMatchObject({ ok: false });
  });
});

describe("worker channel", () => {
  it("authenticates a worker on signed challenge", async () => {
    const { socket, authenticated } = await connectWorker(worker);

    expect(authenticated).toBe(true);
    expect(socket.ofType(WORKER_MESSAGE.registered)).toHaveLength(1);

    const device = await harness.services.deviceRegistry.requireDevice(worker.device.id);
    expect(device.authenticated).toBe(true);
    expect(device.status).toBe("ONLINE");
  });

  it("rejects and closes on invalid signature", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-bad", socket);

    await harness.app.workerChannel.handle(
      "w-bad",
      workerMessage("hello", {
        deviceId: worker.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string };
    await harness.app.workerChannel.handle(
      "w-bad",
      workerMessage("authenticate", {
        deviceId: worker.device.id,
        nonce: challenge.nonce,
        signature: "c2lnbmF0dXJlLWZhdXNzZQ",
        capabilities: [],
        requestId: "auth-bad",
        timestamp: new Date().toISOString(),
      }),
    );

    expect(socket.closed?.code).toBe(4401);
    expect(socket.ofType(WORKER_MESSAGE.session)).toHaveLength(0);
  });

  it("rejects revoked worker", async () => {
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${worker.device.id}/revoke`,
      headers: account.authorization,
    });

    const { authenticated } = await connectWorker(worker, "w-revoked");
    expect(authenticated).toBe(false);
  });

  it("rejects unapproved worker", async () => {
    const pending = await registerDevice(harness, account, {
      name: "New Workstation",
      role: "WORKER",
      trust: false,
    });

    const { authenticated } = await connectWorker(pending, "w-pending");
    expect(authenticated).toBe(false);
  });

  it("rejects replay of authentication frame", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-replay", socket);

    await harness.app.workerChannel.handle(
      "w-replay",
      workerMessage("hello", {
        deviceId: worker.device.id,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );
    const challenge = socket.last(WORKER_MESSAGE.challenge) as { nonce: string };

    const frame = workerMessage("authenticate", {
      deviceId: worker.device.id,
      nonce: challenge.nonce,
      signature: signNonce(worker.privateKeyPem, challenge.nonce),
      capabilities: [],
      requestId: "auth-unique",
      timestamp: new Date().toISOString(),
    });

    await harness.app.workerChannel.handle("w-replay", frame);
    expect(socket.ofType(WORKER_MESSAGE.session)).toHaveLength(1);

    const replay = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-replay-2", replay);
    await harness.app.workerChannel.handle("w-replay-2", frame);

    expect(replay.closed?.code).toBe(4401);
    expect(replay.ofType(WORKER_MESSAGE.session)).toHaveLength(0);
  });

  it("releases worker upon channel close", async () => {
    await connectWorker(worker);
    await harness.app.workerChannel.close("w1", "socket closed");

    const device = await harness.services.deviceRegistry.requireDevice(worker.device.id);
    expect(device.status).toBe("OFFLINE");
  });

  it("allows reconnection after disconnect", async () => {
    await connectWorker(worker, "w-a");
    await harness.app.workerChannel.close("w-a", "disconnect");

    const { authenticated } = await connectWorker(worker, "w-b");
    expect(authenticated).toBe(true);

    const device = await harness.services.deviceRegistry.requireDevice(worker.device.id);
    expect(device.status).toBe("ONLINE");
  });

  it("ignores unreadable worker frame", async () => {
    const socket = new FakeWorkerSocket();
    harness.app.workerChannel.open("w-unreadable", socket);

    await harness.app.workerChannel.handle("w-unreadable", { invalid: "content" });

    expect(socket.closed).toBeUndefined();
    expect(socket.sent).toHaveLength(0);
  });
});

describe("channel partitioning", () => {
  it("a client cannot emit a frame from worker channel", async () => {
    const { socket, context } = await connectClient(iphone);

    await harness.app.clientChannel.handle(
      context,
      workerMessage("taskResult", {
        taskId: "t",
        stepId: "s",
        ok: true,
        result: null,
        error: null,
        durationMs: 1,
      }),
    );

    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toBeUndefined();
  });

  it("a worker cannot emit a client request", async () => {
    const { socket } = await connectWorker(worker);
    const before = socket.sent.length;

    await harness.app.workerChannel.handle(
      "w1",
      clientMessage(CLIENT_TO_SERVER.taskCancel, { taskId: "t", reason: "x" }),
    );

    expect(socket.sent).toHaveLength(before);
  });
});

describe("synchronization between iPhone and laptop", () => {
  it("both clients receive the same task event", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const laptopSocket = (await connectClient(laptop)).socket;
    await connectWorker(worker);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Read a file",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Read",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    expect(created.statusCode).toBe(202);
    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskCreated).length > 0);
    await settle(40);

    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskCreated)).toHaveLength(1);
    expect(laptopSocket.ofType(SERVER_TO_CLIENT.taskCreated)).toHaveLength(1);
  });

  it("preserves origin device across all events", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const laptopSocket = (await connectClient(laptop)).socket;
    await connectWorker(worker);

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Read a file",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Read",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    await until(() => laptopSocket.ofType(SERVER_TO_CLIENT.taskCreated).length > 0);

    const onLaptop = laptopSocket.ofType(SERVER_TO_CLIENT.taskCreated)[0]?.payload as {
      originClientDeviceId: string;
    };
    const onPhone = iphoneSocket.ofType(SERVER_TO_CLIENT.taskCreated)[0]?.payload as {
      originClientDeviceId: string;
    };

    expect(onLaptop.originClientDeviceId).toBe(iphone.device.id);
    expect(onPhone.originClientDeviceId).toBe(iphone.device.id);
  });

  it("delivers on return what a disconnected client missed", async () => {
    const laptopSocket = (await connectClient(laptop)).socket;
    await connectWorker(worker);

    await harness.services.notifications.create({
      userId: account.userId,
      title: "During absence",
      body: "something happened",
      originClientDeviceId: laptop.device.id,
    });

    await until(() => laptopSocket.ofType(SERVER_TO_CLIENT.notificationCreated).length > 0);

    const late = await connectClient(iphone);
    await settle(20);

    expect(late.socket.ofType(SERVER_TO_CLIENT.notificationCreated)).toHaveLength(1);
  });

  it("broadcasts nothing to a pure worker", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    await connectWorker(worker);

    await harness.services.notifications.create({
      userId: account.userId,
      title: "For clients",
      body: "x",
    });
    await settle(20);

    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.notificationCreated)).toHaveLength(1);
    expect(harness.app.clientChannel.connectedDeviceIds).not.toContain(worker.device.id);
  });

  it("does not leak worker internal events down to clients", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    await connectWorker(worker);
    await settle(20);

    expect(iphoneSocket.sent.map((m) => m.type)).not.toContain("worker.connected");
    expect(iphoneSocket.sent.map((m) => m.type)).toContain(SERVER_TO_CLIENT.deviceUpdated);
  });
});

describe("routing to worker and back", () => {
  it("routes a step to worker and returns its result", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const workerSocket = (await connectWorker(worker)).socket;

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Read a file",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Read",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);

    const dispatch = workerSocket.last(
      WORKER_MESSAGE.taskDispatch,
    ) as WorkerPayload<"worker.task_dispatch">;
    expect(dispatch.capability).toBe("filesystem.read");

    await harness.app.workerChannel.handle(
      "w1",
      workerMessage("taskResult", {
        taskId: dispatch.taskId,
        stepId: dispatch.stepId,
        ok: true,
        result: { content: "hello" },
        sensitiveResult: false,
        error: null,
        durationMs: 12,
      }),
    );

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted).length > 0);
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted)).toHaveLength(1);
  });

  it("fails cleanly when no worker declares the capability", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    await connectWorker(worker);

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Shell command",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Run",
            requiredCapabilities: ["terminal.execute"],
            tool: "device.terminal.execute",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskFailed).length > 0);
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskFailed)).toHaveLength(1);
  });

  it("cancels a task from the client channel", async () => {
    const { context } = await connectClient(iphone);
    const workerSocket = (await connectWorker(worker)).socket;

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Read a file",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Read",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "SAFE",
          },
        ],
      },
    });

    const taskId = created.json<{ data: { id: string } }>().data.id;
    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);

    const socket = new FakeClientSocket();
    await harness.app.clientChannel.attach(context, socket);
    await harness.app.clientChannel.handle(
      context,
      clientMessage(CLIENT_TO_SERVER.taskCancel, { taskId, reason: "changed mind" }, "r1"),
    );

    expect(socket.acks[0]).toMatchObject({ ok: true, data: { cancelled: true } });
  });

  it("runs two tasks concurrently", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const workerSocket = (await connectWorker(worker)).socket;

    const bodies = [1, 2].map((n) => ({
      title: `Read ${String(n)}`,
      originClientDeviceId: iphone.device.id,
      steps: [
        {
          description: `Read ${String(n)}`,
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE" as const,
        },
      ],
    }));

    await Promise.all(
      bodies.map((payload) =>
        harness.app.inject({
          method: "POST",
          url: "/api/v1/tasks",
          headers: account.authorization,
          payload,
        }),
      ),
    );

    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length >= 2);

    const dispatches = workerSocket
      .ofType(WORKER_MESSAGE.taskDispatch)
      .map((m) => m.payload as WorkerPayload<"worker.task_dispatch">);

    expect(new Set(dispatches.map((d) => d.taskId)).size).toBe(2);

    for (const dispatch of dispatches) {
      await harness.app.workerChannel.handle(
        "w1",
        workerMessage("taskResult", {
          taskId: dispatch.taskId,
          stepId: dispatch.stepId,
          ok: true,
          result: null,
          sensitiveResult: false,
          error: null,
          durationMs: 5,
        }),
      );
    }

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted).length >= 2);
    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.taskCompleted)).toHaveLength(2);
  });
});

describe("confirmations", () => {
  it("routes request to both clients, and either can resolve", async () => {
    const iphoneSocket = (await connectClient(iphone)).socket;
    const laptopClient = await connectClient(laptop);
    const workerSocket = (await connectWorker(worker)).socket;

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Sensitive read",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Read a sensitive file",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "HIGH",
          },
        ],
      },
    });

    await until(() => iphoneSocket.ofType(SERVER_TO_CLIENT.confirmationRequired).length > 0);

    expect(iphoneSocket.ofType(SERVER_TO_CLIENT.confirmationRequired)).toHaveLength(1);
    expect(laptopClient.socket.ofType(SERVER_TO_CLIENT.confirmationRequired)).toHaveLength(1);

    const request = iphoneSocket.ofType(SERVER_TO_CLIENT.confirmationRequired)[0]?.payload as {
      confirmationId: string;
    };

    await harness.app.clientChannel.handle(
      laptopClient.context,
      clientMessage(
        CLIENT_TO_SERVER.confirmationRespond,
        { confirmationId: request.confirmationId, decision: "approved" },
        "r1",
      ),
    );

    expect(laptopClient.socket.acks[0]).toMatchObject({ ok: true, data: { accepted: true } });
    await until(() => workerSocket.ofType(WORKER_MESSAGE.taskDispatch).length > 0);
    expect(workerSocket.ofType(WORKER_MESSAGE.taskDispatch)).toHaveLength(1);
  });

  it("executes nothing if user rejects", async () => {
    const iphoneClient = await connectClient(iphone);
    const workerSocket = (await connectWorker(worker)).socket;

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Sensitive read",
        originClientDeviceId: iphone.device.id,
        steps: [
          {
            description: "Read",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            riskLevel: "HIGH",
          },
        ],
      },
    });

    await until(() => iphoneClient.socket.ofType(SERVER_TO_CLIENT.confirmationRequired).length > 0);
    const request = iphoneClient.socket.ofType(SERVER_TO_CLIENT.confirmationRequired)[0]
      ?.payload as { confirmationId: string };

    await harness.app.clientChannel.handle(
      iphoneClient.context,
      clientMessage(
        CLIENT_TO_SERVER.confirmationRespond,
        { confirmationId: request.confirmationId, decision: "rejected" },
        "r1",
      ),
    );

    await settle(60);
    expect(workerSocket.ofType(WORKER_MESSAGE.taskDispatch)).toHaveLength(0);
  });

  it("duplicate response is not an error", async () => {
    const iphoneClient = await connectClient(iphone);
    await connectWorker(worker);

    await harness.app.clientChannel.handle(
      iphoneClient.context,
      clientMessage(
        CLIENT_TO_SERVER.confirmationRespond,
        { confirmationId: "nonexistent", decision: "approved" },
        "r1",
      ),
    );

    expect(iphoneClient.socket.acks[0]).toMatchObject({ ok: true, data: { accepted: false } });
  });
});
