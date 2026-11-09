import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@nexus/database";
import { parseConfig } from "@nexus/config";
import { SCRYPT_FAST } from "@nexus/auth";
import { HomeAssistantClient } from "@nexus/devices";
import { buildApp, type NexusApp } from "../src/app.js";
import { ServiceContainer } from "../src/services/container.js";
import { SatelliteService } from "../src/services/satellite-service.js";
import { createAccount, signingKeys, type Account } from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mocked Home Assistant: real HTTP + WebSocket server on a random port
// ─────────────────────────────────────────────────────────────────────────────

const HA_TOKEN = "ha-long-lived-token-for-tests-0123456789";

interface HaStateObj {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
}

class MockHomeAssistant {
  readonly calls: {
    domain: string;
    service: string;
    body: Record<string, unknown>;
    auth: string | undefined;
  }[] = [];
  readonly authAttempts: string[] = [];
  readonly states = new Map<string, HaStateObj>([
    [
      "light.salon",
      {
        entity_id: "light.salon",
        state: "off",
        attributes: { friendly_name: "Lampe salon", supported_color_modes: ["hs"] },
      },
    ],
    [
      "switch.prise_bureau",
      {
        entity_id: "switch.prise_bureau",
        state: "off",
        attributes: { friendly_name: "Prise bureau" },
      },
    ],
    [
      "sensor.prise_bureau_power",
      {
        entity_id: "sensor.prise_bureau_power",
        state: "42.5",
        attributes: { device_class: "power", unit_of_measurement: "W" },
      },
    ],
    [
      "lock.porte_entree",
      {
        entity_id: "lock.porte_entree",
        state: "locked",
        attributes: { friendly_name: "Porte d'entrée" },
      },
    ],
    [
      "media_player.salon_tv",
      {
        entity_id: "media_player.salon_tv",
        state: "idle",
        attributes: { friendly_name: "TV salon" },
      },
    ],
  ]);
  readonly areas = [
    { area_id: "salon", name: "Salon" },
    { area_id: "bureau", name: "Bureau" },
  ];
  readonly devices = [
    { id: "plug1", name: "Plug", area_id: "bureau", manufacturer: "Shelly", model: "Plug S" },
  ];
  readonly entities = [
    { entity_id: "light.salon", device_id: null, area_id: "salon" },
    { entity_id: "media_player.salon_tv", device_id: null, area_id: "salon" },
    { entity_id: "switch.prise_bureau", device_id: "plug1", area_id: null },
    { entity_id: "sensor.prise_bureau_power", device_id: "plug1", area_id: null },
  ];
  readonly sockets = new Set<WebSocket>();
  connections = 0;
  server!: Server;
  wss!: WebSocketServer;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.#rest(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: "/api/websocket" });
    this.wss.on("connection", (socket) => this.#socket(socket));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  dropAll(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  setState(entityId: string, state: string): void {
    const previous = this.states.get(entityId);
    const next = { ...(previous ?? { entity_id: entityId, attributes: {} }), state };
    this.states.set(entityId, next);
    const event = JSON.stringify({
      id: 1,
      type: "event",
      event: {
        event_type: "state_changed",
        data: { entity_id: entityId, old_state: previous ?? null, new_state: next },
      },
    });
    for (const socket of this.sockets) socket.send(event);
  }

