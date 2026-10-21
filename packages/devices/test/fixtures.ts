import { deviceCapabilitySchema, type DeviceCapability } from "../src/types.js";
import { DeviceRegistry, InMemoryDeviceStore } from "../src/registry.js";
import { DeviceSelector } from "../src/selector.js";
import { EventRouter, type ClientConnection } from "../src/router.js";
import type { NexusEvent } from "@nexus/protocol";
import type { WorkerDispatch, WorkerResult, WorkerTransport } from "../src/coordinator.js";

/**
 * User device fleet test fixtures.
 *
 * Device names appear exclusively in these fixtures. No test hardcodes "select the desktop";
 * they specify required capabilities (e.g., `docker.execute`) and verify correct routing.
 */

export const USER_ID = "user-example";

export function capability(
  name: string,
  overrides: Partial<DeviceCapability> = {},
): DeviceCapability {
  return deviceCapabilitySchema.parse({ name, ...overrides });
}

export const WORKSTATION_CAPABILITIES = [
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "process.start",
  "process.stop",
  "docker.execute",
  "git.execute",
  "browser.open",
].map((name) => capability(name));

export const ANDROID_CAPABILITIES = [
  "android.app.open",
  "android.ui.click",
  "android.ui.input",
  "android.ui.scroll",
  "android.ui.screenshot",
  "android.notification",
].map((name) => capability(name));

export const CLIENT_CAPABILITIES = ["notification.push", "voice.playback"].map((name) =>
  capability(name),
);

/** Fleet permissions bundle to avoid repetitive lists in tests. */
export const ALL_PERMISSIONS = [
  ...WORKSTATION_CAPABILITIES.map((c) => c.name),
  ...ANDROID_CAPABILITIES.map((c) => c.name),
  ...CLIENT_CAPABILITIES.map((c) => c.name),
];

export interface Harness {
  registry: DeviceRegistry;
  selector: DeviceSelector;
  router: EventRouter;
  store: InMemoryDeviceStore;
  clock: { now: Date };
}

export function makeHarness(): Harness {
  const clock = { now: new Date("2026-09-02T10:00:00Z") };
  const store = new InMemoryDeviceStore();
  const registry = new DeviceRegistry({ store, now: () => clock.now });
  const selector = new DeviceSelector({ registry });
  const router = new EventRouter({ registry, now: () => clock.now });

  return { registry, selector, router, store, clock };
}

interface DeviceSpec {
  id: string;
  name: string;
  type: Parameters<DeviceRegistry["registerDevice"]>[0]["type"];
  platform: Parameters<DeviceRegistry["registerDevice"]>[0]["platform"];
  role: Parameters<DeviceRegistry["registerDevice"]>[0]["role"];
  capabilities: DeviceCapability[];
}

export const IPHONE: DeviceSpec = {
  id: "iphone-17",
  name: "iPhone 17",
  type: "IPHONE",
  platform: "IOS",
  role: "CLIENT",
  capabilities: CLIENT_CAPABILITIES,
};

export const LAPTOP: DeviceSpec = {
  id: "windows-laptop",
  name: "Windows Laptop",
  type: "WINDOWS_PC",
  platform: "WINDOWS",
  role: "BOTH",
  capabilities: [...WORKSTATION_CAPABILITIES, ...CLIENT_CAPABILITIES],
};

export const DESKTOP: DeviceSpec = {
  id: "windows-desktop",
  name: "Windows Desktop",
  type: "WINDOWS_PC",
  platform: "WINDOWS",
  role: "WORKER",
  capabilities: WORKSTATION_CAPABILITIES,
};

export const REDMI: DeviceSpec = {
  id: "redmi-note-10s",
  name: "Redmi Note 10S",
  type: "ANDROID",
  platform: "ANDROID",
  role: "WORKER",
  capabilities: ANDROID_CAPABILITIES,
};

export interface SetupOptions {
  /** Devices to register. Defaults to full fleet. */
  devices?: DeviceSpec[];
  /** Devices marked online and authenticated. Defaults to all. */
  online?: string[];
  /** Approved devices. Defaults to all. */
  trusted?: string[];
  /** Granted permissions per device. Defaults to all. */
  permissions?: Record<string, string[]>;
}

/** Registers device fleet and puts requested devices into service. */
export async function setupFleet(harness: Harness, options: SetupOptions = {}): Promise<void> {
  const devices = options.devices ?? [IPHONE, LAPTOP, DESKTOP, REDMI];
  const online = options.online ?? devices.map((d) => d.id);
  const trusted = options.trusted ?? devices.map((d) => d.id);

  for (const spec of devices) {
    await harness.registry.registerDevice({
      id: spec.id,
      userId: USER_ID,
      name: spec.name,
      type: spec.type,
      platform: spec.platform,
      role: spec.role,
      capabilities: spec.capabilities,
      grantedPermissions: options.permissions?.[spec.id] ?? ALL_PERMISSIONS,
    });

    if (trusted.includes(spec.id)) await harness.registry.trustDevice(spec.id);

    if (online.includes(spec.id)) {
      await harness.registry.setAuthenticated(spec.id, true);
      await harness.registry.updateHeartbeat(spec.id, {
        activeTasks: 0,
        maxConcurrentTasks: 2,
        cpuLoad: 0.2,
        // Desktop is on AC power, laptop on battery: tests requireMainsPower constraint.
        onBattery: spec.id === DESKTOP.id ? false : true,
      });
    }
  }
}

/** Connected client collecting received events. */
export function makeClient(deviceId: string): ClientConnection & { received: NexusEvent[] } {
  const received: NexusEvent[] = [];
  return {
    deviceId,
    userId: USER_ID,
    received,
    send(event: NexusEvent) {
      received.push(event);
    },
  };
}

/** Scriptable worker transport mock. */
export class FakeTransport implements WorkerTransport {
  readonly dispatched: WorkerDispatch[] = [];
  readonly cancelled: { deviceId: string; taskId: string; stepId: string }[] = [];
  responses = new Map<string, WorkerResult>();
  failuresBeforeSuccess = new Map<string, number>();

  dispatch(input: WorkerDispatch): Promise<WorkerResult> {
    this.dispatched.push(input);

    const remaining = this.failuresBeforeSuccess.get(input.tool) ?? 0;
    if (remaining > 0) {
      this.failuresBeforeSuccess.set(input.tool, remaining - 1);
      return Promise.resolve({
        ok: false,
        error: { code: "WORKER_BUSY", message: "temporarily unavailable", retryable: true },
      });
    }

    input.onProgress({ percent: 50, label: `${input.tool} in progress` });
    return Promise.resolve(
      this.responses.get(input.tool) ?? { ok: true, result: { tool: input.tool } },
    );
  }

  cancel(deviceId: string, taskId: string, stepId: string): Promise<void> {
    this.cancelled.push({ deviceId, taskId, stepId });
    return Promise.resolve();
  }

  deviceFor(tool: string): string | undefined {
    return this.dispatched.find((d) => d.tool === tool)?.deviceId;
  }
}
