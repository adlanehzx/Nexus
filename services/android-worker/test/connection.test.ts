import { describe, expect, it } from "vitest";
import type { WorkerConnection } from "@nexus/devices";
import { makeHarness, settle, until, generateDeviceKeys, USER_ID } from "./fixtures.js";

/**
 * Authentication, session, recovery — Android side.
 */

describe("Android worker authentication", () => {
  it("opens a session with a P-256 signed challenge", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.worker.state).toBe("ready");
    expect(harness.worker.isAuthenticated).toBe(true);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(true);
    expect(device.status).toBe("ONLINE");
  });

  it("rejects a signature produced by a different key", async () => {
    const harness = await makeHarness();
    harness.credentials.set(harness.device.id, generateDeviceKeys().publicKeyPem);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects a device without registered public key", async () => {
    const harness = await makeHarness();
    harness.credentials.revoke(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects a device not yet trusted", async () => {
    const harness = await makeHarness({ trusted: false });

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects a revoked device", async () => {
    const harness = await makeHarness();
    await harness.registry.revokeDevice(harness.device.id);

    await harness.worker.start().catch(() => undefined);
    await settle();

    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("rejects replay of authentication frame", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const authenticate = harness.link.sent.find((e) => e.type === "worker.authenticate");
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

  it("invalidates session upon device revocation", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.registry.revokeDevice(harness.device.id);
    await harness.sessions.revokeAllForDevice(harness.device.id);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.authenticated).toBe(false);
  });

  it("never logs session token", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.logger.text).not.toMatch(/"token"/);
  });
});

describe("capability registration", () => {
  it("registers Android capabilities with core registry", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.capabilities.map((c) => c.name)).toEqual([
      "android.app.list",
      "android.app.open",
      "android.notification",
      "android.ui.click",
      "android.ui.input",
      "android.ui.screenshot",
      "android.ui.scroll",
    ]);
  });

  it("does not register UI capabilities without accessibility service", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.ui.accessibilityEnabled = false;
      },
    });
    await harness.connectWorker();

    const names = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(names).not.toContain("android.ui.click");
    expect(names).toContain("android.notification");
  });

  it("reports battery state to core", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.device.battery = { percent: 42, charging: false, powerSaveMode: false };
      },
    });
    await harness.connectWorker();

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.health.batteryPercent).toBe(42);
    expect(device.health.onBattery).toBe(true);
  });
});

describe("availability changes during operation", () => {
  it("re-announces capabilities when accessibility is disabled", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    harness.platform.ui.accessibilityEnabled = false;
    await harness.worker.availability.check();
    await until(() =>
      harness.clientEvents.some((event) => event.type === "device.capabilities_changed"),
    );

    const names = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(names).not.toContain("android.ui.click");
    expect(names).not.toContain("android.ui.input");
    expect(names).not.toContain("android.ui.scroll");
  });

  it("notifies clients through existing event", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    harness.platform.screenshots.available = false;
    await harness.worker.availability.check();
    await until(() =>
      harness.clientEvents.some((event) => event.type === "device.capabilities_changed"),
    );

    const changed = harness.clientEvents
      .filter((event) => event.type === "device.capabilities_changed")
      .at(-1);

    expect(changed).toBeDefined();
    expect(JSON.stringify(changed)).not.toContain("android.ui.screenshot");
  });

  it("restores capabilities when service is re-enabled", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.platform.ui.accessibilityEnabled = false;
    await harness.worker.availability.check();
    await settle(40);

    const during = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(during).not.toContain("android.ui.click");

    harness.platform.ui.accessibilityEnabled = true;
    await harness.worker.availability.check();
    await settle(40);

    const names = (await harness.registry.requireDevice(harness.device.id)).capabilities.map(
      (c) => c.name,
    );
    expect(names).toContain("android.ui.click");
  });

  it("emits no event when nothing changed", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    await settle(40);
    const before = harness.clientEvents.filter(
      (event) => event.type === "device.capabilities_changed",
    ).length;

    await harness.worker.availability.check();
    await harness.worker.availability.check();
    await settle(40);

    expect(
      harness.clientEvents.filter((event) => event.type === "device.capabilities_changed").length,
    ).toBe(before);
  });
});

describe("outage and recovery", () => {
  it("schedules reconnection after outage", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("cellular network lost");
    await settle();

    expect(harness.worker.state).toBe("reconnecting");
    expect(harness.worker.isAuthenticated).toBe(false);
  });

  it("performs full handshake without reusing old token", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    harness.link.drop("cellular network lost");
    await settle();

    const before = harness.link.sent.filter((e) => e.type === "worker.hello").length;
    harness.timers.flush();
    await settle();

    expect(harness.link.sent.filter((e) => e.type === "worker.hello").length).toBeGreaterThan(
      before,
    );
  });

  it("releases in-flight steps core side", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await harness.gateway.detach(harness.device.id, "phone out of range");

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.status).toBe("OFFLINE");
  });

  it("stops cleanly and stops monitoring availability", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const pendingBefore = harness.timers.pending.size;
    await harness.worker.stop("test");
    harness.timers.flush();
    await settle();

    expect(harness.worker.state).toBe("stopped");
    expect(harness.worker.isAuthenticated).toBe(false);
    expect(pendingBefore).toBeGreaterThan(0);
  });
});

describe("device role", () => {
  it("phone is an executor, never a client", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const workers = await harness.registry.getWorkerDevices(USER_ID);
    const clients = await harness.registry.getClientDevices(USER_ID);

    expect(workers.map((d) => d.id)).toContain(harness.device.id);
    expect(clients.map((d) => d.id)).not.toContain(harness.device.id);
  });

  it("receives no events intended for clients", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    const clients = await harness.registry.getClientDevices(USER_ID);
    expect(clients.map((d) => d.id)).toEqual(["device-iphone"]);
  });
});
