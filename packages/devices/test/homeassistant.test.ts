import { describe, expect, it, vi } from "vitest";
import {
  HomeAssistantBridge,
  HomeAssistantPermissionDeniedError,
  type HomeAssistantClientAdapter,
  type HomeAssistantServiceCall,
} from "../src/homeassistant.js";

describe("Home Assistant Integration with Separate Read and Write Permissions", () => {
  it("allows reading state with homeassistant.read permission", async () => {
    const mockAdapter: HomeAssistantClientAdapter = {
      getState: vi.fn().mockResolvedValue({
        entityId: "light.living_room",
        state: "on",
        attributes: { brightness: 255 },
        lastChanged: "2026-10-24T10:00:00Z",
      }),
      callService: vi.fn(),
    };

    const bridge = new HomeAssistantBridge(mockAdapter);

    // With read permission
    const state = await bridge.readEntity("light.living_room", ["homeassistant.read"]);
    expect(state?.state).toBe("on");
    expect(mockAdapter.getState).toHaveBeenCalledWith("light.living_room");

    // Without read permission -> fails closed
    await expect(bridge.readEntity("light.living_room", ["terminal.execute"])).rejects.toThrowError(
      HomeAssistantPermissionDeniedError,
    );
  });

  it("strictly separates write mutations from read permission", async () => {
    const mockAdapter: HomeAssistantClientAdapter = {
      getState: vi.fn().mockResolvedValue({
        entityId: "switch.coffee_maker",
        state: "off",
        attributes: {},
        lastChanged: "2026-10-24T10:00:00Z",
      }),
      callService: vi.fn().mockResolvedValue({
        success: true,
        newState: "on",
      }),
    };

    const bridge = new HomeAssistantBridge(mockAdapter);

    const call: HomeAssistantServiceCall = {
      domain: "switch",
      service: "turn_on",
      targetEntityId: "switch.coffee_maker",
    };

    // User only has READ permission: write must fail closed
    await expect(
      bridge.executeWriteAction(call, ["homeassistant.read"], "user_adlane"),
    ).rejects.toThrowError(HomeAssistantPermissionDeniedError);

    // Audit log records the denied mutation
    expect(bridge.getAuditLog()).toContainEqual(
      expect.objectContaining({
        initiator: "user_adlane",
        success: false,
        error: "Missing homeassistant.write",
      }),
    );

    // User has WRITE permission: succeeds and records audit log with state diff
    const result = await bridge.executeWriteAction(call, ["homeassistant.write"], "user_adlane");
    expect(result.success).toBe(true);
    expect(result.newState).toBe("on");

    const auditTrail = bridge.getAuditLog();
    const successEvent = auditTrail.find((e) => e.success);
    expect(successEvent).toBeDefined();
    expect(successEvent?.previousState).toBe("off");
    expect(successEvent?.newState).toBe("on");
  });
});
