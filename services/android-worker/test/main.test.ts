import { describe, expect, it } from "vitest";
import { createPrivateKey, randomBytes, sign as signEcdsa } from "node:crypto";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  TaskCoordinator,
  WorkerGateway,
  ecdsaP256Verifier,
  type WorkerConnection,
} from "@nexus/devices";
import { LoopbackLink, MemoryWorkerLogger, WorkerConfigurationError } from "@nexus/worker-core";
import type { Envelope } from "@nexus/protocol";
import { startAndroidWorker } from "../src/main.js";
import type { NexusNative } from "../src/bridge/native-bridge.js";
import type { AndroidApp, AndroidBatteryState, Screenshot, UiNode } from "../src/ports.js";
import { ANDROID_PERMISSIONS, USER_ID, generateDeviceKeys, until } from "./fixtures.js";

/**
 * Wait for an asynchronous predicate.
 *
 * The harness `until` only drains microtasks and cannot await a promise;
 * passing an `async` predicate to it would test the truthiness of a Promise object,
 * which is always true.
 */
async function untilAsync(predicate: () => Promise<boolean>, label = "condition"): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never reached: ${label}`);
}

/**
 * Entry point, verified end-to-end.
 *
 * This file starts from where the Android application actually starts: a native module
 * and environment variables. It exercises everything that `main.ts` assembles:
 * configuration, policies, capabilities, keystore signing, handshake,
 * up to an open session with a real `WorkerGateway`.
 *
 * The only double is `NexusNative`, representing the boundary with Kotlin.
 */

const DEVICE_ID = "device-redmi";

/**
 * Native module test double.
 *
 * Simulates keystore signing with a real P-256 key: this is the curve
 * AndroidKeyStore produces, and core verifies it here with `ecdsaP256Verifier`.
 */
class FakeNative implements NexusNative {
  readonly #privateKeyPem: string;
  readonly #publicKeyPem: string;
  readonly signedAliases: string[] = [];

  accessibilityEnabled = true;
  screenshotAvailable = true;
  notificationsAllowed = true;
  sdk = 30;
  battery: AndroidBatteryState = { percent: 74, charging: false, powerSaveMode: false };

  readonly opened: string[] = [];

  constructor(keys: { privateKeyPem: string; publicKeyPem: string }) {
    this.#privateKeyPem = keys.privateKeyPem;
    this.#publicKeyPem = keys.publicKeyPem;
  }

  listApps(): Promise<AndroidApp[]> {
    return Promise.resolve([
      { packageName: "com.spotify.music", label: "Spotify", launchable: true },
    ]);
  }

  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }> {
    this.opened.push(packageName);
    return Promise.resolve({ launched: true });
  }

  isInstalled(): Promise<boolean> {
    return Promise.resolve(true);
  }

  isAccessibilityEnabled(): Promise<boolean> {
    return Promise.resolve(this.accessibilityEnabled);
  }

  findNode(): Promise<UiNode | null> {
    return Promise.resolve(null);
  }

  click(): Promise<{ clicked: boolean }> {
    return Promise.resolve({ clicked: true });
  }

  inputText(_selector: string, text: string): Promise<{ entered: boolean; characters: number }> {
    return Promise.resolve({ entered: true, characters: text.length });
  }

  scroll(): Promise<{ scrolled: boolean }> {
    return Promise.resolve({ scrolled: true });
  }

  isScreenshotAvailable(): Promise<boolean> {
    return Promise.resolve(this.screenshotAvailable);
  }

  takeScreenshot(): Promise<Screenshot> {
    return Promise.resolve({
      base64: "aW1hZ2U=",
      format: "png",
      width: 720,
      height: 1_280,
      bytes: 6,
    });
  }

  canPostNotifications(): Promise<boolean> {
    return Promise.resolve(this.notificationsAllowed);
  }

  postNotification(): Promise<{ posted: boolean; notificationId: number }> {
    return Promise.resolve({ posted: true, notificationId: 1 });
  }

  batteryState(): Promise<AndroidBatteryState> {
    return Promise.resolve(this.battery);
  }

  sdkVersion(): Promise<number> {
    return Promise.resolve(this.sdk);
  }

  /**
   * Public key corresponding to the test double private key.
   */
  devicePublicKeyPem(): Promise<string> {
    return Promise.resolve(this.#publicKeyPem);
  }

  /**
   * Secure random bytes in base64.
   */
  secureRandomBase64(count: number): string {
    return randomBytes(count).toString("base64");
  }

  signChallenge(keyAlias: string, nonce: string): Promise<string> {
    this.signedAliases.push(keyAlias);
    const signature = signEcdsa(
      "sha256",
      Buffer.from(nonce, "utf8"),
      createPrivateKey(this.#privateKeyPem),
    );
    return Promise.resolve(signature.toString("base64"));
  }
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NEXUS_BACKEND_URL: "wss://nexus.test",
    DEVICE_ID,
    DEVICE_KEY_ALIAS: "nexus.device.key",
    ANDROID_SCREENSHOT_MIN_INTERVAL_MS: "200",
    LOG_LEVEL: "debug",
    ...overrides,
  };
}

/** Core services: registry, P-256 sessions, gateway, coordinator. */
async function bootCore() {
  const registry = new DeviceRegistry();
  const credentials = new InMemoryCredentialProvider();
  const sessions = new DeviceSessionService({ registry, verifier: ecdsaP256Verifier });
  const router = new EventRouter({ registry });
  const gateway = new WorkerGateway({ registry, sessions, credentials, router });
  const selector = new DeviceSelector({ registry });
  const coordinator = new TaskCoordinator({ registry, selector, router, transport: gateway });

  const keys = generateDeviceKeys();

  const device = await registry.registerDevice({
    id: DEVICE_ID,
    userId: USER_ID,
    name: "Android Phone",
    type: "ANDROID",
    platform: "ANDROID",
    role: "WORKER",
    grantedPermissions: ANDROID_PERMISSIONS,
  });
  credentials.set(device.id, keys.publicKeyPem);
  await registry.trustDevice(device.id);

  const link = new LoopbackLink();
  const connection: WorkerConnection = {
    connectionId: `conn-${device.id}`,
    deviceId: device.id,
    send: (envelope: Envelope) => {
      link.deliver(envelope);
    },
    close: () => {
      link.drop("closed by core");
    },
  };
  link.outbound = (envelope) => gateway.handleMessage(connection, envelope);

  return { registry, sessions, gateway, coordinator, selector, credentials, keys, link, device };
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

describe("startAndroidWorker", () => {
  it("starts from a native module and environment variables to reach an open session", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);
    const logger = new MemoryWorkerLogger();

    const { worker, config } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger,
    });

    await until(() => worker.isAuthenticated);
    expect(worker.isAuthenticated).toBe(true);
    expect(config.deviceId).toBe(DEVICE_ID);

    // Signature passes via alias, never plaintext key.
    expect(native.signedAliases).toEqual(["nexus.device.key"]);

    await worker.stop("end of test");
  });

  it("advertises actually available capabilities to core", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await untilAsync(async () => {
      const device = await core.registry.requireDevice(DEVICE_ID);
      return device.capabilities.length > 0;
    }, "registered capabilities");

    const device = await core.registry.requireDevice(DEVICE_ID);
    const names = device.capabilities.map((capability) => capability.name).sort();

    // The seven existing NEXUS capabilities under their existing names.
    expect(names).toEqual([
      "android.app.list",
      "android.app.open",
      "android.notification",
      "android.ui.click",
      "android.ui.input",
      "android.ui.screenshot",
      "android.ui.scroll",
    ]);

    await worker.stop("end of test");
  });

  it("does not advertise what the user has not granted", async () => {
    // Accessibility disabled: four capabilities disappear.
    const core = await bootCore();
    const native = new FakeNative(core.keys);
    native.accessibilityEnabled = false;
    native.screenshotAvailable = false;

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await untilAsync(async () => {
      const device = await core.registry.requireDevice(DEVICE_ID);
      return device.capabilities.length > 0;
    }, "registered capabilities");

    const device = await core.registry.requireDevice(DEVICE_ID);
    const names = device.capabilities.map((capability) => capability.name).sort();

    expect(names).toEqual(["android.app.list", "android.app.open", "android.notification"]);

    await worker.stop("end of test");
  });

  it("executes a task from core down to the native module", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv({ ANDROID_ALLOWED_PACKAGES: "com.spotify.music" }),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await untilAsync(async () => {
      const device = await core.registry.requireDevice(DEVICE_ID);
      return device.capabilities.length > 0;
    }, "registered capabilities");

    const outcome = await core.gateway.dispatch({
      deviceId: DEVICE_ID,
      taskId: "task-1",
      stepId: "step-1",
      capability: "android.app.open",
      tool: "device.android.app.open",
      arguments: { packageName: "com.spotify.music" },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(outcome.ok).toBe(true);
    expect(native.opened).toEqual(["com.spotify.music"]);

    await worker.stop("end of test");
  });

  it("refuses to start on incomplete configuration", async () => {
    const native = new FakeNative(generateDeviceKeys());

    await expect(
      startAndroidWorker({ native, env: { NEXUS_BACKEND_URL: "wss://nexus.test" } }),
    ).rejects.toThrow(WorkerConfigurationError);
  });

  it("refuses cleartext remote backend address", async () => {
    const native = new FakeNative(generateDeviceKeys());

    await expect(
      startAndroidWorker({
        native,
        env: baseEnv({ NEXUS_BACKEND_URL: "ws://nexus.example.com" }),
      }),
    ).rejects.toThrow(WorkerConfigurationError);
  });

  it("opens its own link when none is provided", async () => {
    const native = new FakeNative(generateDeviceKeys());

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv({
        NEXUS_BACKEND_URL: "http://127.0.0.1:1",
        WORKER_RECONNECT_MIN_MS: "60000",
      }),
      logger: new MemoryWorkerLogger(),
    });

    expect(worker.isAuthenticated).toBe(false);
    expect(["reconnecting", "connecting", "idle"]).toContain(worker.state);

    await worker.stop("end of test");
  });

  it("stops cleanly and does not reconnect", async () => {
    const core = await bootCore();
    const native = new FakeNative(core.keys);

    const { worker } = await startAndroidWorker({
      native,
      env: baseEnv(),
      link: core.link,
      logger: new MemoryWorkerLogger(),
    });

    await until(() => worker.isAuthenticated);
    await worker.stop("stop requested");

    expect(worker.isAuthenticated).toBe(false);
    expect(core.link.state).toBe("closed");
  });
});
