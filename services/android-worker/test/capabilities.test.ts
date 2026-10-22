import { describe, expect, it } from "vitest";
import type { CapabilityContext, LocalCapabilityRegistry } from "@nexus/worker-core";
import { assembleCapabilities } from "../src/assemble.js";
import { AndroidHealthSource } from "../src/runtime/health.js";
import { AvailabilityWatcher } from "../src/runtime/availability.js";
import { MemoryWorkerLogger } from "@nexus/worker-core";
import { makePlatform, testConfig, type FakePlatform } from "./fixtures.js";
import type { AndroidWorkerConfig } from "../src/config.js";

/**
 * Android capabilities tested individually.
 */

interface Fixture {
  capabilities: LocalCapabilityRegistry;
  platform: FakePlatform;
}

async function assemble(
  overrides: Partial<AndroidWorkerConfig> = {},
  seed?: (platform: FakePlatform) => void,
): Promise<Fixture> {
  const platform = makePlatform();
  seed?.(platform);

  const { capabilities } = assembleCapabilities({ config: testConfig(overrides), platform });
  await capabilities.probeAll();

  return { capabilities, platform };
}

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    taskId: "t1",
    stepId: "s1",
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onProgress: () => undefined,
    ...overrides,
  };
}

async function run(fixture: Fixture, name: string, input: unknown, ctx = context()) {
  const capability = fixture.capabilities.require(name);
  const validated = fixture.capabilities.validateInput(name, input);
  return capability.execute(validated as never, ctx);
}

describe("capability declaration", () => {
  it("announces all seven capabilities when everything is available", async () => {
    const fixture = await assemble();
    expect(fixture.capabilities.declare().map((c) => c.name)).toEqual([
      "android.app.list",
      "android.app.open",
      "android.notification",
      "android.ui.click",
      "android.ui.input",
      "android.ui.screenshot",
      "android.ui.scroll",
    ]);
  });

  it("does not announce UI capabilities if accessibility is disabled", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.ui.accessibilityEnabled = false;
    });

    const declared = fixture.capabilities.declare().map((c) => c.name);
    expect(declared).not.toContain("android.ui.click");
    expect(declared).not.toContain("android.ui.input");
    expect(declared).not.toContain("android.ui.scroll");
    expect(declared).toContain("android.app.open");
    expect(declared).toContain("android.notification");
  });

  it("does not announce screenshot if unavailable", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.screenshots.available = false;
    });
    expect(fixture.capabilities.declare().map((c) => c.name)).not.toContain(
      "android.ui.screenshot",
    );
  });

  it("does not announce notifications if permission is denied", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.notifications.allowed = false;
    });
    expect(fixture.capabilities.declare().map((c) => c.name)).not.toContain("android.notification");
  });

  it("announces only capabilities permitted by configuration", async () => {
    const fixture = await assemble({
      declaredCapabilities: ["android.notification", "android.app.list"],
    });
    expect(fixture.capabilities.declare().map((c) => c.name)).toEqual([
      "android.app.list",
      "android.notification",
    ]);
  });

  it("distinguishes causes of unavailability", async () => {
    const fixture = await assemble({ declaredCapabilities: ["android.app.list"] }, (platform) => {
      platform.ui.accessibilityEnabled = false;
    });

    expect(() => fixture.capabilities.require("android.ui.click")).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNAVAILABLE",
        context: expect.objectContaining({ reason: expect.stringContaining("configuration") }),
      }),
    );
    expect(() => fixture.capabilities.require("registry.nonexistent")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });
});

describe("android.app.list", () => {
  it("lists only launchable and permitted applications", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.list", {})) as {
      apps: { packageName: string }[];
    };

    const names = result.apps.map((app) => app.packageName);
    expect(names).toContain("com.spotify.music");
    expect(names).not.toContain("com.android.settings");
    expect(names).not.toContain("com.example.service");
  });

  it("returns neither version, permissions, nor install date", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.list", {})) as {
      apps: Record<string, unknown>[];
    };

    expect(Object.keys(result.apps[0] ?? {})).toEqual(["packageName", "label"]);
  });

  it("filters by name", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.list", { nameContains: "spot" })) as {
      total: number;
    };
    expect(result.total).toBe(1);
  });

  it("respects allowlist", async () => {
    const fixture = await assemble({ allowedPackages: ["com.whatsapp"] });
    const result = (await run(fixture, "android.app.list", {})) as {
      apps: { packageName: string }[];
    };
    expect(result.apps.map((a) => a.packageName)).toEqual(["com.whatsapp"]);
  });
});

