import { describe, expect, it } from "vitest";
import {
  KNOWN_PERMISSIONS,
  PERMISSION_PRESETS,
  classifyConnection,
  failedSteps,
  formatAge,
  formatCount,
  formatDuration,
  formatLatency,
  overallHealth,
  selectedWorkers,
  sortActivity,
  workerState,
} from "../src/lib/format.js";
import type { HealthEntry, TaskRow, WorkerRow } from "../src/lib/api.js";

/**
 * Dashboard formatting and status resolution tests.
 */

function health(level: HealthEntry["level"], name = "X"): HealthEntry {
  return { name, level, detail: "" };
}

describe("overall health", () => {
  it("worst state wins", () => {
    expect(overallHealth([health("ok"), health("degraded"), health("down")])).toBe("down");
    expect(overallHealth([health("ok"), health("degraded")])).toBe("degraded");
    expect(overallHealth([health("ok"), health("ok")])).toBe("ok");
  });

  it("unconfigured components do not count as failures", () => {
    expect(overallHealth([health("ok"), health("unconfigured")])).toBe("ok");
  });

  it("reports unknown when nothing is measured", () => {
    expect(overallHealth([health("unconfigured"), health("unconfigured")])).toBe("unknown");
    expect(overallHealth([])).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function worker(patch: Partial<WorkerRow> = {}): WorkerRow {
  return {
    id: "w1",
    name: "Laptop",
    role: "BOTH",
    type: "WINDOWS_PC",
    platform: "WINDOWS",
    status: "ONLINE",
    trust: "TRUSTED",
    authenticated: true,
    capabilities: [],
    grantedPermissions: [],
    lastHeartbeatAt: null,
    health: {
      activeTasks: 0,
      maxConcurrentTasks: 2,
      cpuLoad: null,
      memoryFreeMb: null,
      diskFreeMb: null,
      batteryPercent: null,
      onBattery: null,
      latencyMs: null,
      reportedAt: null,
    },
    pairedAt: "2026-09-01T10:00:00.000Z",
    revokedAt: null,
    agentVersion: null,
    connected: true,
    acceptingTasks: true,
    ...patch,
  };
}

describe("worker state", () => {
  it("available when channel is open and capacity allows", () => {
    expect(workerState(worker())).toBe("accepting");
  });

  it("closed channel takes precedence over online registry status", () => {
    expect(workerState(worker({ connected: false }))).toBe("disconnected");
  });

  it("revocation takes precedence over all other states", () => {
    expect(workerState(worker({ trust: "REVOKED", status: "ONLINE", connected: true }))).toBe(
      "revoked",
    );
  });

  it("distinguishes saturated from degraded", () => {
    const saturated = worker({
      health: { ...worker().health, activeTasks: 2, maxConcurrentTasks: 2 },
    });
    expect(workerState(saturated)).toBe("saturated");
    expect(workerState(worker({ status: "DEGRADED" }))).toBe("degraded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function task(steps: TaskRow["steps"]): TaskRow {
  return {
    id: "t1",
    title: "Task",
    status: "running",
    originClientDeviceId: "device-iphone",
    correlationId: "corr-1",
    createdAt: "2026-09-03T10:00:00.000Z",
    startedAt: "2026-09-03T10:00:00.000Z",
    completedAt: null,
    progressPercent: 50,
    source: "device",
    steps,
  };
}

function step(patch: Partial<TaskRow["steps"][number]> = {}): TaskRow["steps"][number] {
  return {
    id: "s1",
    description: "Step",
    tool: "device.terminal.execute",
    requiredCapabilities: ["terminal.execute"],
    status: "succeeded",
    selectedDeviceId: null,
    selectedDeviceName: null,
    riskLevel: "SAFE",
    error: null,
    ...patch,
  };
}

describe("selected workers", () => {
  it("counts steps per worker machine", () => {
    const assigned = selectedWorkers(
      task([
        step({ id: "s1", selectedDeviceId: "d1", selectedDeviceName: "Laptop" }),
        step({ id: "s2", selectedDeviceId: "d1", selectedDeviceName: "Laptop" }),
        step({ id: "s3", selectedDeviceId: "d2", selectedDeviceName: "Workstation" }),
      ]),
    );

    expect(assigned).toEqual([
      { id: "d1", name: "Laptop", steps: 2 },
      { id: "d2", name: "Workstation", steps: 1 },
    ]);
  });

  it("ignores undispatched steps", () => {
    expect(selectedWorkers(task([step()]))).toEqual([]);
  });

  it("falls back to device identifier when name is missing", () => {
    const assigned = selectedWorkers(
      task([step({ selectedDeviceId: "d-missing", selectedDeviceName: null })]),
    );

    expect(assigned[0]?.name).toBe("d-missing");
  });
});

describe("failed steps", () => {
  it("filters steps carrying an error or failed status", () => {
    const found = failedSteps(
      task([
        step({ id: "ok", status: "succeeded" }),
        step({ id: "ko", status: "failed" }),
        step({ id: "err", status: "succeeded", error: { code: "X", message: "y" } }),
      ]),
    );

    expect(found.map((entry) => entry.id)).toEqual(["ko", "err"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("formatting", () => {
  it("formats durations across orders of magnitude", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });

  it("formats relative timestamps readably", () => {
    const now = new Date("2026-09-03T12:00:00.000Z");

    expect(formatAge(null)).toBe("never");
    expect(formatAge("2026-09-03T11:59:30.000Z", now)).toBe("30s ago");
    expect(formatAge("2026-09-03T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatAge("2026-09-03T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatAge("2026-09-01T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("handles unparseable timestamps gracefully", () => {
    expect(formatAge("not a date")).toBe("—");
  });

  it("keeps counters compact", () => {
    expect(formatCount(42)).toBe("42");
    expect(formatCount(1_500)).toBe("1.5 k");
    expect(formatCount(2_400_000)).toBe("2.4 M");
  });

  it("sorts activity chronologically, newest first", () => {
    const sorted = sortActivity([
      { at: "2026-09-03T10:00:00.000Z", kind: "task", summary: "older", level: "info" },
      { at: "2026-09-03T12:00:00.000Z", kind: "run", summary: "newer", level: "info" },
    ]);

    expect(sorted.map((entry) => entry.summary)).toEqual(["newer", "older"]);
  });
});

describe("classifyConnection distinguishes all 7 mandatory states", () => {
  it("distinguishes not installed", () => {
    const uninstalled = classifyConnection({
      supportedOnThisHost: true,
      observation: { state: "not_installed" },
    });
    expect(uninstalled.key).toBe("not_installed");
    expect(uninstalled.label).toBe("Not installed");

    const unsupported = classifyConnection({
      supportedOnThisHost: false,
      observation: null,
    });
    expect(unsupported.key).toBe("not_installed");
  });

  it("distinguishes detected", () => {
    const detected = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "detected",
        adapter: { availability: "available" },
        authStatus: "authenticated",
      },
    });
    expect(detected.key).toBe("detected");
    expect(detected.label).toBe("Detected");
  });

  it("distinguishes missing adapter", () => {
    const missing = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "detected",
        adapter: { availability: "missing" },
        authStatus: "authenticated",
      },
    });
    expect(missing.key).toBe("missing_adapter");
    expect(missing.label).toBe("Adapter missing");
  });

  it("distinguishes connection required", () => {
    const authRequired = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "authentication_required",
        adapter: { availability: "available" },
        authStatus: "unauthenticated",
      },
    });
    expect(authRequired.key).toBe("connection_required");
    expect(authRequired.label).toBe("Connection required");

    const expired = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "expired",
        adapter: { availability: "available" },
        authStatus: "expired",
      },
    });
    expect(expired.key).toBe("connection_required");
  });

  it("distinguishes connected", () => {
    const connected = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "connected",
        adapter: { availability: "available" },
        authStatus: "authenticated",
      },
    });
    expect(connected.key).toBe("connected");
    expect(connected.label).toBe("Connected");
  });

  it("distinguishes degraded", () => {
    const degraded = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "degraded",
        adapter: { availability: "available" },
        authStatus: "authenticated",
      },
    });
    expect(degraded.key).toBe("degraded");
    expect(degraded.label).toBe("Degraded");
  });

  it("distinguishes failed", () => {
    const failed = classifyConnection({
      supportedOnThisHost: true,
      observation: {
        state: "error",
        adapter: { availability: "available" },
        authStatus: "authenticated",
      },
    });
    expect(failed.key).toBe("failed");
    expect(failed.label).toBe("Failed");
  });
});

