import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/capabilities.js";
import { DeviceRegistry } from "../src/registry.js";
import { DeviceSelector } from "../src/selector.js";
import type { Device, GpuResourceInfo } from "../src/types.js";

describe("GPU Worker Scheduling and Resource Reporting", () => {
  it("selects worker based on available GPU VRAM and capabilities", async () => {
    const registry = new DeviceRegistry();
    const selector = new DeviceSelector({ registry });

    const rtx4090Gpu: GpuResourceInfo = {
      vendor: "nvidia",
      model: "RTX 4090",
      totalVramMb: 24576,
      freeVramMb: 20480,
      computeUtilizationPercent: 12,
      temperatureCelsius: 48,
    };

    const gtx1060Gpu: GpuResourceInfo = {
      vendor: "nvidia",
      model: "GTX 1060",
      totalVramMb: 6144,
      freeVramMb: 2048,
      computeUtilizationPercent: 60,
      temperatureCelsius: 65,
    };

    const gpuWorkstation: Device = {
      id: "device_gpu_rig",
      userId: "user_1",
      name: "AI Workstation Rig",
      type: "LINUX",
      platform: "LINUX",
      role: "WORKER",
      status: "ONLINE",
      trust: "TRUSTED",
      authenticated: true,
      pairedAt: new Date(),
      revokedAt: null,
      lastSeenAt: new Date(),
      agentVersion: "1.0.0",
      metadata: {},
      capabilities: [
        {
          name: CAPABILITIES.gpuCompute,
          version: "1",
          description: "NVIDIA CUDA compute",
          enabled: true,
          metadata: {},
        },
        {
          name: CAPABILITIES.gpuInference,
          version: "1",
          description: "Local LLM inference",
          enabled: true,
          metadata: {},
        },
      ],
      grantedPermissions: [CAPABILITIES.gpuCompute, CAPABILITIES.gpuInference],
      health: {
        activeTasks: 0,
        maxConcurrentTasks: 4,
        gpuResources: [rtx4090Gpu],
      },
    };

    const miniPc: Device = {
      id: "device_mini_pc",
      userId: "user_1",
      name: "Office Mini PC",
      type: "WINDOWS_PC",
      platform: "WINDOWS",
      role: "WORKER",
      status: "ONLINE",
      trust: "TRUSTED",
      authenticated: true,
      pairedAt: new Date(),
      revokedAt: null,
      lastSeenAt: new Date(),
      agentVersion: "1.0.0",
      metadata: {},
      capabilities: [
        {
          name: CAPABILITIES.gpuCompute,
          version: "1",
          description: "Basic GPU compute",
          enabled: true,
          metadata: {},
        },
      ],
      grantedPermissions: [CAPABILITIES.gpuCompute],
      health: {
        activeTasks: 0,
        maxConcurrentTasks: 2,
        gpuResources: [gtx1060Gpu],
      },
    };

    await registry.registerDevice(gpuWorkstation);
    await registry.registerDevice(miniPc);

    await registry.trustDevice(gpuWorkstation.id);
    await registry.setAuthenticated(gpuWorkstation.id, true);
    await registry.updateHeartbeat(gpuWorkstation.id, gpuWorkstation.health);

    await registry.trustDevice(miniPc.id);
    await registry.setAuthenticated(miniPc.id, true);
    await registry.updateHeartbeat(miniPc.id, miniPc.health);

    // 1. Task requiring 12GB VRAM (12288 MB)
    const heavyResult = await selector.select({
      userId: "user_1",
      requiredCapabilities: [CAPABILITIES.gpuCompute],
      constraints: {
        minGpuVramMb: 12288,
      },
    });

    expect(heavyResult.device.id).toBe("device_gpu_rig");
    expect(heavyResult.candidates.length).toBe(1);
    expect(heavyResult.rejected).toContainEqual(
      expect.objectContaining({
        deviceId: "device_mini_pc",
        reason: expect.stringContaining("insufficient GPU VRAM (required: 12288MB)"),
      }),
    );

    // 2. Task requiring 1GB VRAM (both qualify, workstation preferred)
    const lightResult = await selector.select({
      userId: "user_1",
      requiredCapabilities: [CAPABILITIES.gpuCompute],
      constraints: {
        minGpuVramMb: 1024,
      },
    });

    expect(lightResult.candidates.length).toBe(2);
    expect(lightResult.device.id).toBe("device_gpu_rig");
  });
});
