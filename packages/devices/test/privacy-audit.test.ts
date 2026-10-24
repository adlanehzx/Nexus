import { describe, expect, it } from "vitest";
import { DevicePrivacyAccessDeniedError, DevicePrivacyMonitor } from "../src/privacy.js";

describe("Camera and Sensor Capabilities with Visible Privacy State", () => {
  it("tracks camera, mic, and sensor capture transitions and sets indicatorVisible", () => {
    const monitor = new DevicePrivacyMonitor();
    const deviceId = "dev_rpi_satellite";

    // Initial state
    const initial = monitor.getPrivacyState(deviceId);
    expect(initial.camera).toBe("idle");
    expect(initial.microphone).toBe("idle");
    expect(initial.indicatorVisible).toBe(false);

    // Camera access
    const stateWithCam = monitor.startAccess({
      deviceId,
      capability: "camera.stream",
      initiator: "user_adlane",
      allowed: true,
    });
    expect(stateWithCam.camera).toBe("capturing");
    expect(stateWithCam.indicatorVisible).toBe(true);

    // Sensor access
    const stateWithSensor = monitor.startAccess({
      deviceId,
      capability: "sensor.temperature",
      initiator: "automation_climate",
      allowed: true,
    });
    expect(stateWithSensor.sensors["sensor.temperature"]).toBe("capturing");
    expect(stateWithSensor.indicatorVisible).toBe(true);

    // Stop camera
    const stateCamStopped = monitor.stopAccess({
      deviceId,
      capability: "camera.stream",
      initiator: "user_adlane",
    });
    expect(stateCamStopped.camera).toBe("idle");
    // Sensor still capturing, so indicator remains visible
    expect(stateCamStopped.indicatorVisible).toBe(true);

    // Stop sensor
    const stateAllStopped = monitor.stopAccess({
      deviceId,
      capability: "sensor.temperature",
      initiator: "automation_climate",
    });
    expect(stateAllStopped.sensors["sensor.temperature"]).toBe("idle");
    expect(stateAllStopped.indicatorVisible).toBe(false);
  });

  it("throws fail-closed on denied access and creates audit log", () => {
    const monitor = new DevicePrivacyMonitor();
    const deviceId = "dev_laptop";

    expect(() =>
      monitor.startAccess({
        deviceId,
        capability: "camera.capture",
        initiator: "untrusted_agent",
        allowed: false,
        reasonIfDenied: "User policy prohibits background camera access.",
      }),
    ).toThrowError(DevicePrivacyAccessDeniedError);

    const auditTrail = monitor.getAuditTrail();
    expect(auditTrail.length).toBe(1);
    expect(auditTrail[0].action).toBe("denied");
    expect(auditTrail[0].capability).toBe("camera.capture");
    expect(auditTrail[0].details).toContain("User policy prohibits");
  });

  it("closes all capture streams on session disconnect or logout", () => {
    const monitor = new DevicePrivacyMonitor();
    const deviceId = "dev_iphone_15";

    monitor.startAccess({
      deviceId,
      capability: "voice.record",
      initiator: "dictation",
      allowed: true,
    });
    expect(monitor.getPrivacyState(deviceId).indicatorVisible).toBe(true);

    // Session disconnected
    const cleanState = monitor.closeAll(
      deviceId,
      "system_heartbeat_timeout",
      "Device disconnected",
    );
    expect(cleanState.microphone).toBe("idle");
    expect(cleanState.camera).toBe("idle");
    expect(cleanState.indicatorVisible).toBe(false);

    const audit = monitor.getAuditTrail();
    const stopEvent = audit.find((a) => a.action === "stop" && a.capability === "*");
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.details).toBe("Device disconnected");
  });
});
