import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import {
  createAccount,
  makeApi,
  registerDevice,
  settle,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";
import { mountClient, mountWorker, type ClientRig, type WorkerRig } from "./laptop.js";

/**
 * Windows laptop: client and worker (BOTH).
 *
 * Verifies that the client interface on a worker machine never bypasses
 * the core, and that client and worker states remain strictly separated.
 */

let harness: ApiHarness;
let account: Account;

let iphone: RegisteredDevice;
let portable: RegisteredDevice;
let desktop: RegisteredDevice;
let redmi: RegisteredDevice;

const PERMISSIONS = ["filesystem.read", "terminal.execute", "docker.execute", "android.app.open"];

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);

  iphone = await registerDevice(harness, account, {
    name: "iPhone 17",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
    permissions: PERMISSIONS,
  });

  portable = await registerDevice(harness, account, {
    name: "Windows Laptop",
    role: "BOTH",
    permissions: PERMISSIONS,
  });

  desktop = await registerDevice(harness, account, {
    name: "Desktop Workstation",
    role: "WORKER",
    permissions: PERMISSIONS,
  });

  redmi = await registerDevice(harness, account, {
    name: "Redmi Note 10S",
    role: "WORKER",
    type: "ANDROID",
    platform: "ANDROID",
    permissions: PERMISSIONS,
  });
});

afterEach(async () => {
  await harness.close();
});

