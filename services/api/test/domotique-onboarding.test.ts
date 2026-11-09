import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@nexus/database";
import { parseConfig } from "@nexus/config";
import { SCRYPT_FAST } from "@nexus/auth";
import { HomeAssistantClient } from "@nexus/devices";
import { buildApp, type NexusApp } from "../src/app.js";
import { ServiceContainer } from "../src/services/container.js";
import { SatelliteService } from "../src/services/satellite-service.js";
import { satelliteVerificationCode } from "../src/services/domotique/satellite-enrollment.js";
import { createAccount, signingKeys, type Account } from "./harness.js";

/**
 * Generic installation: nobody configured anything by hand. A fresh Home
 * Assistant sits on the LAN, an ESP32 nobody declared shows up, a TV is added
 * from the dashboard. NEXUS must handle all of it on its own.
 */

class FreshHomeAssistant {
  onboarded = false;
  owner: { username: string; password: string } | null = null;
  readonly issued = new Set<string>();
  server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.#rest(req, res));
    const wss = new WebSocketServer({ server: this.server, path: "/api/websocket" });
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "auth_required" }));
      socket.on("message", (raw) => {
        const msg = JSON.parse((raw as Buffer).toString("utf8")) as Record<string, unknown>;
        const reply = (body: Record<string, unknown>) => socket.send(JSON.stringify(body));
        if (msg.type === "auth") {
          reply({
            type: this.issued.has(String(msg.access_token)) ? "auth_ok" : "auth_invalid",
            ha_version: "2026.11.1",
          });
        } else if (msg.type === "auth/long_lived_access_token") {
          const token = `ll-${String(this.issued.size)}-${"x".repeat(20)}`;
          this.issued.add(token);
          reply({ id: msg.id, type: "result", success: true, result: token });
        } else if (msg.type === "config_entries/flow/progress") {
          reply({
            id: msg.id,
            type: "result",
            success: true,
            result: [
              {
                flow_id: "abcdef0123456789",
                handler: "cast",
                context: { source: "zeroconf", title_placeholders: { name: "Salon TV" } },
              },
            ],
          });
        } else {
          const lists = [
            "get_states",
            "config/area_registry/list",
            "config/device_registry/list",
            "config/entity_registry/list",
          ];
          reply({
            id: msg.id,
            type: "result",
            success: true,
            result: lists.includes(String(msg.type)) ? [] : null,
          });
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  async #rest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const bearer = req.headers.authorization?.replace("Bearer ", "") ?? "";
    const route = `${req.method ?? "GET"} ${req.url ?? ""}`;
    if (route === "GET /api/onboarding") {
      json(
        200,
        ["user", "core_config", "analytics", "integration"].map((step) => ({
          step,
          done: this.onboarded,
        })),
      );
    } else if (route === "POST /api/onboarding/users") {
      if (this.onboarded) return json(403, { message: "User step already done" });
      const body = JSON.parse(raw) as { username: string; password: string };
      this.owner = { username: body.username, password: body.password };
      this.onboarded = true;
      json(200, { auth_code: "code-onboard" });
    } else if (route === "POST /auth/token") {
      const form = new URLSearchParams(raw);
      if (form.get("code") !== "code-onboard" && form.get("code") !== "code-login")
        return json(400, {});
      this.issued.add("access-short");
      json(200, { access_token: "access-short", token_type: "Bearer", expires_in: 1800 });
    } else if (route.startsWith("POST /api/onboarding/")) {
      json(this.issued.has(bearer) ? 200 : 401, {});
    } else if (route === "POST /auth/login_flow") {
      json(200, { flow_id: "flow1", type: "form", step_id: "init" });
    } else if (route === "POST /auth/login_flow/flow1") {
      const body = JSON.parse(raw) as { username: string; password: string };
      const okLogin =
        this.owner?.username === body.username && this.owner.password === body.password;
      json(
        200,
        okLogin
          ? { type: "create_entry", result: "code-login" }
          : { type: "form", step_id: "init", errors: { base: "invalid_auth" } },
      );
    } else if (route === "GET /api/config") {
      if (!this.issued.has(bearer)) return json(401, {});
      json(200, {
        version: "2026.11.1",
        location_name: "Home",
        time_zone: "America/New_York",
        language: "en",
      });
    } else {
      json(404, {});
    }
  }
}

const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nexus:pwd@localhost:5432/nexus_test",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SIGNING_KEY: signingKeys.privateKeyPem,
});

let ha: FreshHomeAssistant;
let app: NexusApp;
let services: ServiceContainer;
let account: Account;
let other: Account;
const adbCalls: string[] = [];

