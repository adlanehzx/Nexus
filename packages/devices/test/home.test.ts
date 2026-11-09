import { describe, expect, it, vi } from "vitest";
import {
  HomeAssistantAuthError,
  HomeAssistantClient,
  HomeAssistantStateCache,
  buildHomeDevices,
  createHomeTools,
  cronMatches,
  dueTimeRoutines,
  conditionsHold,
  expandRoutineActions,
  missingRoomsForAreas,
  normalizeHomeAssistantUrl,
  parseCron,
  sensitiveTargets,
  stateTriggeredRoutines,
  toHomeAssistantServiceCall,
  assertActionSupported,
  homeActionSchema,
  type HaSocket,
  type HomeAssistantSnapshot,
  type HomeRoutine,
  type HomeScene,
  type HomeToolsHost,
} from "../src/index.js";
import type { ToolContext } from "@nexus/tools";

// ─────────────────────────────────────────────────────────────────────────────
// Scripted Home Assistant WebSocket
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT: HomeAssistantSnapshot = {
  states: [
    {
      entity_id: "light.salon",
      state: "on",
      attributes: {
        friendly_name: "Lampe salon",
        brightness: 128,
        rgb_color: [255, 0, 0],
        supported_color_modes: ["hs"],
      },
      last_changed: "2026-11-09T10:00:00Z",
    },
    {
      entity_id: "switch.prise_radiateur",
      state: "off",
      attributes: { friendly_name: "Prise radiateur" },
    },
    {
      entity_id: "sensor.prise_radiateur_power",
      state: "1500",
      attributes: { device_class: "power", unit_of_measurement: "W" },
    },
    { entity_id: "lock.porte", state: "locked", attributes: { friendly_name: "Porte" } },
    { entity_id: "media_player.tv", state: "playing", attributes: { volume_level: 0.4 } },
    { entity_id: "sensor.temperature", state: "21", attributes: { device_class: "temperature" } },
  ],
  areas: [
    { area_id: "living_room", name: "Salon" },
    { area_id: "office", name: "Bureau" },
  ],
  devices: [
    { id: "dev_plug", name: "Plug", area_id: "office", manufacturer: "Shelly", model: "Plug S" },
  ],
  entities: [
    { entity_id: "light.salon", device_id: null, area_id: "living_room" },
    { entity_id: "switch.prise_radiateur", device_id: "dev_plug", area_id: null },
    { entity_id: "sensor.prise_radiateur_power", device_id: "dev_plug", area_id: null },
    { entity_id: "lock.porte", device_id: null, area_id: null },
  ],
};

class FakeHa {
  readonly sockets: FakeSocket[] = [];
  token = "good-token-123";
  refuse = false;

  factory = (url: string): HaSocket => {
    const socket = new FakeSocket(this, url);
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (this.refuse) socket.serverClose();
      else socket.emit("message", { data: JSON.stringify({ type: "auth_required" }) });
    });
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("no socket");
    return socket;
  }
}

class FakeSocket implements HaSocket {
  readonly sent: Record<string, unknown>[] = [];
  readonly listeners = new Map<string, ((event: never) => void)[]>();
  closed = false;
  subscriptionId: number | undefined;

  readonly server: FakeHa;
  readonly url: string;

  constructor(server: FakeHa, url: string) {
    this.server = server;
    this.url = url;
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    const reply = (payload: Record<string, unknown>) =>
      queueMicrotask(() => this.emit("message", { data: JSON.stringify(payload) }));
    if (message.type === "auth") {
      reply(
        message.access_token === this.server.token
          ? { type: "auth_ok", ha_version: "2026.11.1" }
          : { type: "auth_invalid", message: "Invalid access token" },
      );
      return;
    }
    const id = message.id as number;
    const results: Record<string, unknown> = {
      subscribe_events: null,
      get_states: SNAPSHOT.states,
      "config/area_registry/list": SNAPSHOT.areas,
      "config/device_registry/list": SNAPSHOT.devices,
      "config/entity_registry/list": SNAPSHOT.entities,
    };
    if (message.type === "subscribe_events") this.subscriptionId = id;
    if (message.type === "ping") {
      reply({ id, type: "pong" });
      return;
    }
    reply({ id, type: "result", success: true, result: results[message.type as string] ?? null });
  }

