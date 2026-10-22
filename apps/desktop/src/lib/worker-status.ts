/**
 * Status of the local worker as displayed by the UI.
 *
 * Sourced directly from the core rather than polling the local daemon.
 */

export type LocalWorkerState =
  /** No daemon installed on this host — client operates standalone. */
  | "absent"
  /** Daemon exists but core does not yet recognize this device. */
  | "unpaired"
  /** Paired, pending human approval. */
  | "pending"
  | "offline"
  | "degraded"
  | "online"
  | "revoked";

/**
 * Device representation from core.
 */
export interface ObservedDevice {
  id: string;
  name: string;
  role: string;
  status: string;
  capabilities: readonly string[];
  trust?: string;
  health?: {
    activeTasks: number;
    maxConcurrentTasks: number;
    batteryPercent?: number;
    onBattery?: boolean;
  };
}

export interface LocalWorkerStatus {
  state: LocalWorkerState;
  deviceId: string | null;
  name: string | null;
  capabilities: readonly string[];
  activeTasks: number;
  maxConcurrentTasks: number;
  /** True when the device can accept an execution step right now. */
  acceptingTasks: boolean;
  /** Display-ready sentence. */
  summary: string;
}

export interface LocalWorkerInput {
  /** Identifier read from local daemon state. `null` = no daemon. */
  localWorkerDeviceId: string | null;
  /** Devices as described by the core. */
  devices: readonly ObservedDevice[];
}

const ABSENT: LocalWorkerStatus = {
  state: "absent",
  deviceId: null,
  name: null,
  capabilities: [],
  activeTasks: 0,
  maxConcurrentTasks: 0,
  acceptingTasks: false,
  summary: "No NEXUS worker installed on this machine.",
};

export function localWorkerStatus(input: LocalWorkerInput): LocalWorkerStatus {
  if (input.localWorkerDeviceId === null) return ABSENT;

  const device = input.devices.find((candidate) => candidate.id === input.localWorkerDeviceId);

  if (device === undefined) {
    return {
      ...ABSENT,
      state: "unpaired",
      deviceId: input.localWorkerDeviceId,
      summary:
        "A worker is installed on this machine but the core does not recognize it yet. " +
        "Start pairing from the daemon.",
    };
  }

  const health = device.health ?? { activeTasks: 0, maxConcurrentTasks: 1 };
  const state = stateOf(device);

  return {
    state,
    deviceId: device.id,
    name: device.name,
    capabilities: device.capabilities,
    activeTasks: health.activeTasks,
    maxConcurrentTasks: health.maxConcurrentTasks,
    acceptingTasks: state === "online" && health.activeTasks < health.maxConcurrentTasks,
    summary: summaryOf(state, device, health),
  };
}

function stateOf(device: ObservedDevice): LocalWorkerState {
  if (device.status === "REVOKED" || device.trust === "REVOKED") return "revoked";
  if (device.trust === "PENDING") return "pending";
  if (device.status === "DEGRADED") return "degraded";
  if (device.status === "ONLINE") return "online";
  return "offline";
}

function summaryOf(
  state: LocalWorkerState,
  device: ObservedDevice,
  health: { activeTasks: number; maxConcurrentTasks: number },
): string {
  const load = `${String(health.activeTasks)}/${String(health.maxConcurrentTasks)} task(s)`;

  switch (state) {
    case "revoked":
      return "Worker revoked. It will not execute anything until re-paired.";
    case "pending":
      return "Worker pending approval. Approve it to receive tasks.";
    case "degraded":
      return `Worker degraded — ${load}. The core will prefer another machine.`;
    case "online":
      return health.activeTasks >= health.maxConcurrentTasks
        ? `Worker saturated — ${load}. New steps will be routed elsewhere.`
        : `Worker ready — ${load}, ${String(device.capabilities.length)} capability(ies).`;
    case "offline":
      return "Worker offline. The NEXUS daemon is not running or cannot reach the core.";
    case "absent":
    case "unpaired":
      return ABSENT.summary;
  }
}

/**
 * Remote workers in the fleet.
 */
export function remoteWorkers(input: LocalWorkerInput): ObservedDevice[] {
  return input.devices.filter(
    (device) =>
      device.id !== input.localWorkerDeviceId &&
      (device.role === "WORKER" || device.role === "BOTH"),
  );
}