type Json = Record<string, unknown>;
const data = (response: { json: () => unknown }) => (response.json() as { data: Json }).data;
const as =
  (who: Account) => (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: who.authorization,
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });

beforeAll(async () => {
  ha = new FreshHomeAssistant();
  await ha.start();
  services = new ServiceContainer({
    tokenPrivateKeyPem: signingKeys.privateKeyPem,
    passwordParams: SCRYPT_FAST,
    domotiqueTickMs: 0,
    homeAssistantClientFactory: ({ baseUrl, token }) =>
      new HomeAssistantClient({
        baseUrl,
        token,
        backoff: { initialMs: 20, maxMs: 100 },
        keepaliveMs: 0,
      }),
    homeAssistantDiscovery: { browse: () => Promise.resolve([]), candidates: [ha.url] },
  });
  app = await buildApp({
    config,
    logger: pino({ level: "silent" }),
    prisma: { $queryRaw: vi.fn(), $disconnect: vi.fn() } as unknown as PrismaClient,
    redis: { ping: vi.fn(), quit: vi.fn(), connect: vi.fn() } as unknown as Redis,
    rateLimitStore: "memory",
    services,
    websocket: false,
    satellites: new SatelliteService({}, Date.now, {}),
  });
  services.domotique.attachAdb({
    controlFor: (serial) => ({
      control: (action) => {
        adbCalls.push(`${serial}:${action}`);
        return Promise.resolve();
      },
    }),
  });
  await app.ready();
  const harness = { app, services, credentials: undefined as never, close: () => app.close() };
  account = await createAccount(harness);
  other = await createAccount(harness, "sam@example.test");
});

afterAll(async () => {
  await app.close();
  await ha.stop();
});

describe("Home Assistant: found and set up without copying a token", () => {
  it("discovers a fresh Home Assistant on the network", async () => {
    const found = data(await as(account)("GET", "/api/v1/domotique/home-assistant/discover"));
    expect(found.instances).toEqual([
      expect.objectContaining({ url: ha.url, isHomeAssistant: true, onboarded: false }),
    ]);
  });

  it("onboards it in one click, connects, and adopts its timezone", async () => {
    const response = await as(account)("POST", "/api/v1/domotique/home-assistant/auto-setup", {
      baseUrl: ha.url,
    });
    expect(response.statusCode).toBe(200);
    const result = data(response);
    const credentials = result.credentials as { username: string; password: string };
    expect(credentials.username).toBe("nexus");
    expect(credentials.password.length).toBeGreaterThanOrEqual(20);
    expect(ha.owner).toEqual(credentials);
    expect(JSON.stringify(result.status)).not.toMatch(/ll-\d/);

    await vi.waitFor(async () => {
      const status = data(await as(account)("GET", "/api/v1/domotique/home-assistant"));
      expect((status.connection as Json).state).toBe("connected");
    });
    await vi.waitFor(async () =>
      expect(await services.domotique.timezone(account.userId)).toBe("America/New_York"),
    );
  });

  it("refuses a second onboarding and lets another account sign in with HA credentials instead", async () => {
    const again = await as(other)("POST", "/api/v1/domotique/home-assistant/auto-setup", {
      baseUrl: ha.url,
    });
    expect(again.statusCode).toBe(409);
    const bad = await as(other)("POST", "/api/v1/domotique/home-assistant/login", {
      baseUrl: ha.url,
      username: ha.owner?.username,
      password: "wrong-password",
    });
    expect(bad.statusCode).toBe(401);
    const good = await as(other)("POST", "/api/v1/domotique/home-assistant/login", {
      baseUrl: ha.url,
      username: ha.owner?.username,
      password: ha.owner?.password,
    });
    expect(good.statusCode).toBe(200);
    expect(data(good).configured).toBe(true);
  });

  it("lists what Home Assistant discovered on the LAN", async () => {
    const response = await as(account)("GET", "/api/v1/domotique/home-assistant/discovered");
    expect(data(response).integrations).toEqual([
      { flowId: "abcdef0123456789", domain: "cast", source: "zeroconf", title: "Salon TV" },
    ]);
  });
});

