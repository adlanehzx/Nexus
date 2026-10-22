import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_MESSAGE, workerEnvelope, type WorkerPayload } from "@nexus/protocol";
import { makeHarness, settle, until, type AndroidHarness } from "./fixtures.js";
import { loadAndroidConfig } from "../src/config.js";

/**
 * Security properties expressed as automated tests.
 *
 * Some are observed at runtime; others are verified on the source code and manifest,
 * ensuring architectural security guarantees are upheld.
 */

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

let sequence = 0;

function dispatchEnvelope(overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {}) {
  sequence += 1;
  return workerEnvelope(
    WORKER_MESSAGE.taskDispatch,
    {
      taskId: "task-sec",
      stepId: `step-${String(sequence)}`,
      capability: "android.notification",
      tool: "device.android.notification",
      arguments: { title: "x", body: "y" },
      timeoutMs: 10_000,
      riskLevel: "MEDIUM",
      requestId: `req-${String(sequence)}`,
      ...overrides,
    },
    { id: `env-${String(sequence)}`, at: new Date() },
  );
}

function results(harness: AndroidHarness) {
  return harness.link.sent
    .filter((envelope) => envelope.type === WORKER_MESSAGE.taskResult)
    .map((envelope) => envelope.payload as WorkerPayload<"worker.task_result">);
}

async function dispatch(
  harness: AndroidHarness,
  overrides: Partial<WorkerPayload<"worker.task_dispatch">> = {},
) {
  const envelope = dispatchEnvelope(overrides);
  const payload = envelope.payload as WorkerPayload<"worker.task_dispatch">;
  harness.link.deliver(envelope);
  await until(() => results(harness).some((result) => result.stepId === payload.stepId));
  return results(harness).find((result) => result.stepId === payload.stepId);
}

/**
 * Strips comments prior to static analysis.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Strips XML comments. */
function stripXmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("no arbitrary remote control", () => {
  it("exposes no generic execution capabilities", () => {
    const ports = stripComments(readFileSync(path.join(ROOT, "src", "ports.ts"), "utf8"));

    for (const forbidden of ["startActivityWithIntent", "runCommand", "exec(", "eval("]) {
      expect(ports).not.toContain(forbidden);
    }
  });

  it("native bridge has no generic dispatch method", () => {
    const bridge = readFileSync(path.join(ROOT, "src", "bridge", "native-bridge.ts"), "utf8");
    const methods = [...bridge.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]);

    expect(methods).not.toContain("invoke");
    expect(methods).not.toContain("call");
    expect(methods).not.toContain("send");
  });

  it("no capability accepts arbitrary URI or intent string", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "intent:#Intent;action=android.intent.action.CALL;end" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "WORKER_POLICY_VIOLATION" } });
    expect(harness.platform.apps.opened).toHaveLength(0);
  });

  it("refuses attempts to open settings", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "com.android.settings" },
    });

    expect(result?.ok).toBe(false);
    expect(harness.platform.apps.opened).toHaveLength(0);
  });
});

describe("capability escalation", () => {
  it("refuses locally disabled capability even if core dispatches it", async () => {
    const harness = await makeHarness({
      config: { declaredCapabilities: ["android.notification"] },
    });
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "text", value: "Search" } },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(harness.platform.ui.clicks).toHaveLength(0);
  });

  it("refuses click when accessibility was disabled in the interim", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();
    harness.platform.ui.accessibilityEnabled = false;

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "text", value: "Search" } },
    });

    expect(result?.error?.code).toBe("ANDROID_ACCESSIBILITY_DISABLED");
    expect(harness.platform.ui.clicks).toHaveLength(0);
  });

  it("refuses unauthorized coordinate clicks", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    const result = await dispatch(harness, {
      capability: "android.ui.click",
      tool: "device.android.ui.click",
      arguments: { selector: { kind: "coordinates", x: 540, y: 1200 } },
    });

    expect(result?.ok).toBe(false);
    expect(harness.platform.ui.clicks).toHaveLength(0);
  });
});

describe("secret leakage prevention", () => {
  it("never logs input text", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.ui.input",
      tool: "device.android.ui.input",
      arguments: {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "MySecretPassword2026",
      },
    });

    expect(harness.logger.text).not.toContain("MySecretPassword2026");
  });

  it("never echoes input text back to core", async () => {
    const harness = await makeHarness();
    await harness.attachClient();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.ui.input",
      tool: "device.android.ui.input",
      arguments: {
        selector: { kind: "viewId", value: "com.app:id/field" },
        text: "BankCode987654",
      },
    });

    expect(JSON.stringify(harness.link.sent)).not.toContain("BankCode987654");
    expect(JSON.stringify(harness.clientEvents)).not.toContain("BankCode987654");
  });

  it("never logs screenshot data", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    await dispatch(harness, {
      capability: "android.ui.screenshot",
      tool: "device.android.ui.screenshot",
      arguments: {},
    });

    expect(harness.logger.text).not.toContain("aW1hZ2UtZmFjdGljZQ==");
  });

  it("writes no screenshot to disk", () => {
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      expect(content).not.toMatch(/writeFile|createWriteStream|node:fs/);
    }
  });

  it("does not log session tokens", async () => {
    const harness = await makeHarness();
    await harness.connectWorker();

    expect(harness.logger.text).not.toMatch(/"token"/);
  });

  it("does not reveal technical details of unexpected errors", async () => {
    const harness = await makeHarness({
      seed: (platform) => {
        platform.notifications.failNext = true;
      },
    });
    await harness.connectWorker();

    const result = await dispatch(harness);

    expect(result?.error?.code).toBe("WORKER_INTERNAL_ERROR");
    expect(result?.error?.message).not.toContain("NotificationManager");
  });
});

