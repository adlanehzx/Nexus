import { describe, expect, it } from "vitest";
import { NoEligibleWorkerError } from "../src/errors.js";
import { canAcceptTasks, canReceiveEvents } from "../src/types.js";
import { defaultRiskFor } from "../src/tools.js";
import {
  ALL_PERMISSIONS,
  DESKTOP,
  IPHONE,
  LAPTOP,
  REDMI,
  USER_ID,
  makeHarness,
  setupFleet,
} from "./fixtures.js";

/**
 * Fleet device roles and worker selection behavior.
 *
 * No test hardcodes a specific device in a selection decision: they declare
 * required capabilities and verify which candidate is selected based on scoring.
 */

describe("fleet roles", () => {
  it("iPhone is a client, never a worker", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const iphone = await h.registry.requireDevice(IPHONE.id);
    expect(iphone.role).toBe("CLIENT");
    expect(canAcceptTasks(iphone.role)).toBe(false);
    expect(canReceiveEvents(iphone.role)).toBe(true);
  });

  it("Windows laptop is both client and worker", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const laptop = await h.registry.requireDevice(LAPTOP.id);
    expect(laptop.role).toBe("BOTH");
    expect(canAcceptTasks(laptop.role)).toBe(true);
    expect(canReceiveEvents(laptop.role)).toBe(true);
  });

  it("desktop is a worker, not a client", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const desktop = await h.registry.requireDevice(DESKTOP.id);
    expect(desktop.role).toBe("WORKER");
    expect(canAcceptTasks(desktop.role)).toBe(true);
    expect(canReceiveEvents(desktop.role)).toBe(false);
  });

  it("Redmi is an Android worker", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const redmi = await h.registry.requireDevice(REDMI.id);
    expect(redmi.role).toBe("WORKER");
    expect(redmi.type).toBe("ANDROID");
    expect(canAcceptTasks(redmi.role)).toBe(true);
  });

  it("groups devices by role", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const clients = (await h.registry.getClientDevices(USER_ID)).map((d) => d.id).sort();
    const workers = (await h.registry.getWorkerDevices(USER_ID)).map((d) => d.id).sort();

    // Laptop appears in both lists: the core purpose of BOTH.
    expect(clients).toEqual([IPHONE.id, LAPTOP.id].sort());
    expect(workers).toEqual([DESKTOP.id, LAPTOP.id, REDMI.id].sort());
  });
});

describe("worker selection", () => {
  it("never selects a client, even if it has the capability", async () => {
    const h = makeHarness();
    // iPhone declares notification.push; Redmi also supports notifications.
    await setupFleet(h);

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["notification.push"],
      userPermissions: ALL_PERMISSIONS,
    });

    // iPhone has capability but role CLIENT: rejected upfront.
    expect(selection.device.id).not.toBe(IPHONE.id);
    expect(selection.rejected.find((r) => r.deviceId === IPHONE.id)?.reason).toContain("client");
  });

  it("accepts laptop as worker because role is BOTH", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [IPHONE, LAPTOP] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["terminal.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(LAPTOP.id);
  });

  it("filters out offline workers", async () => {
    const h = makeHarness();
    await setupFleet(h, { online: [LAPTOP.id] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["docker.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(LAPTOP.id);
    expect(selection.rejected.find((r) => r.deviceId === DESKTOP.id)?.reason).toBe("offline");
  });

  it("filters out online but unauthenticated workers", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    await h.registry.setAuthenticated(DESKTOP.id, false);
    await h.registry.updateDevice(DESKTOP.id, { status: "ONLINE" });

    await expect(
      h.selector.select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: ALL_PERMISSIONS,
      }),
    ).rejects.toBeInstanceOf(NoEligibleWorkerError);
  });

  it("filters out unapproved workers", async () => {
    const h = makeHarness();
    // Powered on and authenticated, but trust was never established.
    await setupFleet(h, { devices: [DESKTOP], trusted: [] });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: ALL_PERMISSIONS,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("not approved yet");
  });

  it("filters out workers whose permissions are not granted", async () => {
    const h = makeHarness();
    await setupFleet(h, {
      devices: [DESKTOP],
      permissions: { [DESKTOP.id]: ["filesystem.read"] },
    });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: [],
      })
      .catch((e: unknown) => e);

    // Capability is present, permission is not.
    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("permission not granted");
  });

  it("filters out workers missing required capabilities", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [REDMI] });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["docker.execute"],
        userPermissions: ALL_PERMISSIONS,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("missing capability");
  });

  it("filters out revoked devices", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP, LAPTOP] });
    await h.registry.revokeDevice(DESKTOP.id);

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["terminal.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(LAPTOP.id);
    expect(selection.rejected.find((r) => r.deviceId === DESKTOP.id)?.reason).toBe(
      "device revoked",
    );
  });

  it("selects the most available among equivalent workers", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });

    // Laptop is loaded; desktop is idle.
    await h.registry.updateHealth(LAPTOP.id, {
      activeTasks: 2,
      maxConcurrentTasks: 3,
      cpuLoad: 0.9,
    });
    await h.registry.updateHealth(DESKTOP.id, {
      activeTasks: 0,
      maxConcurrentTasks: 3,
      cpuLoad: 0.1,
    });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
    });

    expect(selection.device.id).toBe(DESKTOP.id);
    expect(selection.candidates).toHaveLength(2);
    expect(selection.candidates[0]?.score).toBeGreaterThan(selection.candidates[1]?.score ?? 0);
  });

  it("respects explicit user preference when device remains eligible", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });
    await h.registry.updateHealth(LAPTOP.id, { activeTasks: 2, maxConcurrentTasks: 3 });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
      preferredDeviceId: LAPTOP.id,
    });

    // Laptop has higher load, but user explicitly preferred it.
    expect(selection.device.id).toBe(LAPTOP.id);
  });

  it("ignores preferences targeting ineligible devices", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP], online: [LAPTOP.id] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
      preferredDeviceId: DESKTOP.id,
    });

    // Preference cannot make an offline device eligible.
    expect(selection.device.id).toBe(LAPTOP.id);
  });

  it("filters out saturated workers", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    await h.registry.updateHealth(DESKTOP.id, { activeTasks: 2, maxConcurrentTasks: 2 });

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["terminal.execute"],
        userPermissions: ALL_PERMISSIONS,
      })
      .catch((e: unknown) => e);

    expect((error as NoEligibleWorkerError).userMessage).toContain("busy");
  });

  it("filters out workers when device type does not match constraints", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const error = await h.selector
      .select({
        userId: USER_ID,
        requiredCapabilities: ["git.execute"],
        userPermissions: ALL_PERMISSIONS,
        constraints: { deviceTypes: ["ANDROID"] },
      })
      .catch((e: unknown) => e);

    // Two Windows machines can do it, but constraints exclude them.
    expect(error).toBeInstanceOf(NoEligibleWorkerError);
    expect((error as NoEligibleWorkerError).userMessage).toContain("does not match");
  });

  it("filters out battery-powered devices when mains power is required", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [LAPTOP, DESKTOP] });

    const selection = await h.selector.select({
      userId: USER_ID,
      requiredCapabilities: ["git.execute"],
      userPermissions: ALL_PERMISSIONS,
      constraints: { requireMainsPower: true },
    });

    expect(selection.device.id).toBe(DESKTOP.id);
    expect(selection.rejected.find((r) => r.deviceId === LAPTOP.id)?.reason).toContain("battery");
  });
});

