import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DashboardApi } from "../src/lib/api.js";
import { isLabSection } from "../src/ui/App.js";
import {
  IconBattery,
  IconBatteryCharging,
  IconHardware,
  IconHome,
  IconMic,
  IconMicOff,
  IconRadio,
  IconSatellite,
  IconVolume,
  IconVolumeX,
  IconWifi,
} from "../src/ui/icons.js";

describe("ESP32 Satellites Management & Monitoring UI (Lot 11.2 & Lab Domotique)", () => {
  it("enforces strict prohibition of Unicode emojis in UI code and icons", () => {
    const satellitesSource = readFileSync(
      resolve(__dirname, "../src/ui/sections/satellites.tsx"),
      "utf8",
    );
    const domotiqueSource = readFileSync(
      resolve(__dirname, "../src/ui/sections/domotique.tsx"),
      "utf8",
    );
    const iconsSource = readFileSync(resolve(__dirname, "../src/ui/icons.tsx"), "utf8");

    // Emoji pattern matching pictographs
    const emojiRegex = /\p{Extended_Pictographic}/u;

    expect(emojiRegex.test(satellitesSource)).toBe(false);
    expect(emojiRegex.test(domotiqueSource)).toBe(false);
    expect(emojiRegex.test(iconsSource)).toBe(false);
  });

  it("classifies domotique and satellites as Lab sections", () => {
    expect(isLabSection("domotique")).toBe(true);
    expect(isLabSection("satellites")).toBe(true);
  });

  it("exports all pure vector SVG icons required for domotique & satellite telemetry", () => {
    const icons = [
      IconHome,
      IconWifi,
      IconBattery,
      IconBatteryCharging,
      IconMic,
      IconMicOff,
      IconVolume,
      IconVolumeX,
      IconSatellite,
      IconHardware,
      IconRadio,
    ];

    for (const Icon of icons) {
      const el = Icon({ size: 16 });
      expect(el).toBeDefined();
      expect(el.type).toBe("svg");
      expect(el.props["aria-hidden"]).toBe(true);
      expect(el.props.viewBox).toBe("0 0 24 24");
      expect(el.props.width).toBe(16);
      expect(el.props.height).toBe(16);
    }
  });

  it("calls GET /api/v1/satellites when listing fleet", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        satellites: [
          {
            deviceId: "sat-esp32-livingroom",
            name: "Living Room Satellite",
            health: {
              batteryPercent: 88,
              charging: false,
              wifiRssi: -58,
              microphone: { active: true, muted: false },
              speaker: { active: true, volume: 75 },
              room: "Salon",
            },
            capabilities: [{ name: "audio.input" }, { name: "audio.output" }],
            lastSeenAt: new Date().toISOString(),
            online: true,
          },
        ],
      },
    });

    const session = { authorizedRequest: mockRequest };
    const api = new DashboardApi(session as never);

    const result = await api.satellites();
    expect(mockRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/v1/satellites",
      body: undefined,
    });
    expect(result.satellites).toHaveLength(1);
    expect(result.satellites[0]?.deviceId).toBe("sat-esp32-livingroom");
    expect(result.satellites[0]?.health.batteryPercent).toBe(88);
  });

  it("sends hardware commands to POST /api/v1/satellites/:deviceId/commands", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        data: {
          v: 1,
          type: "command",
          correlationId: "cor-12345",
          command: "system.ping",
          params: {},
          ts: Date.now(),
        },
      },
    });

    const session = { authorizedRequest: mockRequest };
    const api = new DashboardApi(session as never);

    const cmd = await api.pingSatellite("sat-esp32-salon");
    expect(mockRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/satellites/sat-esp32-salon/commands",
      body: {
        command: "system.ping",
        params: {},
      },
    });
    expect(cmd.correlationId).toBe("cor-12345");
  });

  it("checks command status via GET /api/v1/satellites/:deviceId/commands/:correlationId", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        data: {
          state: "completed",
          result: {
            v: 1,
            type: "command.result",
            correlationId: "cor-12345",
            ok: true,
            status: 200,
            message: "Pong",
          },
        },
      },
    });

    const session = { authorizedRequest: mockRequest };
    const api = new DashboardApi(session as never);

    const statusRes = await api.satelliteCommandStatus("sat-esp32-salon", "cor-12345");
    expect(mockRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/v1/satellites/sat-esp32-salon/commands/cor-12345",
      body: undefined,
    });
    expect(statusRes.state).toBe("completed");
    expect(statusRes.result?.ok).toBe(true);
  });

  it("registers satellite and prepares ticket with provisioning JSON payload", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        token: "tok-sec-987",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        payload: "https://api.nexus.lan/pair?token=tok-sec-987",
      },
    });

    const session = { authorizedRequest: mockRequest };
    const api = new DashboardApi(session as never);

    const res = await api.registerSatellite({
      deviceId: "sat-esp32-kitchen",
      name: "Kitchen Voice",
      room: "Cuisine",
    });

    expect(mockRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/devices/pairing-tickets",
      body: { label: "satellite:sat-esp32-kitchen:Cuisine" },
    });
    expect(res.ticket.token).toBe("tok-sec-987");

    const parsedPayload = JSON.parse(res.provisioningPayload) as {
      deviceId: string;
      name: string;
      room: string;
      token: string;
      apiUrl: string;
    };
    expect(parsedPayload.deviceId).toBe("sat-esp32-kitchen");
    expect(parsedPayload.name).toBe("Kitchen Voice");
    expect(parsedPayload.room).toBe("Cuisine");
    expect(parsedPayload.token).toBe("tok-sec-987");
  });

  it("handles voice/speaker diagnostics command dispatch", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        data: {
          v: 1,
          type: "command",
          correlationId: "diag-voice-77",
          command: "system.diagnostics",
          params: { target: "both", test: "audio" },
          ts: Date.now(),
        },
      },
    });

    const session = { authorizedRequest: mockRequest };
    const api = new DashboardApi(session as never);

    const res = await api.testSatelliteVoiceSpeaker("sat-esp32-office", "both");
    expect(mockRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/satellites/sat-esp32-office/commands",
      body: expect.objectContaining({
        command: "system.diagnostics",
        params: expect.objectContaining({
          target: "both",
          test: "audio",
        }),
      }),
    });
    expect(res.correlationId).toBe("diag-voice-77");
  });

  it("handles privacy mute command dispatch", async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        data: {
          v: 1,
          type: "command",
          correlationId: "priv-99",
          command: "audio.privacy",
          params: { muted: true },
          ts: Date.now(),
        },
      },
    });

    const session = { authorizedRequest: mockRequest };
    const api = new DashboardApi(session as never);

    const res = await api.setSatellitePrivacy("sat-esp32-office", true);
    expect(mockRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/satellites/sat-esp32-office/commands",
      body: {
        command: "audio.privacy",
        params: { muted: true },
      },
    });
    expect(res.correlationId).toBe("priv-99");
  });
});