  async #rest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${HA_TOKEN}`) {
      res.writeHead(401).end("401: Unauthorized");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body =
      chunks.length === 0
        ? {}
        : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/config") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ version: "2026.11.1", location_name: "Maison" }));
      return;
    }
    const service = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(url);
    if (req.method === "POST" && service) {
      const [, domain, name] = service as unknown as [string, string, string];
      this.calls.push({ domain, service: name, body, auth });
      const entityId = String(body.entity_id);
      const nextState =
        name === "turn_on"
          ? "on"
          : name === "turn_off"
            ? "off"
            : name === "unlock"
              ? "unlocked"
              : name === "lock"
                ? "locked"
                : undefined;
      if (nextState !== undefined) this.setState(entityId, nextState);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(nextState === undefined ? [] : [this.states.get(entityId)]));
      return;
    }
    res.writeHead(404).end();
  }

  #socket(socket: WebSocket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.1" }));
    socket.on("message", (raw) => {
      const msg = JSON.parse((raw as Buffer).toString("utf8")) as Record<string, unknown>;
      if (msg.type === "auth") {
        this.authAttempts.push(String(msg.access_token));
        socket.send(
          JSON.stringify(
            msg.access_token === HA_TOKEN
              ? { type: "auth_ok", ha_version: "2026.11.1" }
              : { type: "auth_invalid", message: "Invalid access token or password" },
          ),
        );
        return;
      }
      const results: Record<string, unknown> = {
        subscribe_events: null,
        get_states: [...this.states.values()],
        "config/area_registry/list": this.areas,
        "config/device_registry/list": this.devices,
        "config/entity_registry/list": this.entities,
      };
      if (msg.type === "ping") {
        socket.send(JSON.stringify({ id: msg.id, type: "pong" }));
        return;
      }
      socket.send(
        JSON.stringify({
          id: msg.id,
          type: "result",
          success: true,
          result: results[String(msg.type)] ?? null,
        }),
      );
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXUS under test
// ─────────────────────────────────────────────────────────────────────────────

const SAT_ID = "esp32-salon";
const SAT_TOKEN = "satellite-device-token-xyz";

const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nexus:pwd@localhost:5432/nexus_test",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SIGNING_KEY: signingKeys.privateKeyPem,
});

let ha: MockHomeAssistant;
let app: NexusApp;
let services: ServiceContainer;
let account: Account;
let wsUrl: string;
const owners: Record<string, string> = {};
const stt = { transcribe: vi.fn(() => Promise.resolve("allume la lumière du salon")) };
const tts = {
  synthesize: vi.fn(() => Promise.resolve({ pcm: new Uint8Array(22_050 * 2), sampleRate: 22_050 })),
};

type Json = Record<string, unknown>;
const data = (response: { json: () => unknown }) => (response.json() as { data: Json }).data;

async function inject(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: account.authorization,
    ...(payload === undefined ? {} : { payload: payload as Json }),
  });
}

async function devices(): Promise<Json[]> {
  return data(await inject("GET", "/api/v1/domotique/devices")).devices as Json[];
}

async function haState(): Promise<string> {
  const status = data(await inject("GET", "/api/v1/domotique/home-assistant"));
  return (status.connection as Json).state as string;
}