  pushStateChanged(entityId: string, newState: Record<string, unknown>): void {
    this.emit("message", {
      data: JSON.stringify({
        id: this.subscriptionId,
        type: "event",
        event: {
          event_type: "state_changed",
          data: { entity_id: entityId, old_state: null, new_state: newState },
        },
      }),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close", { code: 1000 }));
  }

  serverClose(): void {
    this.closed = true;
    this.emit("close", { code: 1006 });
  }
}

function makeClient(ha: FakeHa, overrides: Partial<{ token: string; fetch: typeof fetch }> = {}) {
  return new HomeAssistantClient({
    baseUrl: "http://ha.local:8123/",
    token: overrides.token ?? ha.token,
    socketFactory: ha.factory,
    backoff: { initialMs: 5, maxMs: 20 },
    random: () => 1,
    keepaliveMs: 0,
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
  });
}

describe("HomeAssistantClient", () => {
  it("normalizes URLs and rejects non-http schemes and embedded credentials", () => {
    expect(normalizeHomeAssistantUrl("http://homeassistant.local:8123/")).toBe(
      "http://homeassistant.local:8123",
    );
    expect(() => normalizeHomeAssistantUrl("ftp://x")).toThrow();
    expect(() => normalizeHomeAssistantUrl("http://u:p@x")).toThrow();
  });

  it("authenticates over WebSocket, subscribes to state_changed and syncs registries", async () => {
    const ha = new FakeHa();
    const client = makeClient(ha);
    await client.connect();
    expect(ha.last.url).toBe("ws://ha.local:8123/api/websocket");
    expect(client.status.state).toBe("connected");
    expect(client.status.haVersion).toBe("2026.11.1");
    expect(
      ha.last.sent.some((m) => m.type === "subscribe_events" && m.event_type === "state_changed"),
    ).toBe(true);

    const snapshot = await client.fetchSnapshot();
    expect(snapshot.states).toHaveLength(SNAPSHOT.states.length);
    expect(snapshot.areas.map((a) => a.name)).toEqual(["Salon", "Bureau"]);
    client.close();
    expect(client.status.state).toBe("disconnected");
  });

  it("reports auth failure without retrying and never exposes the token", async () => {
    const ha = new FakeHa();
    const client = makeClient(ha, { token: "wrong-token-xyz" });
    await expect(client.connect()).rejects.toBeInstanceOf(HomeAssistantAuthError);
    expect(client.status.state).toBe("auth_failed");
    await new Promise((r) => setTimeout(r, 40));
    expect(ha.sockets).toHaveLength(1);
    expect(JSON.stringify(client)).not.toContain("wrong-token-xyz");
    expect(JSON.stringify(client.status)).not.toContain("wrong-token-xyz");
  });

  it("delivers state_changed events to listeners", async () => {
    const ha = new FakeHa();
    const client = makeClient(ha);
    const events: string[] = [];
    client.onStateChanged((e) => events.push(`${e.entityId}=${e.newState?.state ?? "gone"}`));
    await client.connect();
    ha.last.pushStateChanged("light.salon", {
      entity_id: "light.salon",
      state: "off",
      attributes: {},
    });
    expect(events).toEqual(["light.salon=off"]);
    client.close();
  });

  it("reconnects with backoff after the socket drops, then resubscribes", async () => {
    const ha = new FakeHa();
    const client = makeClient(ha);
    let ready = 0;
    client.onReady(() => ready++);
    await client.connect();
    ha.last.serverClose();
    expect(client.status.state).toBe("unreachable");
    expect(client.status.nextRetryAt).not.toBeNull();
    await vi.waitFor(() => expect(client.status.state).toBe("connected"), { timeout: 500 });
    expect(ha.sockets).toHaveLength(2);
    expect(ready).toBe(2);
    expect(ha.last.sent.some((m) => m.type === "subscribe_events")).toBe(true);
    client.close();
  });

  it("keeps retrying with growing delays while HA is down", async () => {
    const ha = new FakeHa();
    ha.refuse = true;
    const client = makeClient(ha);
    await expect(client.connect()).rejects.toThrow();
    await vi.waitFor(() => expect(ha.sockets.length).toBeGreaterThanOrEqual(3), { timeout: 500 });
    expect(client.status.attempt).toBeGreaterThanOrEqual(2);
    ha.refuse = false;
    await vi.waitFor(() => expect(client.status.state).toBe("connected"), { timeout: 500 });
    expect(client.status.attempt).toBe(0);
    client.close();
  });

  it("calls services over REST with the bearer token and validates names", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ entity_id: "light.salon", state: "on", attributes: {} }]), {
          status: 200,
        }),
      ),
    );
    const client = makeClient(new FakeHa(), { fetch: fetchMock });
    const result = await client.callService({
      domain: "light",
      service: "turn_on",
      targetEntityId: "light.salon",
      serviceData: { brightness_pct: 40 },
    });
    expect(result).toEqual({ success: true, newState: "on" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ha.local:8123/api/services/light/turn_on");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer good-token-123");
    expect(JSON.parse(init.body as string)).toEqual({
      brightness_pct: 40,
      entity_id: "light.salon",
    });
    await expect(
      client.callService({
        domain: "light/../x",
        service: "turn_on",
        targetEntityId: "light.salon",
      }),
    ).rejects.toThrow();
  });

  it("maps REST 401 to an auth error", async () => {
    const client = makeClient(new FakeHa(), {
      fetch: () => Promise.resolve(new Response("unauthorized", { status: 401 })),
    });
    await expect(client.checkConnection()).rejects.toBeInstanceOf(HomeAssistantAuthError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unified registry
// ─────────────────────────────────────────────────────────────────────────────

const ROOMS = [
  { id: "r-salon", name: "Salon", haAreaId: "living_room", sortOrder: 0 },
  { id: "r-bureau", name: "Bureau", haAreaId: "office", sortOrder: 1 },
  { id: "r-cuisine", name: "Cuisine", haAreaId: null, sortOrder: 2 },
];

describe("unified home registry", () => {
  const devices = buildHomeDevices({
    ha: SNAPSHOT,
    rooms: ROOMS,
    settings: [{ deviceId: "ha:switch.prise_radiateur", sensitive: true }],
    satellites: [
      {
        deviceId: "esp32-cuisine",
        name: "Satellite cuisine",
        online: true,
        lastSeenAt: "2026-11-09T10:00:00Z",
        health: { room: "cuisine", microphone: { status: "muted" } },
        capabilities: [{ name: "audio.microphone" }, { name: "audio.speaker" }],
        voice: { connected: true, speaker: true },
      },
    ],
    fireTv: { serial: "192.168.1.120:5555", name: "Fire TV", reachable: null },
  });
  const byId = new Map(devices.map((d) => [d.id, d]));

  it("derives capabilities, state and metering from HA entities", () => {
    const light = byId.get("ha:light.salon");
    expect(light?.capabilities).toEqual(expect.arrayContaining(["onoff", "brightness", "color"]));
    expect(light?.state.brightness).toBe(50);
    expect(light?.state.color).toBe("#ff0000");
    const plug = byId.get("ha:switch.prise_radiateur");
    expect(plug?.capabilities).toContain("power_metering");
    expect(plug?.state.powerW).toBe(1500);
    expect(byId.has("ha:sensor.temperature")).toBe(false);
    expect(byId.get("ha:media_player.tv")?.state.media?.volume).toBe(40);
  });

  it("maps HA areas (entity first, then HA device) to NEXUS rooms", () => {
    expect(byId.get("ha:light.salon")?.roomId).toBe("r-salon");
    expect(byId.get("ha:switch.prise_radiateur")?.roomId).toBe("r-bureau");
    expect(byId.get("ha:lock.porte")?.roomId).toBeNull();
    expect(byId.get("sat:esp32-cuisine")?.roomId).toBe("r-cuisine");
    expect(
      missingRoomsForAreas([...SNAPSHOT.areas, { area_id: "garage", name: "Garage" }], ROOMS),
    ).toEqual([{ area_id: "garage", name: "Garage" }]);
  });

  it("flags sensitive classes and user-flagged devices", () => {
    expect(byId.get("ha:lock.porte")?.sensitiveReason).toBe("class");
    expect(byId.get("ha:switch.prise_radiateur")?.sensitiveReason).toBe("user");
    expect(byId.get("ha:light.salon")?.sensitive).toBe(false);
  });

  it("includes satellites with mic/speaker and the Fire TV, without inventing state", () => {
    const sat = byId.get("sat:esp32-cuisine");
    expect(sat?.capabilities).toEqual(["mic", "speaker"]);
    expect(sat?.state.micMuted).toBe(true);
    expect(sat?.state.speakerConnected).toBe(true);
    const tv = byId.get("firetv:192.168.1.120:5555");
    expect(tv?.online).toBe(false);
    expect(tv?.state.raw).toBe("unknown");
  });

  it("returns no device at all when no source reports any", () => {
    expect(buildHomeDevices({ rooms: [], settings: [] })).toEqual([]);
  });

  it("applies state_changed to the cache", () => {
    const cache = new HomeAssistantStateCache();
    cache.replace(SNAPSHOT);
    cache.apply("light.salon", { entity_id: "light.salon", state: "off", attributes: {} });
    const rebuilt = buildHomeDevices({ ha: cache.snapshot(), rooms: ROOMS, settings: [] });
    expect(rebuilt.find((d) => d.id === "ha:light.salon")?.state.on).toBe(false);
  });
});

describe("home actions", () => {
  const devices = buildHomeDevices({ ha: SNAPSHOT, rooms: ROOMS, settings: [] });
  const get = (id: string) => devices.find((d) => d.id === id)!;

  it("maps light actions with brightness and colour to light.turn_on", () => {
    const action = homeActionSchema.parse({ action: "turn_on", brightness: 30, color: "#00FF00" });
    assertActionSupported(get("ha:light.salon"), action);
    expect(toHomeAssistantServiceCall(get("ha:light.salon"), action)).toEqual({
      domain: "light",
      service: "turn_on",
      targetEntityId: "light.salon",
      serviceData: { brightness_pct: 30, rgb_color: [0, 255, 0] },
    });
  });

  it("maps switch and media_player services", () => {
    expect(
      toHomeAssistantServiceCall(get("ha:switch.prise_radiateur"), { action: "turn_off" }),
    ).toMatchObject({
      domain: "switch",
      service: "turn_off",
    });
    expect(
      toHomeAssistantServiceCall(get("ha:media_player.tv"), {
        action: "media",
        command: "volume_set",
        volume: 25,
      }),
    ).toMatchObject({
      domain: "media_player",
      service: "volume_set",
      serviceData: { volume_level: 0.25 },
    });
  });

  it("rejects actions outside the device capabilities", () => {
    expect(() =>
      assertActionSupported(get("ha:switch.prise_radiateur"), {
        action: "set_brightness",
        brightness: 10,
      }),
    ).toThrow(/requires brightness/);
    expect(() => homeActionSchema.parse({ action: "turn_on", brightness: 140 })).toThrow();
    expect(() => homeActionSchema.parse({ action: "explode" })).toThrow();
  });
});

describe("routines", () => {
  const routine = (overrides: Partial<HomeRoutine>): HomeRoutine => ({
    id: "r1",
    ownerId: "u1",
    name: "Morning",
    enabled: true,
    trigger: { type: "time", cron: "30 7 * * 1-5" },
    conditions: [],
    actions: [{ type: "device", deviceId: "ha:light.salon", action: { action: "turn_on" } }],
    lastRunAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  });

  it("parses and matches cron expressions", () => {
    const spec = parseCron("*/15 22-23 * * *");
    expect(spec).not.toBeNull();
    expect(cronMatches(spec!, { minute: 45, hour: 22, day: 1, month: 1, weekday: 3 })).toBe(true);
    expect(cronMatches(spec!, { minute: 40, hour: 22, day: 1, month: 1, weekday: 3 })).toBe(false);
    expect(parseCron("61 * * * *")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
  });

  it("selects due time routines and honours conditions", () => {
    const monday = { minute: 30, hour: 7, day: 9, month: 11, weekday: 1 };
    expect(dueTimeRoutines([routine({})], monday)).toHaveLength(1);
    expect(dueTimeRoutines([routine({ enabled: false })], monday)).toHaveLength(0);
    expect(dueTimeRoutines([routine({})], { ...monday, weekday: 0 })).toHaveLength(0);
    expect(
      conditionsHold(
        [{ type: "time_between", after: "22:00", before: "06:00" }],
        { ...monday, hour: 23 },
        () => undefined,
      ),
    ).toBe(true);
    expect(
      conditionsHold([{ type: "device_state", deviceId: "x", state: "on" }], monday, () => "off"),
    ).toBe(false);
  });

  it("triggers on device state transitions", () => {
    const r = routine({
      trigger: { type: "device_state", deviceId: "ha:media_player.tv", to: "playing" },
    });
    expect(
      stateTriggeredRoutines([r], { deviceId: "ha:media_player.tv", from: "idle", to: "playing" }),
    ).toHaveLength(1);
    expect(
      stateTriggeredRoutines([r], {
        deviceId: "ha:media_player.tv",
        from: "playing",
        to: "paused",
      }),
    ).toHaveLength(0);
  });

  it("expands scenes and detects sensitive targets", () => {
    const scene: HomeScene = {
      id: "s1",
      ownerId: "u1",
      name: "Night",
      actions: [
        { deviceId: "ha:light.salon", action: { action: "turn_off" } },
        { deviceId: "ha:lock.porte", action: { action: "lock" } },
      ],
      createdAt: "",
      updatedAt: "",
    };
    const expanded = expandRoutineActions([{ type: "scene", sceneId: "s1" }], [scene]);
    expect(expanded).toHaveLength(2);
    const devices = buildHomeDevices({ ha: SNAPSHOT, rooms: ROOMS, settings: [] });
    expect(sensitiveTargets(scene.actions, devices)).toEqual(["ha:lock.porte"]);
  });
});

describe("home agent tools", () => {
  const devices = buildHomeDevices({ ha: SNAPSHOT, rooms: ROOMS, settings: [] });
  const executeAction = vi.fn(() => Promise.resolve({ status: "succeeded", message: "ok" }));
  const host: HomeToolsHost = {
    listDevices: () => Promise.resolve(devices),
    listRooms: () => Promise.resolve(ROOMS),
    cachedDevices: () => devices,
    executeAction,
    listScenes: () => Promise.resolve([]),
    cachedScenes: () => [],
    runScene: () => Promise.resolve({ status: "succeeded", message: "ok" }),
  };
  const tools = createHomeTools(host);
  const control = tools.find((t) => t.name === "home.device_control")!;
  const context = { userId: "u1" } as ToolContext;

  it("requires confirmation only for sensitive targets", () => {
    const needs = control.requiresConfirmation as (input: unknown, ctx: ToolContext) => boolean;
    expect(needs({ device: "ha:light.salon", command: { action: "turn_on" } }, context)).toBe(
      false,
    );
    expect(needs({ device: "ha:lock.porte", command: { action: "unlock" } }, context)).toBe(true);
    expect(needs({ device: "unknown thing", command: { action: "turn_on" } }, context)).toBe(true);
  });

  it("resolves a device by name and executes with confirmed=true", async () => {
    await control.execute(
      { device: "lampe salon", command: { action: "turn_off" } } as never,
      context,
    );
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "ha:light.salon", confirmed: true, origin: "agent" }),
    );
  });
});