describe("no notification eavesdropping", () => {
  it("source code does not reference any notification listener service", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/NotificationListenerService|getActiveNotifications|onNotificationPosted/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("manifest does not declare any notification listener service", () => {
    const manifest = stripXmlComments(
      readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8"),
    );

    expect(manifest).not.toContain("BIND_NOTIFICATION_LISTENER_SERVICE");
    expect(manifest).not.toContain("NotificationListenerService");
    expect(manifest).not.toContain("android.permission.READ_SMS");
    expect(manifest).not.toContain("android.permission.RECORD_AUDIO");
    expect(manifest).not.toContain("android.permission.CAMERA");
    expect(manifest).not.toContain("QUERY_ALL_PACKAGES");
  });
});

describe("no continuous screen recording", () => {
  it("source code does not reference continuous capture APIs", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const content = stripComments(readFileSync(file, "utf8"));
      if (/MediaProjection|MediaRecorder|startRecording|VirtualDisplay/.test(content)) {
        offenders.push(path.basename(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("manifest does not declare screen projection foreground service", () => {
    const manifest = stripXmlComments(
      readFileSync(path.join(ROOT, "android", "AndroidManifest.xml"), "utf8"),
    );
    expect(manifest).not.toContain("mediaProjection");
  });

  it("screenshot rate is bounded by default", () => {
    const config = loadAndroidConfig({
      NEXUS_BACKEND_URL: "wss://nexus.test/ws",
      DEVICE_ID: "d1",
    });
    expect(config.screenshotMinIntervalMs).toBeGreaterThan(0);
  });
});

describe("configuration", () => {
  const base = {
    NEXUS_BACKEND_URL: "wss://nexus.example.com/ws",
    DEVICE_ID: "device-android",
  };

  it("accepts minimal configuration", () => {
    expect(loadAndroidConfig(base)).toMatchObject({ deviceId: "device-android" });
  });

  it("refuses to start without device identifier", () => {
    expect(() => loadAndroidConfig({ ...base, DEVICE_ID: undefined })).toThrow(
      expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }),
    );
  });

  it("refuses cleartext remote backend address", () => {
    expect(() =>
      loadAndroidConfig({ ...base, NEXUS_BACKEND_URL: "ws://nexus.example.com/ws" }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("tolerates cleartext emulator loopback address", () => {
    expect(() =>
      loadAndroidConfig({ ...base, NEXUS_BACKEND_URL: "ws://10.0.2.2:3000/ws" }),
    ).not.toThrow();
  });

  it("references key by alias, never by raw value", () => {
    const config = loadAndroidConfig(base);
    expect(config.keyAlias).toBe("nexus.device.key");
    expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");
  });

  it("refuses inconsistent battery thresholds", () => {
    expect(() =>
      loadAndroidConfig({
        ...base,
        ANDROID_LOW_BATTERY_PERCENT: "5",
        ANDROID_CRITICAL_BATTERY_PERCENT: "50",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKER_CONFIGURATION_INVALID" }));
  });

  it("disallows coordinate clicks by default", () => {
    expect(loadAndroidConfig(base).allowCoordinateClicks).toBe(false);
  });
});

describe("no secrets in repository", () => {
  it(".env.example contains only placeholders", () => {
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");

    expect(example).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(example).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
    expect(example).toMatch(/DEVICE_KEY_ALIAS=/);
  });

  it("no private key or keystore files present in package", () => {
    for (const suspect of ["nexus-device.key", "keystore.jks", "release.keystore"]) {
      expect(existsSync(path.join(ROOT, suspect))).toBe(false);
      expect(existsSync(path.join(ROOT, "android", suspect))).toBe(false);
    }
  });
});

describe("device identifier does not authenticate requests", () => {
  it("refuses dispatch before session establishment", async () => {
    const harness = await makeHarness();
    await harness.link.connect();

    harness.link.deliver(dispatchEnvelope());
    await settle(30);

    expect(harness.platform.notifications.posted).toHaveLength(0);
    expect(harness.worker.isAuthenticated).toBe(false);
  });
});