beforeAll(async () => {
  ha = new MockHomeAssistant();
  await ha.start();
  services = new ServiceContainer({
    tokenPrivateKeyPem: signingKeys.privateKeyPem,
    passwordParams: SCRYPT_FAST,
    domotiqueTickMs: 0,
    homeTimezone: "UTC",
    homeAssistantClientFactory: ({ baseUrl, token }) =>
      new HomeAssistantClient({
        baseUrl,
        token,
        backoff: { initialMs: 20, maxMs: 100 },
        keepaliveMs: 0,
      }),
    satelliteVoicePorts: { stt, tts },
  });
  app = await buildApp({
    config,
    logger: pino({ level: "silent" }),
    prisma: { $queryRaw: vi.fn(), $disconnect: vi.fn() } as unknown as PrismaClient,
    redis: { ping: vi.fn(), quit: vi.fn(), connect: vi.fn() } as unknown as Redis,
    rateLimitStore: "memory",
    services,
    websocketHandshakeTimeoutMs: 500,
    satellites: new SatelliteService(
      { [SAT_ID]: createHash("sha256").update(SAT_TOKEN).digest("hex") },
      Date.now,
      owners,
    ),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  wsUrl = `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
  account = await createAccount({
    app,
    services,
    credentials: undefined as never,
    close: () => app.close(),
  });
  owners[SAT_ID] = account.userId;
});

afterAll(async () => {
  await app.close();
  await ha.stop();
});

describe("Lab 4 — Home Assistant bridge", () => {
  it("reports 'not configured' and lists no invented devices before setup", async () => {
    expect(await haState()).toBe("not_configured");
    expect(
      (await devices()).filter((d) => d.kind === "home_assistant" || d.source === "home_assistant"),
    ).toEqual([]);
    const topology = data(await inject("GET", "/api/v1/devices/topology"));
    expect(topology.rooms).toEqual([]);
    expect((topology.summary as Json).homeAssistant).toBe("not_configured");
  });

  it("rejects a bad token (auth failure) without storing it", async () => {
    const response = await inject("POST", "/api/v1/domotique/home-assistant", {
      baseUrl: ha.url,
      token: "definitely-not-the-right-token",
    });
    expect(response.statusCode).toBe(401);
    expect(await haState()).toBe("not_configured");
  });

  it("connects with a valid token, syncs entities and maps HA areas to rooms", async () => {
    const response = await inject("POST", "/api/v1/domotique/home-assistant", {
      baseUrl: `${ha.url}/`,
      token: HA_TOKEN,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(HA_TOKEN);
    await vi.waitFor(async () => expect(await haState()).toBe("connected"), { timeout: 2_000 });
    await vi.waitFor(async () => expect((await devices()).length).toBeGreaterThanOrEqual(4), {
      timeout: 2_000,
    });

    const status = data(await inject("GET", "/api/v1/domotique/home-assistant"));
    expect(JSON.stringify(status)).not.toContain(HA_TOKEN);
    expect(status.token).toEqual({ stored: true, persistence: "memory" });
    expect((status.connection as Json).haVersion).toBe("2026.11.1");

    const list = await devices();
    const plug = list.find((d) => d.id === "ha:switch.prise_bureau")!;
    expect((plug.state as Json).powerW).toBe(42.5);
    expect(plug.capabilities).toContain("power_metering");
    const rooms = data(await inject("GET", "/api/v1/domotique/rooms")) as unknown as Json[];
    expect(rooms.map((r) => r.name).sort()).toEqual(["Bureau", "Salon"]);
    const salon = rooms.find((r) => r.name === "Salon")!;
    expect(list.find((d) => d.id === "ha:light.salon")!.roomId).toBe(salon.id);

    const topology = data(await inject("GET", "/api/v1/devices/topology"));
    expect((topology.rooms as Json[]).map((r) => r.name)).toEqual(
      expect.arrayContaining(["Salon", "Bureau"]),
    );
  });

  it("updates the registry on state_changed events", async () => {
    ha.setState("switch.prise_bureau", "on");
    await vi.waitFor(async () => {
      const plug = (await devices()).find((d) => d.id === "ha:switch.prise_bureau")!;
      expect((plug.state as Json).raw).toBe("on");
    });
  });

  it("calls HA services with validated, capability-checked actions", async () => {
    const response = await inject(
      "POST",
      `/api/v1/devices/${encodeURIComponent("ha:light.salon")}/actions`,
      {
        action: "turn_on",
        brightness: 40,
        color: "#FF8000",
      },
    );
    expect(response.statusCode).toBe(200);
    expect(data(response).status).toBe("succeeded");
    const call = ha.calls.at(-1);
    expect(call).toMatchObject({ domain: "light", service: "turn_on", auth: `Bearer ${HA_TOKEN}` });
    expect(call?.body).toEqual({
      entity_id: "light.salon",
      brightness_pct: 40,
      rgb_color: [255, 128, 0],
    });

    const invalid = await inject(
      "POST",
      `/api/v1/devices/${encodeURIComponent("ha:switch.prise_bureau")}/actions`,
      {
        action: "set_color",
        color: "#00ff00",
      },
    );
    expect(invalid.statusCode).toBe(422);
    const malformed = await inject(
      "POST",
      `/api/v1/devices/${encodeURIComponent("ha:light.salon")}/actions`,
      {
        action: "turn_on",
        brightness: 400,
      },
    );
    expect(malformed.statusCode).toBe(400);
  });

  it("reconnects with backoff after Home Assistant drops the socket", async () => {
    const before = ha.connections;
    ha.dropAll();
    await vi.waitFor(() => expect(ha.connections).toBeGreaterThan(before), { timeout: 2_000 });
    await vi.waitFor(async () => expect(await haState()).toBe("connected"), { timeout: 2_000 });
    expect(ha.authAttempts.at(-1)).toBe(HA_TOKEN);
  });

  it("requires confirmation for a sensitive device and executes only after approval", async () => {
    const callsBefore = ha.calls.length;
    const response = await inject(
      "POST",
      `/api/v1/devices/${encodeURIComponent("ha:lock.porte_entree")}/actions`,
      {
        action: "unlock",
      },
    );
    expect(response.statusCode).toBe(202);
    const outcome = data(response);
    expect(outcome.status).toBe("pending_confirmation");
    expect(ha.calls.length).toBe(callsBefore);

    const pending = data(
      await inject("GET", "/api/v1/confirmations?status=pending"),
    ) as unknown as Json[];
    expect(pending.some((c) => c.id === outcome.confirmationId)).toBe(true);

    const approved = await inject(
      "POST",
      `/api/v1/confirmations/${String(outcome.confirmationId)}/respond`,
      {
        decision: "approved",
      },
    );
    expect(data(approved).accepted).toBe(true);
    await vi.waitFor(() =>
      expect(ha.calls.at(-1)).toMatchObject({ domain: "lock", service: "unlock" }),
    );
  });

  it("lets the user flag a high-power plug as sensitive", async () => {
    const flagged = await inject(
      "PATCH",
      `/api/v1/domotique/devices/${encodeURIComponent("ha:switch.prise_bureau")}`,
      {
        sensitive: true,
      },
    );
    expect(flagged.statusCode).toBe(200);
    const response = await inject(
      "POST",
      `/api/v1/devices/${encodeURIComponent("ha:switch.prise_bureau")}/actions`,
      {
        action: "turn_off",
      },
    );
    expect(response.statusCode).toBe(202);
    await inject(
      "PATCH",
      `/api/v1/domotique/devices/${encodeURIComponent("ha:switch.prise_bureau")}`,
      { sensitive: null },
    );
  });

  it("executes scenes and records them in the execution log", async () => {
    const created = await inject("POST", "/api/v1/domotique/scenes", {
      name: "Soirée",
      actions: [
        { deviceId: "ha:light.salon", action: { action: "set_brightness", brightness: 20 } },
        { deviceId: "ha:switch.prise_bureau", action: { action: "turn_off" } },
      ],
    });
    expect(created.statusCode).toBe(200);
    const scene = data(created);
    const callsBefore = ha.calls.length;
    const run = await inject("POST", `/api/v1/domotique/scenes/${String(scene.id)}/run`);
    expect(run.statusCode).toBe(200);
    expect(data(run).status).toBe("succeeded");
    expect(ha.calls.slice(callsBefore).map((c) => `${c.domain}.${c.service}`)).toEqual([
      "light.turn_on",
      "switch.turn_off",
    ]);
    const logs = data(await inject("GET", "/api/v1/domotique/logs")) as unknown as Json[];
    expect(
      logs.some((l) => l.kind === "scene" && l.refId === scene.id && l.status === "succeeded"),
    ).toBe(true);
  });

  it("triggers routines on device state changes and on schedule", async () => {
    const stateRoutine = await inject("POST", "/api/v1/domotique/routines", {
      name: "TV allumée",
      trigger: { type: "device_state", deviceId: "ha:media_player.salon_tv", to: "playing" },
      actions: [
        {
          type: "device",
          deviceId: "ha:light.salon",
          action: { action: "set_brightness", brightness: 10 },
        },
      ],
    });
    expect(stateRoutine.statusCode).toBe(200);
    const callsBefore = ha.calls.length;
    ha.setState("media_player.salon_tv", "playing");
    await vi.waitFor(() =>
      expect(ha.calls.slice(callsBefore)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            service: "turn_on",
            body: expect.objectContaining({ brightness_pct: 10 }),
          }),
        ]),
      ),
    );

    await inject("POST", "/api/v1/domotique/routines", {
      name: "Extinction 23h",
      trigger: { type: "time", cron: "0 23 * * *" },
      actions: [{ type: "device", deviceId: "ha:light.salon", action: { action: "turn_off" } }],
    });
    const fired = await services.domotique.tick(new Date("2026-11-09T23:00:10Z"));
    expect(fired).toBe(1);
    expect(ha.calls.at(-1)).toMatchObject({ domain: "light", service: "turn_off" });
    expect(await services.domotique.tick(new Date("2026-11-09T23:00:40Z"))).toBe(0);

    const bad = await inject("POST", "/api/v1/domotique/routines", {
      name: "bad",
      trigger: { type: "time", cron: "99 * * * *" },
      actions: [{ type: "device", deviceId: "ha:light.salon", action: { action: "turn_off" } }],
    });
    expect(bad.statusCode).toBe(400);
  });

  it("registers home agent tools", () => {
    const names = services.toolRegistry.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["home.devices_list", "home.device_control", "home.scene_run"]),
    );
  });
});

describe("Lab 4 — ESP32 voice satellite", () => {
  it("rejects a satellite with a wrong token", async () => {
    const socket = new WebSocket(`${wsUrl}/ws/satellite`);
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(
      JSON.stringify({ v: 1, type: "hello", deviceId: SAT_ID, token: "wrong-token-123" }),
    );
    expect(await closed).toBe(4401);
  });

  it("routes wake → mic audio → STT → home intent → TTS back to that satellite's speaker", async () => {
    const socket = new WebSocket(`${wsUrl}/ws/satellite`);
    const frames: Json[] = [];
    const audio: Buffer[] = [];
    socket.on("message", (raw, isBinary) => {
      if (isBinary) audio.push(raw as Buffer);
      else frames.push(JSON.parse((raw as Buffer).toString("utf8")) as Json);
    });
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(
      JSON.stringify({
        v: 1,
        type: "hello",
        deviceId: SAT_ID,
        token: SAT_TOKEN,
        firmware: "1.2.0",
        audio: {
          mic: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
          speaker: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
        },
      }),
    );
    await vi.waitFor(() => expect(frames.some((f) => f.type === "ready")).toBe(true));
    expect(frames.find((f) => f.type === "ready")).toMatchObject({ stt: true, tts: true });

    const callsBefore = ha.calls.length;
    socket.send(JSON.stringify({ v: 1, type: "wake", wakeWord: "nexus" }));
    await vi.waitFor(() => expect(frames.some((f) => f.type === "listening")).toBe(true));
    for (let i = 0; i < 5; i += 1) socket.send(Buffer.alloc(3_200, 1), { binary: true });
    socket.send(JSON.stringify({ v: 1, type: "audio.end" }));

    await vi.waitFor(() => expect(frames.some((f) => f.type === "tts.end")).toBe(true), {
      timeout: 3_000,
    });
    expect(stt.transcribe).toHaveBeenCalledTimes(1);
    expect(frames.find((f) => f.type === "transcript")?.text).toBe("allume la lumière du salon");
    expect(String(frames.find((f) => f.type === "reply")?.text)).toContain("Lampe salon");
    expect(frames.find((f) => f.type === "tts.start")).toMatchObject({
      sampleRate: 16_000,
      encoding: "pcm_s16le",
      bytes: 32_000,
    });
    expect(audio.reduce((n, c) => n + c.byteLength, 0)).toBe(32_000);
    expect(ha.calls.slice(callsBefore)).toEqual([
      expect.objectContaining({ domain: "light", service: "turn_on" }),
    ]);

    const voice = data(await inject("GET", "/api/v1/domotique/voice"));
    expect((voice.satellites as Json[])[0]).toMatchObject({
      deviceId: SAT_ID,
      connected: true,
      speaker: true,
      turns: 1,
    });

    socket.close();
  });
});
