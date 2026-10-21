import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as signEd25519, createPrivateKey } from "node:crypto";
import {
  WORKER_MESSAGE,
  parseWorkerMessage,
  workerEnvelope,
  type Envelope,
  type WorkerPayload,
} from "@nexus/protocol";
import { DeviceRegistry } from "../src/registry.js";
import { DeviceSessionService } from "../src/sessions.js";
import { EventRouter } from "../src/router.js";
import {
  InMemoryCredentialProvider,
  WorkerGateway,
  type WorkerConnection,
} from "../src/gateway.js";
import { USER_ID } from "./fixtures.js";

/**
 * Worker gateway from the core perspective.
 *
 * Implements WorkerTransport for TaskCoordinator. Tests order/result correlation,
 * lifecycle handling, and dispatch resolution guarantees.
 */

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function sign(privateKeyPem: string, nonce: string): string {
  return signEd25519(null, Buffer.from(nonce, "utf8"), createPrivateKey(privateKeyPem)).toString(
    "base64",
  );
}

interface Harness {
  registry: DeviceRegistry;
  sessions: DeviceSessionService;
  gateway: WorkerGateway;
  connection: WorkerConnection;
  received: Envelope[];
  deviceId: string;
  privateKeyPem: string;
}

async function makeGateway(options: { trusted?: boolean } = {}): Promise<Harness> {
  const registry = new DeviceRegistry();
  const sessions = new DeviceSessionService({ registry });
  const credentials = new InMemoryCredentialProvider();
  const router = new EventRouter({ registry });
  const gateway = new WorkerGateway({ registry, sessions, credentials, router });

  const pair = keys();
  const device = await registry.registerDevice({
    userId: USER_ID,
    name: "Windows Desktop",
    type: "WINDOWS_PC",
    platform: "WINDOWS",
    role: "WORKER",
  });
  credentials.set(device.id, pair.publicKeyPem);
  if (options.trusted !== false) await registry.trustDevice(device.id);

  const received: Envelope[] = [];
  const connection: WorkerConnection = {
    connectionId: `conn-${device.id}`,
    deviceId: device.id,
    send: (envelope) => {
      received.push(envelope);
    },
    close: () => undefined,
  };

  return {
    registry,
    sessions,
    gateway,
    connection,
    received,
    deviceId: device.id,
    privateKeyPem: pair.privateKeyPem,
  };
}

let counter = 0;

/** Builds a worker envelope from short message name. */
function envelope(kind: keyof typeof WORKER_MESSAGE, payload: unknown): Envelope {
  counter += 1;
  return workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
    id: `e-${String(counter)}`,
    at: new Date(),
  });
}

/** Executes handshake through session creation. */
async function authenticate(harness: Harness): Promise<void> {
  await harness.gateway.handleMessage(
    harness.connection,
    envelope("hello", { deviceId: harness.deviceId, workerVersion: "0.1.0", platform: "WINDOWS" }),
  );

  const challenge = parseWorkerMessage(harness.received.at(-1));
  const nonce = (challenge?.payload as WorkerPayload<"worker.challenge">).nonce;

  await harness.gateway.handleMessage(
    harness.connection,
    envelope("authenticate", {
      deviceId: harness.deviceId,
      nonce,
      signature: sign(harness.privateKeyPem, nonce),
      capabilities: ["terminal.execute"],
      requestId: `req-${String(counter)}`,
      timestamp: new Date().toISOString(),
    }),
  );
}

