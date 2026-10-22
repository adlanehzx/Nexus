import { describe, expect, it } from "vitest";
import { localWorkerStatus, remoteWorkers, type ObservedDevice } from "../src/lib/worker-status.js";

/**
 * Local worker view from desktop UI.
 *
 * Verifies core-reported status, state mapping, and fleet filtering.
 */

const LAPTOP = "device-laptop";

function device(patch: Partial<ObservedDevice> = {}): ObservedDevice {
  return {
    id: LAPTOP,
    name: "Windows Laptop",
    role: "BOTH",
    status: "ONLINE",
    capabilities: ["terminal.execute", "filesystem.read"],
    health: { activeTasks: 0, maxConcurrentTasks: 2 },
    ...patch,
  };
}

describe("detection", () => {
  it("reports absent worker instead of fabricating one", () => {
    const status = localWorkerStatus({ localWorkerDeviceId: null, devices: [device()] });

    expect(status.state).toBe("absent");
    expect(status.deviceId).toBeNull();
    expect(status.acceptingTasks).toBe(false);
  });

  it("distinguishes installed daemon from core-recognized device", () => {
    const status = localWorkerStatus({ localWorkerDeviceId: LAPTOP, devices: [] });

    expect(status.state).toBe("unpaired");
    expect(status.summary).toContain("pairing");
  });

  it("recognizes this machine in core device list", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ id: "device-desktop", name: "Desktop Workstation" }), device()],
    });

    expect(status.state).toBe("online");
    expect(status.name).toBe("Windows Laptop");
    expect(status.capabilities).toContain("terminal.execute");
  });
});

describe("states", () => {
  it("reports offline when core loses connection", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ status: "OFFLINE" })],
    });

    expect(status.state).toBe("offline");
    expect(status.acceptingTasks).toBe(false);
  });

  it("distinguishes degraded from offline", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ status: "DEGRADED" })],
    });

    expect(status.state).toBe("degraded");
    expect(status.summary).toContain("another machine");
  });

  it("reports pending approval when trust is not granted", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ trust: "PENDING" })],
    });

    expect(status.state).toBe("pending");
  });

  it("revoked status overrides all other statuses", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ status: "ONLINE", trust: "REVOKED" })],
    });

    expect(status.state).toBe("revoked");
    expect(status.acceptingTasks).toBe(false);
  });
});

describe("load", () => {
  it("saturated worker stops accepting tasks", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ health: { activeTasks: 2, maxConcurrentTasks: 2 } })],
    });

    expect(status.state).toBe("online");
    expect(status.acceptingTasks).toBe(false);
    expect(status.summary).toContain("saturated");
  });

  it("counts active tasks", () => {
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [device({ health: { activeTasks: 1, maxConcurrentTasks: 4 } })],
    });

    expect(status.activeTasks).toBe(1);
    expect(status.maxConcurrentTasks).toBe(4);
    expect(status.acceptingTasks).toBe(true);
  });

  it("survives devices missing health data", () => {
    const { health: _health, ...withoutHealth } = device();
    const status = localWorkerStatus({
      localWorkerDeviceId: LAPTOP,
      devices: [withoutHealth],
    });

    expect(status.state).toBe("online");
    expect(status.maxConcurrentTasks).toBe(1);
  });
});

describe("remainder of fleet", () => {
  const fleet: ObservedDevice[] = [
    device(),
    device({ id: "device-desktop", name: "Desktop Workstation", role: "WORKER" }),
    device({ id: "device-redmi", name: "Redmi Note 10S", role: "WORKER" }),
    device({ id: "device-iphone", name: "iPhone", role: "CLIENT", capabilities: [] }),
  ];

  it("lists remote workers without self-inclusion", () => {
    const remotes = remoteWorkers({ localWorkerDeviceId: LAPTOP, devices: fleet });

    expect(remotes.map((dev) => dev.name)).toEqual(["Desktop Workstation", "Redmi Note 10S"]);
  });

  it("excludes pure clients", () => {
    const remotes = remoteWorkers({ localWorkerDeviceId: LAPTOP, devices: fleet });

    expect(remotes.some((dev) => dev.role === "CLIENT")).toBe(false);
  });
});
