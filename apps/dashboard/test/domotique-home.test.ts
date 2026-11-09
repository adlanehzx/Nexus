import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DashboardApi } from "../src/lib/api.js";
import { IconBulb, IconLock, IconPlug, IconThermometer } from "../src/ui/icons.js";

function apiWith(body: unknown, status = 200) {
  const authorizedRequest = vi.fn().mockResolvedValue({ status, body });
  return { api: new DashboardApi({ authorizedRequest } as never), authorizedRequest };
}

describe("Lab 4 — Domotique dashboard", () => {
  it("contains no Unicode emoji and no hard-coded room list", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const file of ["domotique.tsx", "domotique-home.tsx"]) {
      const source = readFileSync(resolve(__dirname, `../src/ui/sections/${file}`), "utf8");
      expect(emoji.test(source)).toBe(false);
      expect(source).not.toContain("DEFAULT_ROOMS");
      // Nothing is tailored to one home: no private address is built in.
      expect(source).not.toMatch(/\b(192\.168|10\.\d+\.\d+|172\.(1[6-9]|2\d|3[01]))\.\d+/);
    }
  });

  it("exposes the new device icons as SVG", () => {
    for (const Icon of [IconBulb, IconPlug, IconLock, IconThermometer]) {
      const element = Icon({ size: 18 });
      expect(element.type).toBe("svg");
      expect(element.props.viewBox).toBe("0 0 24 24");
    }
  });

  it("sends the HA token only on configuration and never expects it back", async () => {
    const { api, authorizedRequest } = apiWith({
      data: { configured: true, token: { stored: true, persistence: "vault" } },
    });
    const status = await api.configureHomeAssistant({
      baseUrl: "http://ha.local:8123",
      token: "secret-token",
    });
    expect(authorizedRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/domotique/home-assistant",
      body: { baseUrl: "http://ha.local:8123", token: "secret-token" },
    });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("posts device actions to /api/v1/devices/:id/actions with the id encoded", async () => {
    const { api, authorizedRequest } = apiWith(
      {
        data: {
          status: "pending_confirmation",
          message: "Unlock",
          deviceId: "ha:lock.door",
          confirmationId: "c1",
        },
      },
      202,
    );
    const outcome = await api.runHomeDeviceAction("ha:lock.door", { action: "unlock" });
    expect(authorizedRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/v1/devices/ha%3Alock.door/actions",
      body: { action: "unlock" },
    });
    expect(outcome.confirmationId).toBe("c1");
  });

  it("wires scenes, routines, rooms, logs and voice endpoints", async () => {
    const { api, authorizedRequest } = apiWith({ data: [] });
    await api.homeScenes();
    await api.runHomeScene("s1");
    await api.homeRoutines();
    await api.runHomeRoutine("r1");
    await api.createHomeRoom("Garage");
    await api.homeLogs(10);
    await api.homeVoice();
    await api.getDeviceTopology();
    const paths = authorizedRequest.mock.calls.map(
      ([call]) => `${String(call.method)} ${String(call.path)}`,
    );
    expect(paths).toEqual([
      "GET /api/v1/domotique/scenes",
      "POST /api/v1/domotique/scenes/s1/run",
      "GET /api/v1/domotique/routines",
      "POST /api/v1/domotique/routines/r1/run",
      "POST /api/v1/domotique/rooms",
      "GET /api/v1/domotique/logs?limit=10",
      "GET /api/v1/domotique/voice",
      "GET /api/v1/devices/topology",
    ]);
  });

  it("wires zero-configuration endpoints: HA discovery/setup/login, satellite enrolment, TVs", async () => {
    const { api, authorizedRequest } = apiWith({ data: {} });
    await api.discoverHomeAssistant();
    await api.autoSetupHomeAssistant({ baseUrl: "http://homeassistant.local:8123" });
    await api.loginHomeAssistant({
      baseUrl: "http://homeassistant.local:8123",
      username: "u",
      password: "p",
    });
    await api.homeAssistantDiscovered();
    await api.acceptHomeAssistantDiscovered("abcdef0123456789");
    await api.satelliteEnrollments();
    await api.approveSatellite("esp32-a1", { verificationCode: "123456" });
    await api.rejectSatellite("esp32-b2");
    await api.removeSatellite("esp32-a1");
    await api.homeTvs();
    await api.addHomeTv("tv.local:5555", "TV");
    await api.removeHomeTv("tv.local:5555");
    const paths = authorizedRequest.mock.calls.map(
      ([call]) => `${String(call.method)} ${String(call.path)}`,
    );
    expect(paths).toEqual([
      "GET /api/v1/domotique/home-assistant/discover",
      "POST /api/v1/domotique/home-assistant/auto-setup",
      "POST /api/v1/domotique/home-assistant/login",
      "GET /api/v1/domotique/home-assistant/discovered",
      "POST /api/v1/domotique/home-assistant/discovered/abcdef0123456789/accept",
      "GET /api/v1/satellites/enrollments",
      "POST /api/v1/satellites/enrollments/esp32-a1/approve",
      "POST /api/v1/satellites/enrollments/esp32-b2/reject",
      "DELETE /api/v1/satellites/esp32-a1",
      "GET /api/v1/domotique/tvs",
      "POST /api/v1/domotique/tvs",
      "DELETE /api/v1/domotique/tvs/tv.local%3A5555",
    ]);
  });
});