describe("handshake", () => {
  it("responds to hello with a challenge and nothing else", async () => {
    const harness = await makeGateway();
    await harness.gateway.handleMessage(
      harness.connection,
      envelope("hello", {
        deviceId: harness.deviceId,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );

    expect(harness.received).toHaveLength(1);
    expect(harness.received[0]?.type).toBe(WORKER_MESSAGE.challenge);
    expect(harness.gateway.isConnected(harness.deviceId)).toBe(false);
  });

  it("opens session on valid signature", async () => {
    const harness = await makeGateway();
    await authenticate(harness);

    expect(harness.received.at(-1)?.type).toBe(WORKER_MESSAGE.session);
    expect(harness.gateway.isConnected(harness.deviceId)).toBe(true);
  });

  it("does not attach connection if signature is invalid", async () => {
    const harness = await makeGateway();
    await harness.gateway.handleMessage(
      harness.connection,
      envelope("hello", {
        deviceId: harness.deviceId,
        workerVersion: "0.1.0",
        platform: "WINDOWS",
      }),
    );
    const challenge = parseWorkerMessage(harness.received.at(-1));
    const nonce = (challenge?.payload as WorkerPayload<"worker.challenge">).nonce;

    await expect(
      harness.gateway.handleMessage(
        harness.connection,
        envelope("authenticate", {
          deviceId: harness.deviceId,
          nonce,
          signature: sign(keys().privateKeyPem, nonce),
          capabilities: [],
          requestId: "req-fake",
          timestamp: new Date().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "DEVICE_UNAUTHENTICATED" });

    expect(harness.gateway.isConnected(harness.deviceId)).toBe(false);
  });

  it("rejects an unapproved device", async () => {
    const harness = await makeGateway({ trusted: false });
    await expect(authenticate(harness)).rejects.toMatchObject({
      code: "DEVICE_UNAUTHENTICATED",
    });
  });

  it("records declared capabilities", async () => {
    const harness = await makeGateway();
    await authenticate(harness);

    await harness.gateway.handleMessage(
      harness.connection,
      envelope("register", {
        capabilities: [
          {
            name: "terminal.execute",
            version: "1",
            description: "Terminal",
            enabled: true,
            metadata: {},
          },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 2 },
      }),
    );

    const device = await harness.registry.requireDevice(harness.deviceId);
    expect(device.capabilities.map((c) => c.name)).toEqual(["terminal.execute"]);
    expect(device.health.maxConcurrentTasks).toBe(2);
    expect(harness.received.at(-1)?.type).toBe(WORKER_MESSAGE.registered);
  });

  it("filters out malformed capability definition without rejecting others", async () => {
    const harness = await makeGateway();
    await authenticate(harness);

    await harness.gateway.handleMessage(
      harness.connection,
      envelope("register", {
        capabilities: [
          { name: "terminal.execute", version: "1", description: "", enabled: true, metadata: {} },
          // Capability name missing domain: expected format is domain.action.
          { name: "invalidname", version: "1", description: "", enabled: true, metadata: {} },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 1 },
      }),
    );

    const registered = parseWorkerMessage(harness.received.at(-1));
    const payload = registered?.payload as WorkerPayload<"worker.registered">;

    expect(payload.accepted).toEqual(["terminal.execute"]);
    expect(payload.rejected).toEqual([
      { name: "invalidname", reason: "invalid capability definition" },
    ]);
  });
});

describe("dispatch", () => {
  async function ready() {
    const harness = await makeGateway();
    await authenticate(harness);
    await harness.gateway.handleMessage(
      harness.connection,
      envelope("register", {
        capabilities: [
          { name: "terminal.execute", version: "1", description: "", enabled: true, metadata: {} },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 2 },
      }),
    );
    return harness;
  }

  function dispatchInput(harness: Harness, overrides: Record<string, unknown> = {}) {
    return {
      deviceId: harness.deviceId,
      taskId: "t1",
      stepId: "s1",
      tool: "device.terminal.execute",
      capability: "terminal.execute",
      arguments: { executable: "git", args: ["status"] },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      ...overrides,
    };
  }

  it("transmits command and awaits result", async () => {
    const harness = await ready();
    const pending = harness.gateway.dispatch(dispatchInput(harness));

    const sent = parseWorkerMessage(harness.received.at(-1));
    expect(sent?.type).toBe(WORKER_MESSAGE.taskDispatch);

    await harness.gateway.handleMessage(
      harness.connection,
      envelope("taskResult", {
        taskId: "t1",
        stepId: "s1",
        ok: true,
        result: { exitCode: 0 },
        error: null,
        durationMs: 12,
      }),
    );

    await expect(pending).resolves.toMatchObject({ ok: true, result: { exitCode: 0 } });
  });

  it("relays progress updates", async () => {
    const harness = await ready();
    const onProgress = vi.fn();
    const pending = harness.gateway.dispatch(dispatchInput(harness, { onProgress }));

    await harness.gateway.handleMessage(
      harness.connection,
      envelope("taskProgress", { taskId: "t1", stepId: "s1", percent: 40, label: "in progress" }),
    );
    expect(onProgress).toHaveBeenCalledWith({ percent: 40, label: "in progress" });

    await harness.gateway.handleMessage(
      harness.connection,
      envelope("taskResult", {
        taskId: "t1",
        stepId: "s1",
        ok: true,
        result: null,
        error: null,
        durationMs: 1,
      }),
    );
    await pending;
  });

  it("rejects dispatch to disconnected worker as retryable failure", async () => {
    const harness = await makeGateway();
    await expect(harness.gateway.dispatch(dispatchInput(harness))).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKER_UNAVAILABLE", retryable: true },
    });
  });

  it("refuses to dispatch the same step concurrently", async () => {
    const harness = await ready();
    const first = harness.gateway.dispatch(dispatchInput(harness));

    await expect(harness.gateway.dispatch(dispatchInput(harness))).resolves.toMatchObject({
      ok: false,
      error: { code: "STEP_ALREADY_RUNNING", retryable: false },
    });

    await harness.gateway.handleMessage(
      harness.connection,
      envelope("taskResult", {
        taskId: "t1",
        stepId: "s1",
        ok: true,
        result: null,
        error: null,
        durationMs: 1,
      }),
    );
    await first;
  });

  it("frees step when channel disconnects", async () => {
    const harness = await ready();
    const pending = harness.gateway.dispatch(dispatchInput(harness));

    await harness.gateway.detach(harness.deviceId, "cable unplugged");

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKER_DISCONNECTED", retryable: true },
    });
  });

  it("cancels on signal and notifies worker", async () => {
    const harness = await ready();
    const controller = new AbortController();
    const pending = harness.gateway.dispatch(dispatchInput(harness, { signal: controller.signal }));

    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "STEP_CANCELLED", retryable: false },
    });

    const cancel = harness.received.map((e) => e.type);
    expect(cancel).toContain(WORKER_MESSAGE.taskCancel);
  });

  it("ignores late results after completion or timeout", async () => {
    const harness = await ready();

    await expect(
      harness.gateway.handleMessage(
        harness.connection,
        envelope("taskResult", {
          taskId: "unknown",
          stepId: "unknown",
          ok: true,
          result: null,
          error: null,
          durationMs: 1,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("marks device offline and terminates sessions on detachment", async () => {
    const harness = await ready();
    await harness.gateway.detach(harness.deviceId, "shutdown");

    const device = await harness.registry.requireDevice(harness.deviceId);
    expect(device.status).toBe("OFFLINE");
    expect(device.authenticated).toBe(false);
  });

  it("ignores unparseable messages without crashing", async () => {
    const harness = await ready();
    await expect(
      harness.gateway.handleMessage(harness.connection, { not: "an envelope" }),
    ).resolves.toBeUndefined();
  });
});

describe("lifecycle events", () => {
  it("announces connection, readiness, and disconnection", async () => {
    const registry = new DeviceRegistry();
    const sessions = new DeviceSessionService({ registry });
    const credentials = new InMemoryCredentialProvider();
    const router = new EventRouter({ registry });
    const gateway = new WorkerGateway({ registry, sessions, credentials, router });

    const pair = keys();
    const worker = await registry.registerDevice({
      userId: USER_ID,
      name: "Desktop",
      type: "WINDOWS_PC",
      platform: "WINDOWS",
      role: "WORKER",
    });
    credentials.set(worker.id, pair.publicKeyPem);
    await registry.trustDevice(worker.id);

    const client = await registry.registerDevice({
      userId: USER_ID,
      name: "iPhone",
      type: "IPHONE",
      platform: "IOS",
      role: "CLIENT",
    });
    await registry.trustDevice(client.id);

    const seen: string[] = [];
    await router.attach({
      deviceId: client.id,
      userId: USER_ID,
      send: (event) => {
        seen.push(event.type);
      },
    });

    const received: Envelope[] = [];
    const connection: WorkerConnection = {
      connectionId: `conn-${worker.id}`,
      deviceId: worker.id,
      send: (envelope) => {
        received.push(envelope);
      },
      close: () => undefined,
    };

    const harness: Harness = {
      registry,
      sessions,
      gateway,
      connection,
      received,
      deviceId: worker.id,
      privateKeyPem: pair.privateKeyPem,
    };

    await authenticate(harness);
    await gateway.handleMessage(
      connection,
      envelope("register", {
        capabilities: [
          { name: "terminal.execute", version: "1", description: "", enabled: true, metadata: {} },
        ],
        health: { activeTasks: 0, maxConcurrentTasks: 1 },
      }),
    );
    await gateway.detach(worker.id, "shutdown");

    expect(seen).toEqual(
      expect.arrayContaining(["worker.connected", "worker.ready", "worker.disconnected"]),
    );
  });
});