describe("Heartbeat latency formatting (GA4)", () => {
  it("formats null or negative latency as unknown with 0 percent", () => {
    expect(formatLatency(null)).toEqual({ text: "—", tone: "unknown", percent: 0 });
    expect(formatLatency(Number.NaN)).toEqual({ text: "—", tone: "unknown", percent: 0 });
    expect(formatLatency(-10)).toEqual({ text: "—", tone: "unknown", percent: 0 });
  });

  it("formats optimal latency (< 50ms) as ok with bounded percentage", () => {
    const visual = formatLatency(24);
    expect(visual.text).toBe("24 ms");
    expect(visual.tone).toBe("ok");
    expect(visual.percent).toBe(8); // 24 / 300 * 100 = 8%
  });

  it("formats acceptable latency (50-150ms) as degraded", () => {
    const visual = formatLatency(120);
    expect(visual.text).toBe("120 ms");
    expect(visual.tone).toBe("degraded");
    expect(visual.percent).toBe(40);
  });

  it("formats high latency (> 150ms) as down and bounds percentage to 100", () => {
    const visual = formatLatency(240);
    expect(visual.text).toBe("240 ms");
    expect(visual.tone).toBe("down");
    expect(visual.percent).toBe(80);

    const extreme = formatLatency(650);
    expect(extreme.text).toBe("650 ms");
    expect(extreme.tone).toBe("down");
    expect(extreme.percent).toBe(100);
  });
});

describe("Capability & Permission Catalog (GA4)", () => {
  it("defines standard categories covering System, Android, Hardware, HA, and Browser", () => {
    const categories = new Set(KNOWN_PERMISSIONS.map((p) => p.category));
    expect(categories.has("System")).toBe(true);
    expect(categories.has("Android")).toBe(true);
    expect(categories.has("Hardware & Sensors")).toBe(true);
    expect(categories.has("Home Assistant")).toBe(true);
    expect(categories.has("Browser")).toBe(true);
  });

  it("includes presets for common operational profiles", () => {
    expect(PERMISSION_PRESETS.Workstation).toContain("terminal.execute");
    expect(PERMISSION_PRESETS.Workstation).toContain("docker.execute");
    expect(PERMISSION_PRESETS["Read-Only"]).toContain("filesystem.read");
    expect(PERMISSION_PRESETS["Read-Only"]).toContain("homeassistant.read");
    expect(PERMISSION_PRESETS["Clear All"]).toHaveLength(0);
    expect(PERMISSION_PRESETS["Full Automation"]).toContain("gpu.compute");
  });
});
