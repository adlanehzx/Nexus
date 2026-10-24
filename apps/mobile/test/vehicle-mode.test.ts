import { describe, expect, it, vi } from "vitest";
import { KeyboardRestrictedInVehicleModeError, VehicleModeController } from "../lib/vehicle.js";

describe("VehicleModeController", () => {
  it("enters vehicle mode, reports state, and issues audible guidance", async () => {
    const speakMock = vi.fn().mockResolvedValue(undefined);
    const controller = new VehicleModeController({
      speakText: speakMock,
      speedLockThresholdKmh: 15,
    });

    expect(controller.state.active).toBe(false);

    await controller.enter(25); // 25 km/h -> should lock
    expect(controller.state.active).toBe(true);
    expect(controller.state.locked).toBe(true);
    expect(controller.state.speedKmh).toBe(25);
    expect(speakMock).toHaveBeenCalledWith(expect.stringContaining("Vehicle mode active"));

    const log = controller.auditLog;
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]?.type).toBe("VEHICLE_MODE_ENTERED");
  });

  it("strictly rejects keyboard input while vehicle mode is active", async () => {
    const controller = new VehicleModeController();
    await controller.enter(0);

    expect(() => controller.attemptKeyboardInput()).toThrowError(
      KeyboardRestrictedInVehicleModeError,
    );

    const blockedEvents = controller.auditLog.filter((e) => e.type === "KEYBOARD_INPUT_BLOCKED");
    expect(blockedEvents.length).toBe(1);
  });

  it("handles voice capture transitions and privacy state", async () => {
    const controller = new VehicleModeController();
    await controller.enter(10);

    expect(controller.state.microphoneActive).toBe(false);

    await controller.startVoiceCapture();
    expect(controller.state.microphoneActive).toBe(true);

    controller.stopVoiceCapture();
    expect(controller.state.microphoneActive).toBe(false);

    const voiceEvents = controller.auditLog.filter((e) => e.type === "VEHICLE_VOICE_TRIGGERED");
    expect(voiceEvents.length).toBe(1);
  });

  it("executes tactile confirmations and audit logs approvals", async () => {
    const speakMock = vi.fn().mockResolvedValue(undefined);
    const controller = new VehicleModeController({ speakText: speakMock });
    await controller.enter(30);

    const approval = await controller.confirmActiveAction("Run database vacuum");
    expect(approval.success).toBe(true);
    expect(speakMock).toHaveBeenCalledWith(expect.stringContaining("Action approved"));

    const abort = await controller.abortActiveAction("High traffic ahead");
    expect(abort.success).toBe(true);
    expect(speakMock).toHaveBeenCalledWith(expect.stringContaining("Action aborted"));

    const actions = controller.auditLog.filter(
      (e) => e.type === "VEHICLE_ACTION_APPROVED" || e.type === "VEHICLE_ACTION_ABORTED",
    );
    expect(actions.length).toBe(2);
  });

  it("cleanly disengages upon exit", async () => {
    const speakMock = vi.fn().mockResolvedValue(undefined);
    const controller = new VehicleModeController({ speakText: speakMock });
    await controller.enter(0);
    await controller.exit();

    expect(controller.state.active).toBe(false);
    expect(controller.state.locked).toBe(false);
    expect(speakMock).toHaveBeenCalledWith("Vehicle mode disengaged.");
  });
});
