import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePairingPayload } from "@nexus/devices";
import { makeApi, type ApiHarness } from "./harness.js";

/**
 * QR device pairing as seen from the API.
 *
 * Verifies the asymmetry of both routes: issuing a ticket requires an authenticated user,
 * consuming it only requires the ticket.
 */

const PASSWORD = "VeryStrongPassword!42";
const API_URL = "http://192.168.1.20:3000";

async function register(harness: ApiHarness, email: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, displayName: "Alex", password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

async function issueTicket(harness: ApiHarness, token: string) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/devices/pairing-tickets",
    headers: { authorization: `Bearer ${token}` },
    payload: { label: "Phone" },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{
    data: { id: string; token: string; payload: string; expiresAt: string };
  }>().data;
}

const PHONE = {
  name: "Pixel",
  type: "ANDROID" as const,
  platform: "ANDROID" as const,
  role: "WORKER" as const,
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCo=\n-----END PUBLIC KEY-----\n",
};

describe("QR device pairing", () => {
  let harness: ApiHarness;
  let accessToken: string;

  beforeEach(async () => {
    harness = await makeApi({ publicApiUrl: API_URL });
    accessToken = await register(harness, "alex@example.test");
  });

  afterEach(async () => {
    await harness.close();
  });

  it("issues a ticket whose payload is a usable pairing QR", async () => {
    const ticket = await issueTicket(harness, accessToken);

    const payload = decodePairingPayload(ticket.payload);
    expect(payload.apiUrl).toBe(API_URL);
    expect(payload.token).toBe(ticket.token);
    expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("requires a user to issue, but nothing to pair", async () => {
    const anonymous = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pairing-tickets",
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);

    const ticket = await issueTicket(harness, accessToken);
    const paired = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });
    expect(paired.statusCode).toBe(201);
  });

  it("attaches device to ticket owner and arrives unapproved", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const paired = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });

    const device = paired.json<{ data: { id: string; trust: string; status: string } }>().data;
    expect(device.trust).toBe("PENDING");
    expect(device.status).toBe("OFFLINE");

    // The device appears for its owner and nowhere else
    const mine = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mine.json<{ data: { id: string }[] }>().data.map((item) => item.id)).toContain(
      device.id,
    );
  });

  it("does not let bearer choose owner", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const otherToken = await register(harness, "thirdparty@example.com");

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { token: ticket.token, ...PHONE },
    });

    const theirs = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(theirs.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it("rejects a second use of the same code", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });
    expect(first.statusCode).toBe(201);

    const second = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE, name: "Pixel bis" },
    });
    expect(second.statusCode).toBe(401);

    // And crucially: no second device was created
    const mine = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mine.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it("rejects an invented code", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: "x".repeat(43), ...PHONE },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects worker without public key, valid ticket or not", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: {
        token: ticket.token,
        name: "Pixel",
        type: "ANDROID",
        platform: "ANDROID",
        role: "WORKER",
      },
    });
    expect(response.statusCode).toBe(400);

    // The ticket was not consumed by this invalid attempt
    const retry = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });
    expect(retry.statusCode).toBe(201);
  });

  it("accepts pure client without public key", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: {
        token: ticket.token,
        name: "iPhone",
        type: "IPHONE",
        platform: "IOS",
        role: "CLIENT",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("lists tickets without revealing their code", async () => {
    const ticket = await issueTicket(harness, accessToken);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });

    const listed = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices/pairing-tickets",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(ticket.token);
    const rows = listed.json<{ data: { id: string; status: string }[] }>().data;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("consumed");
  });

  it("logs pairing without code or digest", async () => {
    const ticket = await issueTicket(harness, accessToken);
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });

    const trace = JSON.stringify(harness.services.securityLog.list({ limit: 50 }));
    expect(trace).toContain("device.pairing_ticket_issued");
    expect(trace).toContain("device.paired");
    expect(trace).not.toContain(ticket.token);
  });
});

describe("revocation and repair", () => {
  let harness: ApiHarness;
  let accessToken: string;

  beforeEach(async () => {
    harness = await makeApi({ publicApiUrl: API_URL });
    accessToken = await register(harness, "alex@example.test");
  });

  afterEach(async () => {
    await harness.close();
  });

  async function pair(): Promise<string> {
    const ticket = await issueTicket(harness, accessToken);
    const paired = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });
    expect(paired.statusCode).toBe(201);
    return paired.json<{ data: { id: string } }>().data.id;
  }

  it("removes public key upon revocation", async () => {
    const deviceId = await pair();
    expect(await harness.services.deviceCredentials.publicKeyFor(deviceId)).toBe(
      PHONE.publicKeyPem,
    );

    const revoked = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/revoke`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revoked.statusCode).toBe(200);

    expect(await harness.services.deviceCredentials.publicKeyFor(deviceId)).toBeUndefined();
  });

  it("allows repairing without resurrecting revoked device", async () => {
    const first = await pair();
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${first}/revoke`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const second = await pair();
    expect(second).not.toBe(first);
    expect(await harness.services.deviceCredentials.publicKeyFor(second)).toBe(PHONE.publicKeyPem);

    const devices = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const rows = devices.json<{ data: { id: string; trust: string }[] }>().data;
    expect(rows.find((item) => item.id === first)?.trust).toBe("REVOKED");
    expect(rows.find((item) => item.id === second)?.trust).toBe("PENDING");
  });

  it("rejects challenge on revoked device", async () => {
    const deviceId = await pair();
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/revoke`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/challenge`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(challenge.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("without PUBLIC_API_URL", () => {
  it("refuses to issue a QR rather than producing one that points elsewhere", async () => {
    const harness = await makeApi();
    const token = await register(harness, "alex@example.test");
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pairing-tickets",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    await harness.close();
  });
});
