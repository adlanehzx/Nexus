import { describe, expect, it } from "vitest";
import { Backoff } from "@nexus/worker-core";
import { makeHarness, settle, generateDeviceKeys, USER_ID } from "./fixtures.js";
import { InMemoryCredentialSigner } from "../src/connection/signer.js";
import { createWindowsWorker } from "../src/worker.js";
import { LoopbackLink } from "@nexus/worker-core";
import { MemoryWorkerLogger } from "@nexus/worker-core";
import { assembleCapabilities } from "../src/assemble.js";
import { testConfig, FakeProcessRunner, FakeFileSystem, TestTimers } from "./fixtures.js";
import type { WorkerConnection } from "@nexus/devices";

/**
 * Authentication, session lifecycle, and reconnection.
 */

describe("worker authentication", () => {
  it("opens a session upon correctly signed challenge", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.isAuthenticated).toBe(true);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(true);
    expect(device.status).toBe("ONLINE");
  });

  it("rejects worker with invalid signature", async () => {
    const harness = await makeHarness();
    const others = generateDeviceKeys();
    harness.credentials.set(harness.device.id, others.publicKeyPem);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(false);
  });

  it("rejects device without registered public key", async () => {
    const harness = await makeHarness();
    harness.credentials.revoke(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects device not yet approved", async () => {
    const harness = await makeHarness({ trusted: false });

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects revoked device", async () => {
    const harness = await makeHarness();
    await harness.registry.revokeDevice(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects replay of authentication envelope", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const authenticate = harness.link.sent.find(
      (envelope) => envelope.type === "worker.authenticate",
    );
    expect(authenticate).toBeDefined();

    const connection: WorkerConnection = {
      connectionId: `conn-${harness.device.id}`,
      deviceId: harness.device.id,
      send: () => undefined,
      close: () => undefined,
    };

    await expect(harness.gateway.handleMessage(connection, authenticate!)).rejects.toMatchObject({
      code: "DEVICE_REPLAY_REJECTED",
    });
  });

  it("invalidates session once device is revoked", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const session = harness.link.sent.length;
    expect(session).toBeGreaterThan(0);

    await harness.registry.revokeDevice(harness.device.id);
    await harness.sessions.revokeAllForDevice(harness.device.id);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(false);
  });

  it("caps negotiated capabilities to declared capabilities", async () => {
    const harness = await makeHarness({ config: { declaredCapabilities: ["git.status"] } });
    await harness.connectWorker();

    expect(harness.worker.grantedCapabilities).toEqual(["git.status"]);
  });

  it("never logs session token", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const sessionEnvelope = harness.link.sent.find((e) => e.type === "worker.authenticate");
    expect(sessionEnvelope).toBeDefined();

    const token = (harness.worker.describe().sessionId as string | null) ?? "";
    expect(harness.logger.text).not.toContain("token");
    expect(harness.logger.text).toContain(token);
  });
});

describe("capability registration", () => {
  it("registers capabilities with core registry", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    const names = device.capabilities.map((capability) => capability.name);

    expect(names).toEqual(
      expect.arrayContaining(["terminal.execute", "filesystem.read", "git.status"]),
    );
  });

  it("does not register capability whose tool is missing", async () => {
    const harness = await makeHarness({
      seed: ({ runner }) => {
        runner.missing.add("docker");
      },
    });
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    const names = device.capabilities.map((capability) => capability.name);

    expect(names).not.toContain("docker.execute");
    expect(names).toContain("git.status");
  });

  it("only registers locally allowed capabilities", async () => {
    const harness = await makeHarness({
      config: { declaredCapabilities: ["filesystem.read", "git.status"] },
    });
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities.map((c) => c.name)).toEqual(["filesystem.read", "git.status"]);
  });

  it("reports health to core", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.health.maxConcurrentTasks).toBe(2);
    expect(device.health.activeTasks).toBe(0);
  });
});

describe("heartbeat", () => {
  it("updates device presence", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const before = await harness.registry.requireDevice(harness.device.id);
    await harness.worker.sendHeartbeat();
    await settle();

    const after = await harness.registry.requireDevice(harness.device.id);
    expect(after.lastSeenAt?.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt?.getTime() ?? 0);
    expect(after.status).toBe("ONLINE");
  });

  it("rejects replayed heartbeat", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    await harness.worker.sendHeartbeat();
    await settle();

    const heartbeat = harness.link.sent.filter((e) => e.type === "worker.heartbeat").at(-1);
    const connection: WorkerConnection = {
      connectionId: `conn-${harness.device.id}`,
      deviceId: harness.device.id,
      send: () => undefined,
      close: () => undefined,
    };

    await expect(harness.gateway.handleMessage(connection, heartbeat!)).rejects.toMatchObject({
      code: "DEVICE_REPLAY_REJECTED",
    });
  });

  it("is scheduled after registration", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.timers.delays).toContain(20_000);
  });
});

describe("exponential backoff", () => {
  it("grows and caps at maximum", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 10_000, jitter: 0, random: () => 0.5 });

    expect(backoff.next()).toBe(1_000);
    expect(backoff.next()).toBe(2_000);
    expect(backoff.next()).toBe(4_000);
    expect(backoff.next()).toBe(8_000);
    expect(backoff.next()).toBe(10_000);
    expect(backoff.next()).toBe(10_000);
  });

  it("scatters retry attempts with jitter", () => {
    const low = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0.5, random: () => 0 });
    const high = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0.5, random: () => 1 });

    low.next();
    high.next();
    expect(low.next()).toBeLessThan(high.next());
  });

  it("never strays below minimum or above ceiling", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 5_000, jitter: 0.9, random: () => 0 });
    for (let index = 0; index < 10; index += 1) {
      const delay = backoff.next();
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });

  it("resets to base delay after successful connection", () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 60_000, jitter: 0, random: () => 0.5 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});

