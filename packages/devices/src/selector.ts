import { missingCapabilities, permissionForCapability } from "./capabilities.js";
import { NoEligibleWorkerError } from "./errors.js";
import type { DeviceRegistry } from "./registry.js";
import { canAcceptTasks, isOperational, type Device } from "./types.js";

/**
 * Worker selection engine.
 *
 * Rule: never hardcode device names in logic. Selection flows through:
 *
 *     required capabilities -> compatible workers -> hard security filters -> scoring -> selection
 *
 * Hard filters enforce invariant security requirements. Scoring breaks ties between
 * eligible workers based on load, availability, and preferences.
 */

export interface SelectionRequest {
  userId: string;
  requiredCapabilities: readonly string[];
  /** User permissions evaluated alongside device permissions. */
  userPermissions?: readonly string[];
  /** Explicit user choice, respected if eligible. */
  preferredDeviceId?: string;
  /** Excluded device IDs, e.g. after a task attempt failed on one. */
  excludeDeviceIds?: readonly string[];
  /** Task constraints: imposed platform or hardware requirements. */
  constraints?: {
    deviceTypes?: readonly Device["type"][] | undefined;
    platforms?: readonly Device["platform"][] | undefined;
    /** Reject workers running on battery power for intensive tasks. */
    requireMainsPower?: boolean | undefined;
    /** Minimum free GPU VRAM required in MB for GPU-bound tasks. */
    minGpuVramMb?: number | undefined;
  };
}

export interface ScoredCandidate {
  device: Device;
  score: number;
  reasons: string[];
}

export interface SelectionResult {
  device: Device;
  score: number;
  /** Evaluated candidate devices ordered best to worst. */
  candidates: ScoredCandidate[];
  /** Rejection diagnostic explanations for ineligible devices. */
  rejected: { deviceId: string; name: string; reason: string }[];
}

export interface DeviceSelectorOptions {
  registry: DeviceRegistry;
  /** Configurable scoring weights. */
  weights?: Partial<typeof DEFAULT_WEIGHTS>;
}

const DEFAULT_WEIGHTS = {
  /** Explicit user preference dominates all other factors. */
  preference: 1_000,
  /** Idle workers without active tasks prioritized over busy ones. */
  availability: 300,
  /** CPU and memory capacity. */
  health: 200,
  /** Round-trip latency measured on latest heartbeat. */
  latency: 150,
  /** Mains-powered workers preferred over battery-powered. */
  mainsPower: 100,
  /** Specialized workers preferred over generalist workstations. */
  specialization: 50,
};

export class DeviceSelector {
  readonly #registry: DeviceRegistry;
  readonly #weights: typeof DEFAULT_WEIGHTS;

  constructor(options: DeviceSelectorOptions) {
    this.#registry = options.registry;
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  }

  /**
   * Selects the optimal worker, or throws with detailed diagnostic reasons.
   *
   * @throws {NoEligibleWorkerError}
   */
  async select(request: SelectionRequest): Promise<SelectionResult> {
    const result = await this.trySelect(request);
    if (result === undefined) {
      const rejected = await this.#explain(request);
      throw new NoEligibleWorkerError(
        request.requiredCapabilities,
        rejected.map((r) => `${r.name}: ${r.reason}`),
      );
    }
    return result;
  }

  /** Safe variant returning `undefined` when no workers match criteria. */
  async trySelect(request: SelectionRequest): Promise<SelectionResult | undefined> {
    const devices = await this.#registry.listDevices(request.userId);
    const candidates: ScoredCandidate[] = [];
    const rejected: SelectionResult["rejected"] = [];

    for (const device of devices) {
      const reason = this.#reject(device, request);
      if (reason !== undefined) {
        rejected.push({ deviceId: device.id, name: device.name, reason });
        continue;
      }
      candidates.push(this.#score(device, request));
    }

    if (candidates.length === 0) return undefined;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best === undefined) return undefined;

    return { device: best.device, score: best.score, candidates, rejected };
  }

  /** Returns all eligible workers ordered by score for failover. */
  async listEligible(request: SelectionRequest): Promise<ScoredCandidate[]> {
    return (await this.trySelect(request))?.candidates ?? [];
  }

  /**
   * Hard filters.
   */
  #reject(device: Device, request: SelectionRequest): string | undefined {
    if (request.excludeDeviceIds?.includes(device.id) === true) {
      return "excluded for this task";
    }

