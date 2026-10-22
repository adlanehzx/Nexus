import { AppError, type AppErrorOptions } from "@nexus/shared";

/**
 * Device plane errors.
 *
 * Follows the taxonomy in `@nexus/shared`: stable error code, safe user message,
 * retryability flag. A device selection failure is an observation the agent can relay,
 * not a crash.
 */

export class DeviceNotFoundError extends AppError {
  readonly code = "DEVICE_NOT_FOUND";
  readonly httpStatus = 404;
  readonly deviceId: string;

  constructor(deviceId: string) {
    super({
      message: `Unknown device: ${deviceId}`,
      userMessage: "This device is not registered.",
      context: { deviceId },
    });
    this.deviceId = deviceId;
  }
}

/**
 * No eligible worker can execute the step.
 *
 * `reasons` details why each candidate device was excluded: this is what the agent
 * relays to the user so they can understand how to resolve it (e.g. power on host).
 */
export class NoEligibleWorkerError extends AppError {
  readonly code = "NO_ELIGIBLE_WORKER";
  readonly httpStatus = 409;
  override readonly retryable = true;
  readonly requiredCapabilities: readonly string[];
  readonly reasons: readonly string[];

  constructor(requiredCapabilities: readonly string[], reasons: readonly string[]) {
    super({
      message: `No eligible worker for ${requiredCapabilities.join(", ")}`,
      userMessage:
        reasons.length > 0
          ? `No device can do this: ${reasons.join("; ")}.`
          : "No available device can carry out this action.",
      context: { requiredCapabilities, reasons },
    });
    this.requiredCapabilities = requiredCapabilities;
    this.reasons = reasons;
  }
}

/** The device does not declare the required capability. */
export class CapabilityNotRegisteredError extends AppError {
  readonly code = "CAPABILITY_NOT_REGISTERED";
  readonly httpStatus = 403;
  readonly deviceId: string;
  readonly capability: string;

  constructor(deviceId: string, capability: string) {
    super({
      message: `Device ${deviceId} does not advertise capability ${capability}`,
      userMessage: "This device cannot do this action.",
      context: { deviceId, capability },
    });
    this.deviceId = deviceId;
    this.capability = capability;
  }
}

export class DeviceRevokedError extends AppError {
  readonly code = "DEVICE_REVOKED";
  readonly httpStatus = 403;
  readonly deviceId: string;

  constructor(deviceId: string) {
    super({
      message: `Device revoked: ${deviceId}`,
      userMessage: "This device was revoked and can no longer run anything.",
      context: { deviceId },
    });
    this.deviceId = deviceId;
  }
}

export class DeviceAuthenticationError extends AppError {
  readonly code = "DEVICE_UNAUTHENTICATED";
  readonly httpStatus = 401;
  readonly deviceId: string;

  constructor(deviceId: string, reason: string, context: Record<string, unknown> = {}) {
    super({
      message: `Authentication rejected for ${deviceId}: ${reason}`,
      userMessage: "This device could not authenticate.",
      context: { deviceId, reason, ...context },
    });
    this.deviceId = deviceId;
  }
}

/** Replay detected or timestamp outside accepted window. */
export class ReplayRejectedError extends AppError {
  readonly code = "DEVICE_REPLAY_REJECTED";
  readonly httpStatus = 401;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Request rejected: signature already used, or stale.", ...options });
  }
}

/** The plan references a non-existent step or contains a cycle. */
export class InvalidTaskPlanError extends AppError {
  readonly code = "INVALID_TASK_PLAN";
  readonly httpStatus = 400;
  readonly details: readonly string[];

  constructor(details: readonly string[]) {
    super({
      message: `Invalid task plan: ${details.join("; ")}`,
      userMessage: "This task plan is inconsistent.",
      context: { details },
    });
    this.details = details;
  }
}