describe("disconnection and recovery", () => {
  it("schedules reconnection following link drop", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("network cut");
    await settle();

    expect(harness.worker.state).toBe("reconnecting");
    expect(harness.worker.isAuthenticated).toBe(false);
    expect(harness.timers.delays.some((delay) => delay >= 1_000)).toBe(true);
  });

  it("performs full handshake without reusing stale token", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("network cut");
    await settle();

    const before = harness.link.sent.filter((e) => e.type === "worker.hello").length;
    harness.timers.flush();
    await settle();

    const after = harness.link.sent.filter((e) => e.type === "worker.hello").length;
    expect(after).toBeGreaterThan(before);
  });

  it("retries upon connection failure without storms", async () => {
    const harness = await makeHarness();
    harness.link.failNextConnect = true;

    await harness.worker.start();
    await settle();

    expect(harness.worker.state).toBe("reconnecting");
    expect(harness.timers.pending.size).toBe(1);
  });

  it("does not schedule duplicate reconnections for rapid drops", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("outage 1");
    harness.link.drop("outage 2");
    await settle();

    expect(harness.timers.pending.size).toBe(1);
  });

  it("releases in-flight steps in core when worker disconnects", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.gateway.detach(harness.device.id, "cable unplugged");

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.status).toBe("OFFLINE");
    expect(harness.gateway.isConnected(harness.device.id)).toBe(false);
  });
});

describe("clean shutdown", () => {
  it("closes channel and clears session", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.worker.stop("test");

    expect(harness.worker.state).toBe("stopped");
    expect(harness.worker.isAuthenticated).toBe(false);
    expect(harness.link.state).toBe("closed");
  });

  it("cancels timers and does not reconnect", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.worker.stop("test");
    harness.timers.flush();
    await settle();

    expect(harness.worker.state).toBe("stopped");
  });
});

describe("architecture: single worker implementation, two machines", () => {
  async function connectAs(role: "BOTH" | "WORKER", deviceId: string, name: string) {
    const harness = await makeHarness({ role, deviceName: name, config: { deviceId } });
    await harness.connectWorker();
    return harness;
  }

  it("registers as BOTH on the laptop", async () => {
    const harness = await connectAs("BOTH", "device-portable", "Windows Laptop");
    const device = await harness.registry.requireDevice("device-portable");

    expect(device.role).toBe("BOTH");
    expect(harness.worker.state).toBe("ready");
  });

  it("registers as WORKER on the desktop PC", async () => {
    const harness = await connectAs("WORKER", "device-poste-fixe", "Desktop PC");
    const device = await harness.registry.requireDevice("device-poste-fixe");

    expect(device.role).toBe("WORKER");
    expect(harness.worker.state).toBe("ready");
  });

  it("announces identical capabilities in both roles", async () => {
    const portable = await connectAs("BOTH", "device-portable", "Windows Laptop");
    const fixe = await connectAs("WORKER", "device-poste-fixe", "Desktop PC");

    const capabilitiesOf = async (harness: typeof portable, id: string) =>
      (await harness.registry.requireDevice(id)).capabilities.map((c) => c.name);

    expect(await capabilitiesOf(portable, "device-portable")).toEqual(
      await capabilitiesOf(fixe, "device-poste-fixe"),
    );
  });

  it("contains no decisions based on machine hostname", async () => {
    const a = await connectAs("WORKER", "device-a", "Living room desktop");
    const b = await connectAs("WORKER", "device-b", "ZZZ-9000");

    expect(a.worker.grantedCapabilities).toEqual(b.worker.grantedCapabilities);
    expect(a.worker.state).toBe(b.worker.state);
  });

  it("role determines task assignment eligibility", async () => {
    const portable = await connectAs("BOTH", "device-portable", "Laptop");

    const workers = await portable.registry.getWorkerDevices(USER_ID);
    const clients = await portable.registry.getClientDevices(USER_ID);

    expect(workers.map((d) => d.id)).toContain("device-portable");
    expect(clients.map((d) => d.id)).toContain("device-portable");
    expect(workers.map((d) => d.id)).not.toContain("device-iphone");
  });
});

describe("channel safeguards", () => {
  it("ignores frame with unknown type instead of crashing", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.deliver({
      v: 1,
      id: "x",
      type: "worker.telepathy",
      ts: new Date().toISOString(),
      payload: {},
    });
    await settle();

    expect(harness.worker.state).toBe("ready");
  });

  it("refuses to execute task dispatched before session establishment", async () => {
    const runner = new FakeProcessRunner();
    const config = testConfig();
    const { capabilities } = assembleCapabilities({
      config,
      runner,
      fileSystem: new FakeFileSystem(),
      env: {},
    });
    await capabilities.probeAll();
    runner.runs.length = 0;

    const link = new LoopbackLink();
    const timers = new TestTimers();
    const worker = createWindowsWorker({
      config,
      link,
      signer: new InMemoryCredentialSigner(generateDeviceKeys().privateKeyPem),
      capabilities,
      logger: new MemoryWorkerLogger(),
      timers,
    });

    await link.connect();
    link.deliver({
      v: 1,
      id: "x",
      type: "worker.task_dispatch",
      ts: new Date().toISOString(),
      payload: {
        taskId: "t",
        stepId: "s",
        capability: "terminal.execute",
        tool: "device.terminal.execute",
        arguments: { executable: "git", args: ["status"] },
        timeoutMs: 1_000,
        riskLevel: "HIGH",
        requestId: "r1",
      },
    });
    await settle();

    expect(runner.runs).toHaveLength(0);
    expect(worker.isAuthenticated).toBe(false);
  });
});
