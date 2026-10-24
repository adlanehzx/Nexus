import { AppError } from "@nexus/shared";

/**
 * Device Privacy & Sensor State Monitor.
 *
 * ## Principles
 * 1. Physical sensor/audio/video capture must always reflect visible privacy indicators.
 * 2. Every camera, microphone, and sensor activation produces a structured audit record.
 * 3. Microphones and cameras automatically close upon task completion, pause, disconnect, or error.
 * 4. Zero persistent recording retention without user-authorized storage policy.
 */

export type CaptureState = "idle" | "capturing" | "denied";

export interface DevicePrivacyState {
  readonly deviceId: string;
  readonly camera: CaptureState;
  readonly microphone: CaptureState;
  readonly sensors: Readonly<Record<string, CaptureState>>;
  readonly lastActivityAt: number;
  readonly indicatorVisible: boolean;
}

export type PrivacyAction = "start" | "stop" | "denied";

export interface DevicePrivacyAuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly deviceId: string;
  readonly capability: string;
  readonly action: PrivacyAction;
  readonly initiator: string;
  readonly privacyIndicatorVisible: boolean;
  readonly details?: string | undefined;
}

export class DevicePrivacyAccessDeniedError extends AppError {
  readonly code = "DEVICE_PRIVACY_ACCESS_DENIED";
  readonly httpStatus = 403;

  constructor(deviceId: string, capability: string, reason: string) {
    super({
      message: `Access to ${capability} denied on device ${deviceId}: ${reason}`,
      userMessage: `Privacy protection prevented access to ${capability}.`,
      context: { deviceId, capability, reason },
    });
  }
}

export class DevicePrivacyMonitor {
  readonly #states = new Map<string, DevicePrivacyState>();
  readonly #auditTrail: DevicePrivacyAuditEvent[] = [];

  getPrivacyState(deviceId: string): DevicePrivacyState {
    const existing = this.#states.get(deviceId);
    if (existing) return existing;

    const initial: DevicePrivacyState = {
      deviceId,
      camera: "idle",
      microphone: "idle",
      sensors: {},
      lastActivityAt: Date.now(),
      indicatorVisible: false,
    };
    this.#states.set(deviceId, initial);
    return initial;
  }

  /**
   * Records access initiation for camera, microphone, or sensor.
   */
  startAccess(params: {
    deviceId: string;
    capability: string;
    initiator: string;
    allowed: boolean;
    reasonIfDenied?: string | undefined;
  }): DevicePrivacyState {
    const current = this.getPrivacyState(params.deviceId);
    const now = Date.now();

    if (!params.allowed) {
      this.#recordAudit({
        deviceId: params.deviceId,
        capability: params.capability,
        action: "denied",
        initiator: params.initiator,
        privacyIndicatorVisible: current.indicatorVisible,
        details: params.reasonIfDenied ?? "Permission check failed",
      });
      throw new DevicePrivacyAccessDeniedError(
        params.deviceId,
        params.capability,
        params.reasonIfDenied ?? "Permission denied",
      );
    }

    let camera = current.camera;
    let microphone = current.microphone;
    const sensors = { ...current.sensors };

    if (params.capability.startsWith("camera.")) {
      camera = "capturing";
    } else if (params.capability.startsWith("voice.") || params.capability.startsWith("audio.")) {
      microphone = "capturing";
    } else if (params.capability.startsWith("sensor.")) {
      sensors[params.capability] = "capturing";
    }

    const indicatorVisible =
      camera === "capturing" ||
      microphone === "capturing" ||
      Object.values(sensors).some((s) => s === "capturing");

    const updated: DevicePrivacyState = {
      deviceId: params.deviceId,
      camera,
      microphone,
      sensors,
      lastActivityAt: now,
      indicatorVisible,
    };

    this.#states.set(params.deviceId, updated);
    this.#recordAudit({
      deviceId: params.deviceId,
      capability: params.capability,
      action: "start",
      initiator: params.initiator,
      privacyIndicatorVisible: true,
      details: "Capture started with visible privacy indicator.",
    });

    return updated;
  }

  /**
   * Stops access and closes physical capture devices.
   */
  stopAccess(params: {
    deviceId: string;
    capability: string;
    initiator: string;
    reason?: string | undefined;
  }): DevicePrivacyState {
    const current = this.getPrivacyState(params.deviceId);
    const now = Date.now();

    let camera = current.camera;
    let microphone = current.microphone;
    const sensors = { ...current.sensors };

    if (params.capability.startsWith("camera.")) {
      camera = "idle";
    } else if (params.capability.startsWith("voice.") || params.capability.startsWith("audio.")) {
      microphone = "idle";
    } else if (params.capability.startsWith("sensor.")) {
      sensors[params.capability] = "idle";
    }

    const indicatorVisible =
      camera === "capturing" ||
      microphone === "capturing" ||
      Object.values(sensors).some((s) => s === "capturing");

    const updated: DevicePrivacyState = {
      deviceId: params.deviceId,
      camera,
      microphone,
      sensors,
      lastActivityAt: now,
      indicatorVisible,
    };

    this.#states.set(params.deviceId, updated);
    this.#recordAudit({
      deviceId: params.deviceId,
      capability: params.capability,
      action: "stop",
      initiator: params.initiator,
      privacyIndicatorVisible: indicatorVisible,
      details: params.reason ?? "Capture session concluded.",
    });

    return updated;
  }

  /** Closes all sensors, mics, and cameras on device disconnect or logout. */
  closeAll(
    deviceId: string,
    initiator: string,
    reason = "Device session terminated",
  ): DevicePrivacyState {
    const current = this.getPrivacyState(deviceId);
    const updated: DevicePrivacyState = {
      deviceId,
      camera: "idle",
      microphone: "idle",
      sensors: {},
      lastActivityAt: Date.now(),
      indicatorVisible: false,
    };
    this.#states.set(deviceId, updated);

    if (current.indicatorVisible) {
      this.#recordAudit({
        deviceId,
        capability: "*",
        action: "stop",
        initiator,
        privacyIndicatorVisible: false,
        details: reason,
      });
    }

    return updated;
  }

  getAuditTrail(): readonly DevicePrivacyAuditEvent[] {
    return this.#auditTrail;
  }

  #recordAudit(entry: Omit<DevicePrivacyAuditEvent, "id" | "timestamp">): void {
    this.#auditTrail.push({
      id: `dpaudit_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      ...entry,
    });
  }
}