describe("android.app.open", () => {
  it("opens an allowed application", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.app.open", {
      packageName: "com.spotify.music",
    })) as { launched: boolean };

    expect(result.launched).toBe(true);
    expect(fixture.platform.apps.opened).toEqual(["com.spotify.music"]);
  });

  it("rejects invalid package name before any system call", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.app.open", { packageName: "content://settings/secure" }),
    ).rejects.toMatchObject({ code: "WORKER_POLICY_VIOLATION" });

    expect(fixture.platform.apps.opened).toHaveLength(0);
  });

  it("rejects system settings", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.app.open", { packageName: "com.android.settings" }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "app.denied" }) });

    expect(fixture.platform.apps.opened).toHaveLength(0);
  });

  it("distinguishes not installed from system refusal", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.app.open", { packageName: "com.absent.app" }),
    ).rejects.toMatchObject({ code: "ANDROID_APP_NOT_AVAILABLE" });
  });

  it("reports background launch refusal", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.apps.launchBlocked = true;
    });

    const error = (await run(fixture, "android.app.open", {
      packageName: "com.spotify.music",
    }).catch((cause: unknown) => cause)) as { code: string; userMessage: string };

    expect(error.code).toBe("ANDROID_ACTIVITY_LAUNCH_BLOCKED");
    expect(error.userMessage).toContain("MIUI");
  });
});

describe("android.ui.click", () => {
  it("taps element designated by text", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.click", {
      selector: { kind: "text", value: "Search" },
    })) as { clicked: boolean };

    expect(result.clicked).toBe(true);
    expect(fixture.platform.ui.clicks).toHaveLength(1);
  });

  it("rejects if accessibility was disabled in the meantime", async () => {
    const fixture = await assemble();
    fixture.platform.ui.accessibilityEnabled = false;

    await expect(
      run(fixture, "android.ui.click", { selector: { kind: "text", value: "Search" } }),
    ).rejects.toMatchObject({ code: "ANDROID_ACCESSIBILITY_DISABLED", retryable: true });

    expect(fixture.platform.ui.clicks).toHaveLength(0);
  });

  it("rejects when element is not on screen", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.click", { selector: { kind: "text", value: "Missing" } }),
    ).rejects.toMatchObject({ code: "ANDROID_UI_NODE_NOT_FOUND" });
  });

  it("rejects click on non-clickable element", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.click", {
        selector: { kind: "viewId", value: "com.app:id/label" },
      }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "ui.nodeNotClickable" }) });

    expect(fixture.platform.ui.clicks).toHaveLength(0);
  });

  it("rejects coordinate click by default", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.click", { selector: { kind: "coordinates", x: 540, y: 1200 } }),
    ).rejects.toMatchObject({
      context: expect.objectContaining({ rule: "ui.coordinatesDisabled" }),
    });
  });

  it("accepts coordinates when allowed by configuration", async () => {
    const fixture = await assemble({ allowCoordinateClicks: true });
    const result = (await run(fixture, "android.ui.click", {
      selector: { kind: "coordinates", x: 540, y: 1200 },
    })) as { clicked: boolean };

    expect(result.clicked).toBe(true);
  });

  it("propagates cancellation", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.ui.hangUntilAborted = true;
    });

    const controller = new AbortController();
    const pending = run(
      fixture,
      "android.ui.click",
      { selector: { kind: "text", value: "Search" } },
      context({ signal: controller.signal }),
    );

    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("android.ui.input", () => {
  it("inputs text into a field", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.input", {
      selector: { kind: "viewId", value: "com.app:id/field" },
      text: "hello",
    })) as { entered: boolean; characters: number };

    expect(result).toEqual({ entered: true, characters: 5 });
  });

  it("never returns the entered text", async () => {
    const fixture = await assemble();
    const result = await run(fixture, "android.ui.input", {
      selector: { kind: "viewId", value: "com.app:id/field" },
      text: "MyPassword2026",
    });

    expect(JSON.stringify(result)).not.toContain("MyPassword2026");
  });

  it("does not place text in progress updates", async () => {
    const fixture = await assemble();
    const labels: string[] = [];

    await run(
      fixture,
      "android.ui.input",
      { selector: { kind: "viewId", value: "com.app:id/field" }, text: "SecretAbc123" },
      context({
        onProgress: (progress) => {
          if (progress.label !== undefined) labels.push(progress.label);
        },
      }),
    );

    expect(labels.join(" ")).not.toContain("SecretAbc123");
    expect(labels.join(" ")).toContain("12 characters");
  });

  it("rejects input into non-editable element", async () => {
    const fixture = await assemble();
    await expect(
      run(fixture, "android.ui.input", {
        selector: { kind: "viewId", value: "com.app:id/label" },
        text: "x",
      }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ rule: "ui.nodeNotEditable" }) });
  });

  it("rejects text longer than schema limit", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.ui.input", {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "x".repeat(5_000),
      }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("rejects if accessibility service is disabled", async () => {
    const fixture = await assemble();
    fixture.platform.ui.accessibilityEnabled = false;

    await expect(
      run(fixture, "android.ui.input", {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "ANDROID_ACCESSIBILITY_DISABLED" });

    expect(fixture.platform.ui.inputs).toHaveLength(0);
  });
});

