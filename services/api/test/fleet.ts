import { createTaskPlan, type TaskPlan, type TaskStepInput } from "@nexus/devices";
import {
  mountClient,
  mountWorker,
  type CapabilityBehaviour,
  type ClientRig,
  type WorkerRig,
} from "./laptop.js";
import {
  createAccount,
  makeApi,
  registerDevice,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * The complete fleet, mounted for real.
 *
 * This is the final architecture as it runs:
 *
 *     iPhone 17        CLIENT           controls
 *     Windows Laptop   CLIENT + WORKER  controls **and** executes
 *     Desktop          WORKER           executes
 *     Redmi Note 10S   WORKER           executes
 *     NEXUS Core       central authority
 *
 * None of this is hardcoded in the core: these are four registry entries.
 * Searching for "Redmi" or "Desktop" outside test fixtures yields nothing,
 * which is the property verified by mounting the fleet from outside.
 *
 * ## What is real, and what is not
 *
 * **Real**: both clients are `SessionManager` + `RealtimeClient` + reducer from
 * `@nexus/client-core` — the exact code the iPhone and Windows window run.
 * The three workers are `WorkerRuntime` from `@nexus/worker-core` — the daemon runtime.
 * The core is the complete Fastify API, with its real Ed25519 signatures,
 * its real worker selection, its real coordinator, and its real confirmations.
 *
 * **Doubled**: network transport (direct channel wiring, identical envelopes
 * and schemas) and worker system calls — Chrome is not launched on the test runner host.
 *
 * **Omitted**: there is **no language model**. Translating a prompt into a task plan
 * belongs to the agent service. Test scenarios therefore start from the denoted
 * plan and exercise everything downstream.
 */

export interface Fleet {
  harness: ApiHarness;
  account: Account;

  devices: {
    iphone: RegisteredDevice;
    laptop: RegisteredDevice;
    desktop: RegisteredDevice;
    redmi: RegisteredDevice;
  };

  /** The two clients. Laptop is both simultaneously. */
  iphone: ClientRig;
  laptop: ClientRig;

  /** The three workers. */
  laptopWorker: WorkerRig;
  desktop: WorkerRig;
  redmi: WorkerRig;

  close(): Promise<void>;
}

/**
 * Capabilities of each machine.
 *
 * They describe what each machine **can do**. What it is **permitted** to
 * do is a separate concern governed by user permissions — and the two are never conflated.
 */
export const LAPTOP_CAPABILITIES = [
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "git.status",
];

export const DESKTOP_CAPABILITIES = [
  "browser.open",
  "terminal.execute",
  "filesystem.read",
  "filesystem.write",
  "process.start",
  "process.list",
  "git.clone",
];

export const REDMI_CAPABILITIES = ["android.app.open", "android.app.list", "android.notification"];

/** Everything authorized by the user across all devices. */
export const GRANTED = [
  ...new Set([...LAPTOP_CAPABILITIES, ...DESKTOP_CAPABILITIES, ...REDMI_CAPABILITIES]),
];

export interface FleetOptions {
  /** Capability behaviours per device. */
  behaviours?: {
    laptop?: Readonly<Record<string, CapabilityBehaviour>>;
    desktop?: Readonly<Record<string, CapabilityBehaviour>>;
    redmi?: Readonly<Record<string, CapabilityBehaviour>>;
  };
  /** Risk threshold above which human confirmation is required. */
  confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export async function bootFleet(options: FleetOptions = {}): Promise<Fleet> {
  const harness = await makeApi(
    options.confirmationThreshold === undefined
      ? undefined
      : { confirmationThreshold: options.confirmationThreshold },
  );
  const account = await createAccount(harness);

  const iphoneDevice = await registerDevice(harness, account, {
    name: "iPhone 17",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
    permissions: GRANTED,
  });

  // Laptop: **single device**, `BOTH` role. Two registry rows for the same
  // machine would create two fleet entries and contradictory health statuses.
  const laptopDevice = await registerDevice(harness, account, {
    name: "Windows Laptop",
    role: "BOTH",
    permissions: GRANTED,
  });

  const desktopDevice = await registerDevice(harness, account, {
    name: "Windows Desktop",
    role: "WORKER",
    permissions: GRANTED,
  });

  const redmiDevice = await registerDevice(harness, account, {
    name: "Redmi Note 10S",
    role: "WORKER",
    type: "ANDROID",
    platform: "ANDROID",
    permissions: GRANTED,
  });

  const iphone = await mountClient(harness, account, iphoneDevice);
  const laptop = await mountClient(harness, account, laptopDevice);

  const laptopWorker = mountWorker(harness, laptopDevice, {
    capabilities: LAPTOP_CAPABILITIES,
    connectionId: "conn-laptop",
    ...(options.behaviours?.laptop === undefined ? {} : { behaviours: options.behaviours.laptop }),
  });
  const desktop = mountWorker(harness, desktopDevice, {
    capabilities: DESKTOP_CAPABILITIES,
    connectionId: "conn-desktop",
    ...(options.behaviours?.desktop === undefined
      ? {}
      : { behaviours: options.behaviours.desktop }),
  });
  const redmi = mountWorker(harness, redmiDevice, {
    capabilities: REDMI_CAPABILITIES,
    connectionId: "conn-redmi",
    platform: "ANDROID",
    ...(options.behaviours?.redmi === undefined ? {} : { behaviours: options.behaviours.redmi }),
  });

  await Promise.all([laptopWorker.runtime.start(), desktop.runtime.start(), redmi.runtime.start()]);

  // Await capabilities being **registered**, not just session open:
  // selector routes based on capabilities, and premature starts cause flaky tests.
  await until(async () => {
    const devices = await harness.services.deviceRegistry.listDevices(account.userId);
    return devices
      .filter((device) => device.role !== "CLIENT")
      .every((device) => device.capabilities.length > 0);
  });

  return {
    harness,
    account,
    devices: {
      iphone: iphoneDevice,
      laptop: laptopDevice,
      desktop: desktopDevice,
      redmi: redmiDevice,
    },
    iphone,
    laptop,
    laptopWorker,
    desktop,
    redmi,
    close: () => harness.close(),
  };
}

/**
 * The plan denoted by a request.
 *
 * In the absence of an LLM planner, test scenarios construct this manually.
 * A named machine becomes a `preferredDeviceId` — a preference weighed by
 * the selector, never a bypass: a preferred device lacking capabilities is rejected.
 */
export function planFor(input: {
  userId: string;
  title: string;
  originClientDeviceId: string;
  steps: TaskStepInput[];
  correlationId?: string;
}): TaskPlan {
  return createTaskPlan({
    userId: input.userId,
    title: input.title,
    originClientDeviceId: input.originClientDeviceId,
    correlationId: input.correlationId ?? `corr-${input.title.slice(0, 12)}`,
    steps: input.steps,
  });
}

/**
 * Waits for a condition to become true while advancing real clock timers.
 *
 * Test harness `until` only drains microtasks: suitable for state machines
 * without real waits. End-to-end scenarios traverse dispatch timeouts,
 * confirmation expiries, and recovery delays.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  // Generous by default: serves as a safety net rather than performance metric.
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`condition never met: ${options.label ?? "(unnamed)"}`);
}

/** Runs a plan through supervisor, matching the `POST /tasks` route behaviour. */
export function runPlan(fleet: Fleet, plan: TaskPlan): void {
  fleet.harness.services.supervisor.start(plan, GRANTED);
}