describe("ESP32 satellites: enrolled from the network, approved in the dashboard", () => {
  const secret = "s".repeat(10) + "ecret-generated-on-the-device-0123";
  const code = satelliteVerificationCode(secret);

  it("refuses enrolment from outside the private network", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/enroll",
      remoteAddress: "8.8.8.8",
      payload: { v: 1, deviceId: "esp32-kitchen", name: "Kitchen", enrollSecret: secret },
    });
    expect(response.statusCode).toBe(403);
  });

  it("announces, waits for approval with the device code, then delivers the token once", async () => {
    const announce = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/enroll",
      payload: {
        v: 1,
        deviceId: "esp32-kitchen",
        name: "ESP32",
        enrollSecret: secret,
        firmware: "1.0.0",
        capabilities: [{ name: "audio.microphone" }, { name: "audio.speaker" }],
      },
    });
    expect(announce.statusCode).toBe(202);
    expect(announce.json()).toMatchObject({ status: "pending", verificationCode: code });

    const list = data(await as(account)("GET", "/api/v1/satellites/enrollments"));
    expect(list.pending).toEqual([expect.objectContaining({ deviceId: "esp32-kitchen" })]);
    expect(JSON.stringify(list)).not.toContain(code);

    const wrong = await as(account)(
      "POST",
      "/api/v1/satellites/enrollments/esp32-kitchen/approve",
      {
        verificationCode: code === "000000" ? "111111" : "000000",
      },
    );
    expect(wrong.statusCode).toBe(400);
    const approved = await as(account)(
      "POST",
      "/api/v1/satellites/enrollments/esp32-kitchen/approve",
      {
        verificationCode: code,
        name: "Satellite cuisine",
      },
    );
    expect(approved.statusCode).toBe(200);

    const stolen = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/enroll/status",
      payload: { v: 1, deviceId: "esp32-kitchen", enrollSecret: "a".repeat(40) },
    });
    expect(stolen.statusCode).toBe(404);

    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/enroll/status",
      payload: { v: 1, deviceId: "esp32-kitchen", enrollSecret: secret },
    });
    const token = poll.json<{ token?: string }>().token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/enroll/status",
      payload: { v: 1, deviceId: "esp32-kitchen", enrollSecret: secret },
    });
    expect(second.json()).toMatchObject({ status: "enrolled" });
    expect(JSON.stringify(second.json())).not.toContain(String(token));

    const heartbeat = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/esp32-kitchen/heartbeat",
      headers: { authorization: `Bearer ${String(token)}` },
      payload: {
        v: 1,
        deviceId: "esp32-kitchen",
        name: "ESP32",
        health: {},
        capabilities: [{ name: "audio.speaker" }],
      },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(app.satellites.ownerOf("esp32-kitchen")).toBe(account.userId);
    expect(createHash("sha256").update(String(token)).digest("hex")).toBe(
      services.satelliteEnrollment.tokenHash("esp32-kitchen"),
    );

    const devices = data(await as(account)("GET", "/api/v1/domotique/devices")).devices as Json[];
    expect(devices.find((d) => d.id === "sat:esp32-kitchen")).toMatchObject({
      name: "Satellite cuisine",
      online: true,
    });
    // Another account sees nothing of it.
    const theirs = data(await as(other)("GET", "/api/v1/domotique/devices")).devices as Json[];
    expect(theirs.some((d) => d.id === "sat:esp32-kitchen")).toBe(false);
  });

  it("does not let a second device take over an enrolled id, and revokes on removal", async () => {
    const takeover = await app.inject({
      method: "POST",
      url: "/api/v1/satellites/enroll",
      payload: { v: 1, deviceId: "esp32-kitchen", name: "Evil", enrollSecret: "e".repeat(40) },
    });
    expect(takeover.statusCode).toBe(409);
    expect((await as(account)("DELETE", "/api/v1/satellites/esp32-kitchen")).statusCode).toBe(200);
    expect(app.satellites.ownerOf("esp32-kitchen")).toBeUndefined();
  });
});

describe("TVs: added per account, no built-in address", () => {
  it("has no TV until one is added, and only targets the account's own TVs", async () => {
    const none = await as(account)("POST", "/api/v1/devices/fire-tv/remote", { action: "home" });
    expect(data(none).delivered).toBe(false);
    expect(adbCalls).toEqual([]);

    await as(account)("POST", "/api/v1/domotique/tvs", {
      serial: "10.1.2.3:5555",
      name: "TV salon",
    });
    const sent = await as(account)("POST", "/api/v1/devices/fire-tv/remote", { action: "home" });
    expect(data(sent).delivered).toBe(true);
    expect(adbCalls).toEqual(["10.1.2.3:5555:home"]);

    const foreign = await as(other)("POST", "/api/v1/devices/fire-tv/remote", {
      action: "home",
      serial: "10.1.2.3:5555",
    });
    expect(data(foreign).delivered).toBe(false);
    expect(adbCalls).toHaveLength(1);

    const devices = data(await as(account)("GET", "/api/v1/domotique/devices")).devices as Json[];
    expect(devices.find((d) => d.id === "firetv:10.1.2.3:5555")).toMatchObject({
      name: "TV salon",
    });
  });
});
