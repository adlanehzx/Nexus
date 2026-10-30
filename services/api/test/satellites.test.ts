import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type ApiHarness } from "./harness.js";
import { SatelliteService } from "../src/services/satellite-service.js";

const TOKEN = "test-device-token";
const DEVICE_ID = "nexus-satellite-01";
const hash = createHash("sha256").update(TOKEN).digest("hex");

describe("ESP32 satellite gateway", () => {
  let api: ApiHarness;
  let satellites: SatelliteService;

  beforeEach(async () => {
    satellites = new SatelliteService({ [DEVICE_ID]: hash });
    api = await makeApi({ satellites });
  });

  afterEach(async () => api.close());

  const heartbeat = {
    v: 1 as const,
    deviceId: DEVICE_ID,
    name: "studio",
    health: { uptimeMs: 10_000 },
    capabilities: [{ name: "infrared.transmit", operational: false }],
  };

  it("authenticates a heartbeat without retaining the raw token", async () => {
    const unauthorized = await api.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${DEVICE_ID}/heartbeat`,
      payload: heartbeat,
      headers: { authorization: "Bearer wrong" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const accepted = await api.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${DEVICE_ID}/heartbeat`,
      payload: heartbeat,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(satellites.list()[0]?.online).toBe(true);
  });

  it("isolates queues and returns correlated command results", async () => {
    const account = await createAccount(api);
    const queued = await api.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${DEVICE_ID}/commands`,
      headers: account.authorization,
      payload: { command: "system.ping", params: {} },
    });
    expect(queued.statusCode).toBe(202);

    const next = await api.app.inject({
      method: "GET",
      url: `/api/v1/satellites/${DEVICE_ID}/commands/next`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(next.statusCode).toBe(200);
    const command = next.json<{ correlationId: string; command: string }>();
    expect(command.command).toBe("system.ping");

    const empty = await api.app.inject({
      method: "GET",
      url: `/api/v1/satellites/${DEVICE_ID}/commands/next`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(empty.statusCode).toBe(204);

    const result = await api.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${DEVICE_ID}/commands/result`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        v: 1,
        type: "command.result",
        correlationId: command.correlationId,
        ok: true,
        status: 0,
      },
    });
    expect(result.statusCode).toBe(202);
    expect(satellites.result(command.correlationId)?.ok).toBe(true);
  });

  it("rejects non-allowlisted commands", async () => {
    const account = await createAccount(api);
    const response = await api.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${DEVICE_ID}/commands`,
      headers: account.authorization,
      payload: { command: "shell.exec", params: { command: "bad" } },
    });
    expect(response.statusCode).toBe(400);
  });
});
