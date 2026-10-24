/**
 * Minimal-distraction vehicle mode controller.
 *
 * ## Principles
 * 1. Strictly hands-free or ultra-simplified two-touch interface (>= 80dp targets).
 * 2. On-screen typing keyboards are strictly prohibited while in vehicle mode to prevent driver distraction.
 * 3. Audible status readouts (TTS) accompany all state transitions.
 * 4. Full privacy transparency: microphone activity is prominently indicated and audit logged.
 * 5. Destructive actions cannot be confirmed without deliberate manual override.
 */

export interface VehicleModeState {
  readonly active: boolean;
  readonly locked: boolean;
  readonly speedKmh?: number | undefined;
  readonly microphoneActive: boolean;
  readonly activeTaskTitle?: string | undefined;
  readonly pendingPrompt?: string | undefined;
  readonly lastSpokenMessage?: string | undefined;
}

export type VehicleAuditEventType =
  | "VEHICLE_MODE_ENTERED"
  | "VEHICLE_MODE_EXITED"
  | "VEHICLE_VOICE_TRIGGERED"
  | "VEHICLE_ACTION_APPROVED"
  | "VEHICLE_ACTION_ABORTED"
  | "KEYBOARD_INPUT_BLOCKED";

export interface VehicleAuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly type: VehicleAuditEventType;
  readonly speedKmh?: number | undefined;
  readonly details?: string | undefined;
}

export class KeyboardRestrictedInVehicleModeError extends Error {
  readonly code = "KEYBOARD_RESTRICTED_IN_VEHICLE_MODE";
  readonly httpStatus = 400;
  readonly userMessage =
    "Keyboard typing is disabled in Vehicle Mode. Please use voice or tap Confirm/Abort.";

  constructor() {
    super("Text keyboard input is blocked while vehicle mode is active to ensure road safety.");
    this.name = "KeyboardRestrictedInVehicleModeError";
  }
}

export interface VehicleModeOptions {
  /** Speed threshold in km/h above which vehicle mode auto-locks (default: 15 km/h). */
  speedLockThresholdKmh?: number;
  speakText?: (text: string) => Promise<void>;
}

export class VehicleModeController {
  readonly #speedLockThresholdKmh: number;
  readonly #speakText?: ((text: string) => Promise<void>) | undefined;
  readonly #auditLog: VehicleAuditEvent[] = [];

  #state: VehicleModeState = {
    active: false,
    locked: false,
    microphoneActive: false,
  };

  constructor(options?: VehicleModeOptions) {
    this.#speedLockThresholdKmh = options?.speedLockThresholdKmh ?? 15;
    this.#speakText = options?.speakText;
  }

  get state(): VehicleModeState {
    return { ...this.#state };
  }

  get auditLog(): readonly VehicleAuditEvent[] {
    return this.#auditLog;
  }

  /** Activates vehicle mode. */
  async enter(speedKmh?: number): Promise<void> {
    const isLocked = speedKmh !== undefined && speedKmh >= this.#speedLockThresholdKmh;
    this.#state = {
      ...this.#state,
      active: true,
      locked: isLocked,
      ...(speedKmh !== undefined ? { speedKmh } : {}),
      lastSpokenMessage: "Vehicle mode active. Voice guidance enabled.",
    };

    this.#recordAudit("VEHICLE_MODE_ENTERED", speedKmh, "Vehicle mode engaged.");
    if (this.#speakText && this.#state.lastSpokenMessage) {
      await this.#speakText(this.#state.lastSpokenMessage);
    }
  }

  /** Exits vehicle mode. */
  async exit(): Promise<void> {
    this.#state = {
      active: false,
      locked: false,
      microphoneActive: false,
    };
    this.#recordAudit("VEHICLE_MODE_EXITED", undefined, "Vehicle mode disengaged.");
    if (this.#speakText) {
      await this.#speakText("Vehicle mode disengaged.");
    }
  }

  /** Updates current vehicle speed reading from GPS or vehicle CAN/OBD. */
  updateSpeed(speedKmh: number): void {
    const shouldLock = speedKmh >= this.#speedLockThresholdKmh;
    this.#state = {
      ...this.#state,
      speedKmh,
      locked: shouldLock,
    };
  }

  /** Attempts to open keyboard or submit manual typed input; rejected fail-closed. */
  attemptKeyboardInput(): never {
    if (this.#state.active) {
      this.#recordAudit(
        "KEYBOARD_INPUT_BLOCKED",
        this.#state.speedKmh,
        "Keyboard typing rejected for safety.",
      );
      throw new KeyboardRestrictedInVehicleModeError();
    }
    throw new Error("Vehicle mode inactive.");
  }

  /** Starts voice input capture with visible microphone indicator. */
  async startVoiceCapture(): Promise<void> {
    if (!this.#state.active) return;
    this.#state = {
      ...this.#state,
      microphoneActive: true,
    };
    this.#recordAudit("VEHICLE_VOICE_TRIGGERED", this.#state.speedKmh, "Microphone listening.");
  }

  /** Stops voice capture. */
  stopVoiceCapture(): void {
    this.#state = {
      ...this.#state,
      microphoneActive: false,
    };
  }

  /** Executes large-target tactile confirmation. */
  async confirmActiveAction(actionTitle: string): Promise<{ success: boolean; message: string }> {
    if (!this.#state.active) {
      return { success: false, message: "Vehicle mode is not active." };
    }
    this.#recordAudit("VEHICLE_ACTION_APPROVED", this.#state.speedKmh, `Approved: ${actionTitle}`);
    const announcement = `Action approved: ${actionTitle}`;
    if (this.#speakText) {
      await this.#speakText(announcement);
    }
    return { success: true, message: announcement };
  }

  /** Executes large-target tactile abort/dismiss. */
  async abortActiveAction(reason: string): Promise<{ success: boolean; message: string }> {
    if (!this.#state.active) {
      return { success: false, message: "Vehicle mode is not active." };
    }
    this.#recordAudit("VEHICLE_ACTION_ABORTED", this.#state.speedKmh, `Aborted: ${reason}`);
    const announcement = `Action aborted: ${reason}`;
    if (this.#speakText) {
      await this.#speakText(announcement);
    }
    return { success: true, message: announcement };
  }

  #recordAudit(type: VehicleAuditEventType, speedKmh?: number, details?: string): void {
    this.#auditLog.push({
      id: `vaudit_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      type,
      ...(speedKmh !== undefined ? { speedKmh } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
}