describe("registry", () => {
  it("finds devices by capability without filtering on status", async () => {
    const h = makeHarness();
    await setupFleet(h, { online: [] });

    const capable = await h.registry.getDevicesByCapability(USER_ID, ["docker.execute"]);
    expect(capable.map((d) => d.id).sort()).toEqual([DESKTOP.id, LAPTOP.id].sort());
  });

  it("requires all requested capabilities", async () => {
    const h = makeHarness();
    await setupFleet(h);

    const capable = await h.registry.getDevicesByCapability(USER_ID, [
      "docker.execute",
      "android.notification",
    ]);
    expect(capable).toHaveLength(0);
  });

  it("updates declared capabilities and removes deprecated ones", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });

    await h.registry.updateCapabilities(DESKTOP.id, [
      { name: "filesystem.read", version: "1", description: "", enabled: true, metadata: {} },
    ]);

    const device = await h.registry.requireDevice(DESKTOP.id);
    expect(device.capabilities.map((c) => c.name)).toEqual(["filesystem.read"]);
    expect(await h.registry.getDevicesByCapability(USER_ID, ["docker.execute"])).toHaveLength(0);
  });

  it("marks devices offline after heartbeat timeout", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    expect((await h.registry.requireDevice(DESKTOP.id)).status).toBe("ONLINE");

    h.clock.now = new Date(h.clock.now.getTime() + 120_000);

    expect((await h.registry.requireDevice(DESKTOP.id)).status).toBe("OFFLINE");
  });

  it("heartbeat does not revive a revoked device", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });
    await h.registry.revokeDevice(DESKTOP.id);

    await h.registry.updateHeartbeat(DESKTOP.id);

    const device = await h.registry.requireDevice(DESKTOP.id);
    expect(device.status).toBe("REVOKED");
    expect(device.trust).toBe("REVOKED");
  });

  it("trust revocation is reversible while device revocation is permanent", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP] });

    await h.registry.revokeTrust(DESKTOP.id);
    expect((await h.registry.requireDevice(DESKTOP.id)).trust).toBe("PENDING");

    await h.registry.trustDevice(DESKTOP.id);
    expect((await h.registry.requireDevice(DESKTOP.id)).trust).toBe("TRUSTED");

    await h.registry.revokeDevice(DESKTOP.id);
    expect((await h.registry.requireDevice(DESKTOP.id)).revokedAt).not.toBeNull();
  });

  it("initializes newly registered devices as offline and pending trust", async () => {
    const h = makeHarness();
    const device = await h.registry.registerDevice({
      userId: USER_ID,
      name: "New Device",
      type: "LINUX",
      platform: "LINUX",
      role: "WORKER",
    });

    expect(device.status).toBe("OFFLINE");
    expect(device.trust).toBe("PENDING");
    expect(device.authenticated).toBe(false);
  });
});

describe("default capability risk", () => {
  it("graduates browser capabilities from read to purchase", () => {
    expect(defaultRiskFor("browser.navigate")).toBe("LOW");
    expect(defaultRiskFor("browser.interact")).toBe("MEDIUM");
    expect(defaultRiskFor("browser.login")).toBe("HIGH");
    expect(defaultRiskFor("browser.purchase")).toBe("CRITICAL");
  });

  it("purchase remains CRITICAL, not HIGH", () => {
    expect(defaultRiskFor("browser.purchase")).not.toBe("HIGH");
  });

  it("falls back to HIGH for unknown capability", () => {
    expect(defaultRiskFor("unknown.capability")).toBe("HIGH");
  });
});