    // 1. Operating role: client devices without worker role cannot execute tasks
    if (!canAcceptTasks(device.role)) {
      return `role ${device.role}: this device is a client, not an executor`;
    }

    // 2. Revocation status
    if (device.trust === "REVOKED" || device.revokedAt !== null) {
      return "device revoked";
    }

    // 3. Trust state
    if (device.trust !== "TRUSTED") {
      return "device not approved yet";
    }

    // 4. Online and authenticated
    if (!isOperational(device)) {
      return device.status === "ONLINE" ? "session not authenticated" : "offline";
    }

    // 5. Declared capabilities
    const missing = missingCapabilities(device.capabilities, request.requiredCapabilities);
    if (missing.length > 0) {
      return `missing capability: ${missing.join(", ")}`;
    }

    // 6. Granted permissions
    const granted = new Set([...device.grantedPermissions]);
    const unauthorized = request.requiredCapabilities.filter(
      (capability) => !isPermitted(granted, permissionForCapability(capability)),
    );
    if (unauthorized.length > 0) {
      return `permission not granted: ${unauthorized.join(", ")}`;
    }

    // 7. Concurrency capacity
    if (device.health.activeTasks >= device.health.maxConcurrentTasks) {
      return `already busy (${String(device.health.activeTasks)} task(s) running)`;
    }

    // 8. Task constraints
    const constraints = request.constraints;
    if (constraints?.deviceTypes !== undefined && !constraints.deviceTypes.includes(device.type)) {
      return `type ${device.type} does not match the constraint`;
    }
    if (constraints?.platforms !== undefined && !constraints.platforms.includes(device.platform)) {
      return `platform ${device.platform} does not match the constraint`;
    }
    if (constraints?.requireMainsPower === true && device.health.onBattery === true) {
      return "on battery while the task requires mains power";
    }
    if (constraints?.minGpuVramMb !== undefined) {
      const gpus = device.health.gpuResources ?? [];
      const hasSufficientVram = gpus.some(
        (gpu) => gpu.freeVramMb >= (constraints.minGpuVramMb ?? 0),
      );
      if (!hasSufficientVram) {
        return `insufficient GPU VRAM (required: ${constraints.minGpuVramMb}MB)`;
      }
    }

    return undefined;
  }

  #score(device: Device, request: SelectionRequest): ScoredCandidate {
    const weights = this.#weights;
    const reasons: string[] = [];
    let score = 0;

    if (request.preferredDeviceId === device.id) {
      score += weights.preference;
      reasons.push("explicitly selected by user");
    }

    const capacity = device.health.maxConcurrentTasks;
    const free = Math.max(0, capacity - device.health.activeTasks) / capacity;
    score += free * weights.availability;
    if (device.health.activeTasks === 0) reasons.push("no active tasks");

    const cpuFree = 1 - (device.health.cpuLoad ?? 0.5);
    score += cpuFree * weights.health;

    if (device.health.latencyMs !== undefined) {
      const latencyScore = Math.max(0, 1 - device.health.latencyMs / 500);
      score += latencyScore * weights.latency;
    }

    if (device.health.onBattery === false) {
      score += weights.mainsPower;
      reasons.push("mains powered");
    }

    const extra = device.capabilities.length - request.requiredCapabilities.length;
    score += Math.max(0, 1 - extra / 20) * weights.specialization;

    const gpus = device.health.gpuResources ?? [];
    if (gpus.length > 0) {
      const maxFreeVramMb = Math.max(...gpus.map((g) => g.freeVramMb));
      score += Math.min(250, (maxFreeVramMb / 1024) * 10);
      if (maxFreeVramMb >= 8192) {
        reasons.push(`high GPU VRAM (${Math.round(maxFreeVramMb / 1024)}GB free)`);
      }
    }

    return { device, score: Math.round(score), reasons };
  }

  /** Generates rejection explanations for devices. */
  async #explain(request: SelectionRequest): Promise<SelectionResult["rejected"]> {
    const devices = await this.#registry.listDevices(request.userId);
    const rejected: SelectionResult["rejected"] = [];

    for (const device of devices) {
      const reason = this.#reject(device, request);
      if (reason !== undefined) {
        rejected.push({ deviceId: device.id, name: device.name, reason });
      }
    }
    return rejected;
  }
}

/** Domain wildcard (`terminal.*`) or global wildcard (`*`) satisfies required permission. */
function isPermitted(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has("*") || granted.has(required)) return true;

  const domain = required.split(".")[0];
  return domain !== undefined && granted.has(`${domain}.*`);
}