describe("android.ui.scroll", () => {
  it("scrolls in the requested direction", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.scroll", {
      direction: "down",
      amount: 3,
    })) as { scrolled: boolean };

    expect(result.scrolled).toBe(true);
    expect(fixture.platform.ui.scrolls).toEqual([{ direction: "down", amount: 3 }]);
  });

  it("rejects unknown direction", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.ui.scroll", { direction: "diagonal" }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("rejects out of bounds amount", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.ui.scroll", { direction: "down", amount: 500 }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("rejects if accessibility service is disabled", async () => {
    const fixture = await assemble();
    fixture.platform.ui.accessibilityEnabled = false;

    await expect(run(fixture, "android.ui.scroll", { direction: "down" })).rejects.toMatchObject({
      code: "ANDROID_ACCESSIBILITY_DISABLED",
    });
  });
});

describe("android.ui.screenshot", () => {
  it("captures screen on demand", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.ui.screenshot", {})) as {
      image: string;
      width: number;
    };

    expect(result.image).toBe("aW1hZ2UtZmFjdGljZQ==");
    expect(fixture.platform.screenshots.captures).toBe(1);
  });

  it("rejects when capture is unavailable", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.screenshots.available = false;
    });

    expect(() => fixture.capabilities.require("android.ui.screenshot")).toThrow(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE" }),
    );
  });

  it("rejects two captures that are too frequent", async () => {
    const fixture = await assemble({ screenshotMinIntervalMs: 60_000 });

    await run(fixture, "android.ui.screenshot", {});
    await expect(run(fixture, "android.ui.screenshot", {})).rejects.toMatchObject({
      context: expect.objectContaining({ rule: "screenshot.rate" }),
    });

    expect(fixture.platform.screenshots.captures).toBe(1);
  });

  it("rejects image exceeding allowed resolution", async () => {
    const fixture = await assemble({ screenshotMaxDimension: 480 }, (platform) => {
      platform.screenshots.image = { ...platform.screenshots.image, width: 1_080, height: 2_400 };
    });

    await expect(run(fixture, "android.ui.screenshot", {})).rejects.toMatchObject({
      context: expect.objectContaining({ rule: "screenshot.tooBig" }),
    });
  });

  it("marks result as sensitive", async () => {
    const fixture = await assemble();
    expect(fixture.capabilities.require("android.ui.screenshot").sensitiveResult).toBe(true);
  });

  it("propagates cancellation", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.screenshots.hangUntilAborted = true;
    });

    const controller = new AbortController();
    const pending = run(
      fixture,
      "android.ui.screenshot",
      {},
      context({ signal: controller.signal }),
    );

    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("android.notification", () => {
  it("posts a notification", async () => {
    const fixture = await assemble();
    const result = (await run(fixture, "android.notification", {
      title: "Tests completed",
      body: "240 passed",
    })) as { posted: boolean };

    expect(result.posted).toBe(true);
    expect(fixture.platform.notifications.posted).toEqual([
      { title: "Tests completed", body: "240 passed" },
    ]);
  });

  it("rejects malformed notification", async () => {
    const fixture = await assemble();
    expect(() =>
      fixture.capabilities.validateInput("android.notification", { title: "", body: "x" }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_INPUT_INVALID" }));
  });

  it("rejects when permission was revoked in the meantime", async () => {
    const fixture = await assemble();
    fixture.platform.notifications.allowed = false;

    await expect(
      run(fixture, "android.notification", { title: "x", body: "y" }),
    ).rejects.toMatchObject({ code: "ANDROID_PERMISSION_DENIED" });

    expect(fixture.platform.notifications.posted).toHaveLength(0);
  });

  it("reports platform failure", async () => {
    const fixture = await assemble({}, (platform) => {
      platform.notifications.failNext = true;
    });

    await expect(run(fixture, "android.notification", { title: "x", body: "y" })).rejects.toThrow();
  });
});

describe("phone health", () => {
  function makeHealth(battery: { percent: number; charging: boolean; powerSaveMode?: boolean }) {
    const platform = makePlatform();
    platform.device.battery = {
      percent: battery.percent,
      charging: battery.charging,
      powerSaveMode: battery.powerSaveMode ?? false,
    };

    return new AndroidHealthSource({
      device: platform.device,
      maxConcurrentTasks: 2,
      activeTasks: () => 0,
      lowBatteryPercent: 20,
      criticalBatteryPercent: 10,
    });
  }

  it("is not degraded with healthy battery", async () => {
    const health = makeHealth({ percent: 80, charging: false });
    await health.refresh();
    expect(health.isDegraded()).toBe(false);
    expect(health.hasCapacity()).toBe(true);
  });

  it("becomes degraded below low battery threshold", async () => {
    const health = makeHealth({ percent: 15, charging: false });
    await health.refresh();
    expect(health.isDegraded()).toBe(true);
    expect(health.snapshot().maxConcurrentTasks).toBe(1);
  });

  it("is not degraded while charging, even at low level", async () => {
    const health = makeHealth({ percent: 5, charging: true });
    await health.refresh();
    expect(health.isDegraded()).toBe(false);
  });

  it("becomes degraded in power save mode", async () => {
    const health = makeHealth({ percent: 90, charging: false, powerSaveMode: true });
    await health.refresh();
    expect(health.isDegraded()).toBe(true);
  });

  it("rejects any task below critical threshold", async () => {
    const health = makeHealth({ percent: 8, charging: false });
    await health.refresh();
    expect(health.hasCapacity()).toBe(false);
  });

  it("retains last known value if read fails", async () => {
    const platform = makePlatform();
    const health = new AndroidHealthSource({
      device: {
        batteryState: () => Promise.reject(new Error("unavailable")),
        sdkVersion: () => platform.device.sdkVersion(),
      },
      maxConcurrentTasks: 1,
      activeTasks: () => 0,
    });

    await health.refresh();
    expect(health.snapshot().activeTasks).toBe(0);
  });

  it("reports neither location, network, nor identity", async () => {
    const health = makeHealth({ percent: 50, charging: false });
    await health.refresh();

    expect(Object.keys(health.snapshot()).sort()).toEqual([
      "activeTasks",
      "batteryPercent",
      "maxConcurrentTasks",
      "onBattery",
    ]);
  });
});

describe("availability monitoring", () => {
  it("reports first observed state", async () => {
    const platform = makePlatform();
    const changes: unknown[] = [];
    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: (snapshot) => {
        changes.push(snapshot);
      },
    });

    expect(await watcher.check()).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("reports nothing when nothing changes", async () => {
    const platform = makePlatform();
    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: () => undefined,
    });

    await watcher.check();
    expect(await watcher.check()).toBe(false);
  });

  it("reports accessibility service disabling", async () => {
    const platform = makePlatform();
    const changes: { accessibility: boolean }[] = [];
    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: (snapshot) => {
        changes.push(snapshot);
      },
    });

    await watcher.check();
    platform.ui.accessibilityEnabled = false;

    expect(await watcher.check()).toBe(true);
    expect(changes.at(-1)?.accessibility).toBe(false);
  });

  it("treats failing probe as unavailable", async () => {
    const platform = makePlatform();
    platform.ui.isAccessibilityEnabled = () => Promise.reject(new Error("bridge unavailable"));

    const watcher = new AvailabilityWatcher({
      platform,
      logger: new MemoryWorkerLogger(),
      onChange: () => undefined,
    });

    expect((await watcher.probe()).accessibility).toBe(false);
  });
});