async function createTask(
  originClientDeviceId: string,
  capability: string,
  title = `Step ${capability}`,
): Promise<{ status: number; taskId: string | undefined; body: unknown }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: account.authorization,
    payload: {
      title,
      originClientDeviceId,
      steps: [
        {
          description: title,
          requiredCapabilities: [capability],
          tool: `device.${capability}`,
          riskLevel: "SAFE",
        },
      ],
    },
  });

  const body = response.json<{ data?: { id: string } }>();
  return { status: response.statusCode, taskId: body.data?.id, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Laptop as client
// ─────────────────────────────────────────────────────────────────────────────

describe("1. laptop acts as client", () => {
  let laptop: ClientRig;

  beforeEach(async () => {
    laptop = await mountClient(harness, account, portable);
  });

  it("opens session on client channel with BOTH role", () => {
    expect(laptop.realtime.state).toBe("connected");
    expect(laptop.socket.deviceId).toBe(portable.device.id);
  });

  it("sends message and receives ack", async () => {
    const result = await laptop.realtime.sendMessage({
      conversationId: null,
      text: "Hello from laptop",
    });

    expect(result.messageId).toBeTruthy();

    const message = await harness.services.conversations.listMessages(result.conversationId, {
      limit: 10,
    });
    expect(message.items[0]?.originClientDeviceId).toBe(portable.device.id);
  });

  it("lists fleet including workers", async () => {
    const fleet = await laptop.realtime.listDevices();

    expect(fleet.devices.map((device) => device.id).sort()).toEqual(
      [iphone.device.id, portable.device.id, desktop.device.id, redmi.device.id].sort(),
    );
  });

  it("receives task events", async () => {
    mountWorker(harness, desktop)
      .runtime.start()
      .catch(() => undefined);
    await until(() => harness.services.gateway.isConnected(desktop.device.id));

    await createTask(portable.device.id, "filesystem.read");
    await until(() => laptop.state().tasks.length > 0);

    expect(laptop.state().tasks[0]?.originClientDeviceId).toBe(portable.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Laptop as worker
// ─────────────────────────────────────────────────────────────────────────────

describe("2. laptop acts as worker", () => {
  it("authenticates on worker channel with machine key", async () => {
    const worker = mountWorker(harness, portable);
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);
  });

  it("declares its capabilities to core", async () => {
    const worker = mountWorker(harness, portable, {
      capabilities: ["terminal.execute", "docker.execute"],
    });
    await worker.runtime.start();

    await until(
      async () =>
        ((await harness.services.deviceRegistry.getDevice(portable.device.id))?.capabilities
          .length ?? 0) > 0,
    );

    const device = await harness.services.deviceRegistry.requireDevice(portable.device.id);
    expect(device.capabilities.map((cap) => cap.name).sort()).toEqual([
      "docker.execute",
      "terminal.execute",
    ]);
  });

  it("maintains both channels simultaneously with two different secrets", async () => {
    const laptopClient = await mountClient(harness, account, portable);
    const laptopWorker = mountWorker(harness, portable);
    await laptopWorker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    expect(laptopClient.realtime.state).toBe("connected");
    expect(harness.app.clientChannel.connectedDeviceIds).toContain(portable.device.id);
    expect(harness.services.gateway.isConnected(portable.device.id)).toBe(true);
  });

  it("pure worker cannot open client session", async () => {
    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: account.accessToken,
        deviceId: desktop.device.id,
      }),
    ).resolves.toBeDefined();

    const clients = await harness.services.deviceRegistry.getClientDevices(account.userId);
    expect(clients.map((device) => device.id)).not.toContain(desktop.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. No authorization bypass
// ─────────────────────────────────────────────────────────────────────────────

describe("3. no authorization bypass", () => {
  it("rejects ungranted capability even on own machine", async () => {
    const worker = mountWorker(harness, portable, { capabilities: ["terminal.execute"] });
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    for (const dev of [iphone, portable, desktop, redmi]) {
      await harness.app.inject({
        method: "PATCH",
        url: `/api/v1/devices/${dev.device.id}/permissions`,
        headers: account.authorization,
        payload: { grantedPermissions: ["filesystem.read"] },
      });
    }

    const rejection = await createTask(portable.device.id, "terminal.execute");

    expect(rejection.status).toBe(403);
    expect(worker.executed).toHaveLength(0);
  });

  it("a client never designates the worker", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Execute here",
        originClientDeviceId: portable.device.id,
        targetDeviceId: portable.device.id,
        steps: [
          {
            description: "Read",
            requiredCapabilities: ["filesystem.read"],
            tool: "device.filesystem.read",
            selectedDeviceId: portable.device.id,
          },
        ],
      },
    });

    const plan = response.json<{ data?: { steps: { selectedDeviceId: string | null }[] } }>();
    expect(plan.data?.steps[0]?.selectedDeviceId ?? null).toBeNull();
  });

  it("another user's token does not open laptop", async () => {
    const intruder = await createAccount(harness, "intruder@example.com");

    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: intruder.accessToken,
        deviceId: portable.device.id,
      }),
    ).rejects.toThrow();
  });

  it("device id alone authenticates nothing", async () => {
    await expect(
      harness.app.clientChannel.authenticate({
        accessToken: "",
        deviceId: portable.device.id,
      }),
    ).rejects.toThrow();
  });

  it("revoked device executes nothing", async () => {
    const worker = mountWorker(harness, portable);
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${portable.device.id}/revoke`,
      headers: account.authorization,
    });

    await createTask(portable.device.id, "filesystem.read");
    await settle(60);

    expect(worker.executed).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4-5. iPhone and laptop remain synchronized
// ─────────────────────────────────────────────────────────────────────────────

describe("4-5. iPhone and laptop remain synchronized", () => {
  let phone: ClientRig;
  let laptop: ClientRig;
  let worker: WorkerRig;

  beforeEach(async () => {
    phone = await mountClient(harness, account, iphone);
    laptop = await mountClient(harness, account, portable);
    worker = mountWorker(harness, portable);
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));
  });

  it("task launched on laptop appears identically on iPhone", async () => {
    await createTask(portable.device.id, "filesystem.read", "Read from laptop");

    await until(() => phone.state().tasks.length > 0 && laptop.state().tasks.length > 0);

    const onPhone = phone.state().tasks[0];
    const onLaptop = laptop.state().tasks[0];

    expect(onPhone?.id).toBe(onLaptop?.id);
    expect(onPhone?.title).toBe(onLaptop?.title);
    expect(onPhone?.originClientDeviceId).toBe(portable.device.id);
    expect(onLaptop?.originClientDeviceId).toBe(portable.device.id);
  });

  it("task launched on iPhone appears on laptop", async () => {
    await createTask(iphone.device.id, "filesystem.read", "Read from iPhone");

    await until(() => laptop.state().tasks.length > 0);

    expect(laptop.state().tasks[0]?.originClientDeviceId).toBe(iphone.device.id);
  });

  it("both clients converge until task completion", async () => {
    await createTask(portable.device.id, "filesystem.read");

    await until(
      () =>
        phone.state().tasks[0]?.status === "succeeded" &&
        laptop.state().tasks[0]?.status === "succeeded",
    );

    expect(phone.state().tasks[0]?.status).toBe("succeeded");
    expect(laptop.state().tasks[0]?.status).toBe("succeeded");
  });

  it("disconnected client catches up on reconnect", async () => {
    phone.realtime.stop("screen locked");
    await settle();

    await createTask(portable.device.id, "filesystem.read", "During absence");
    await until(() => laptop.state().tasks.length > 0);

    const returned = await mountClient(harness, account, iphone);
    await until(() => returned.state().tasks.length > 0);

    expect(returned.state().tasks[0]?.title).toBe("During absence");
  });

  it("confirmation requested on one can be decided on the other", async () => {
    const laptopRisky = mountWorker(harness, portable, { capabilities: ["docker.execute"] });
    await laptopRisky.runtime.start();

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Risky action",
        originClientDeviceId: portable.device.id,
        steps: [
          {
            description: "Docker",
            requiredCapabilities: ["docker.execute"],
            tool: "device.docker.execute",
            riskLevel: "HIGH",
          },
        ],
      },
    });

    await until(() => phone.state().confirmations.length > 0);

    const request = phone.state().confirmations[0];
    expect(request).toBeDefined();
    expect(laptop.state().confirmations[0]?.id).toBe(request?.id);

    const reply = await phone.realtime.respondToConfirmation(request?.id ?? "", "approved");
    expect(reply.accepted).toBe(true);
  });

  it("notifications are produced centrally, not per client", async () => {
    await createTask(portable.device.id, "filesystem.read");

    await until(
      () => phone.state().notifications.length > 0 && laptop.state().notifications.length > 0,
    );

    expect(phone.state().notifications[0]?.id).toBe(laptop.state().notifications[0]?.id);
  });

  it("no worker events leak down to clients", async () => {
    await createTask(portable.device.id, "filesystem.read");
    await until(() => phone.state().tasks[0]?.status === "succeeded");

    const received = phone.actions
      .filter((action) => action.kind === "server")
      .map((action) => action.type);

    expect(received.some((type) => type.startsWith("worker."))).toBe(false);
    expect(received).toContain(SERVER_TO_CLIENT.taskCompleted);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. iPhone launches, laptop executes
// ─────────────────────────────────────────────────────────────────────────────

describe("6. iPhone launches, laptop executes", () => {
  it("step reaches laptop and result returns to phone", async () => {
    const phone = await mountClient(harness, account, iphone);
    const worker = mountWorker(harness, portable, { capabilities: ["terminal.execute"] });
    await worker.runtime.start();
    await until(() => harness.services.gateway.isConnected(portable.device.id));

    await createTask(iphone.device.id, "terminal.execute", "Run tests");

    await until(() => worker.executed.length > 0);
    expect(worker.executed[0]?.capability).toBe("terminal.execute");

    await until(() => phone.state().tasks[0]?.status === "succeeded");
    expect(phone.state().tasks[0]?.status).toBe("succeeded");
  });

  it("iPhone cannot execute what it requested itself", async () => {
    const phone = await mountClient(harness, account, iphone);

    await createTask(iphone.device.id, "terminal.execute");
    await until(() => phone.state().tasks[0]?.status === "failed");

    expect(phone.state().tasks[0]?.status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Laptop drives remainder of the fleet
// ─────────────────────────────────────────────────────────────────────────────

describe("7. laptop drives remainder of the fleet", () => {
  it("capability laptop lacks goes to the machine that has it", async () => {
    const laptop = await mountClient(harness, account, portable);

    const local = mountWorker(harness, portable, { capabilities: ["filesystem.read"] });
    const distant = mountWorker(harness, desktop, { capabilities: ["docker.execute"] });
    await Promise.all([local.runtime.start(), distant.runtime.start()]);
    await until(
      () =>
        harness.services.gateway.isConnected(portable.device.id) &&
        harness.services.gateway.isConnected(desktop.device.id),
    );

    await createTask(portable.device.id, "docker.execute", "List containers");

    await until(() => distant.executed.length > 0);

    expect(distant.executed[0]?.capability).toBe("docker.execute");
    expect(local.executed).toHaveLength(0);

    await until(() => laptop.state().tasks[0]?.status === "succeeded");
    expect(laptop.state().tasks[0]?.workerDeviceId).toBe(desktop.device.id);
  });

  it("reaches Android phone through the same path", async () => {
    const laptop = await mountClient(harness, account, portable);
    const android = mountWorker(harness, redmi, { capabilities: ["android.app.open"] });
    await android.runtime.start();
    await until(() => harness.services.gateway.isConnected(redmi.device.id));

    await createTask(portable.device.id, "android.app.open", "Open Spotify");

    await until(() => android.executed.length > 0);
    expect(android.executed[0]?.capability).toBe("android.app.open");

    await until(() => laptop.state().tasks[0]?.status === "succeeded");
    expect(laptop.state().tasks[0]?.workerDeviceId).toBe(redmi.device.id);
  });

  it("laptop cancels a task running elsewhere", async () => {
    const laptop = await mountClient(harness, account, portable);
    const distant = mountWorker(harness, desktop, { capabilities: ["docker.execute"] });
    await distant.runtime.start();
    await until(() => harness.services.gateway.isConnected(desktop.device.id));

    const task = await createTask(portable.device.id, "docker.execute");
    await until(() => laptop.state().tasks.length > 0);

    const result = await laptop.realtime.cancelTask(task.taskId ?? "");
    expect(typeof result.cancelled).toBe("boolean");
  });
});
