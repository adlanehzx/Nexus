import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePairingPayload } from "@nexus/devices";
import { makeApi, type ApiHarness } from "./harness.js";

/**
 * Appairage d'un appareil par QR, vu de l'API.
 *
 * Ce qui est éprouvé est l'**asymétrie** des deux routes : émettre un ticket
 * exige un utilisateur authentifié, l'utiliser n'exige que le ticket. C'est
 * cette asymétrie qui fait tenir l'ensemble — et c'est donc elle qu'il faut
 * attaquer.
 */

const PASSWORD = "MotDePasseTresSolide!42";
const API_URL = "http://192.168.1.20:3000";

async function register(harness: ApiHarness, email: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, displayName: "Adlane", password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

async function issueTicket(harness: ApiHarness, token: string) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/devices/pairing-tickets",
    headers: { authorization: `Bearer ${token}` },
    payload: { label: "Téléphone" },
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

describe("appairage par QR", () => {
  let harness: ApiHarness;
  let accessToken: string;

  beforeEach(async () => {
    harness = await makeApi({ publicApiUrl: API_URL });
    accessToken = await register(harness, "adlan@exemple.fr");
  });

  afterEach(async () => {
    await harness.close();
  });

  it("émet un ticket dont la charge utile est un QR d'appairage utilisable", async () => {
    const ticket = await issueTicket(harness, accessToken);

    const payload = decodePairingPayload(ticket.payload);
    expect(payload.apiUrl).toBe(API_URL);
    expect(payload.token).toBe(ticket.token);
    expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("exige un utilisateur pour émettre, mais rien pour appairer", async () => {
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

  it("rattache l'appareil au propriétaire du ticket, et arrive non approuvé", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const paired = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });

    const device = paired.json<{ data: { id: string; trust: string; status: string } }>().data;
    expect(device.trust).toBe("PENDING");
    expect(device.status).toBe("OFFLINE");

    // L'appareil apparaît bien chez son propriétaire — et nulle part ailleurs.
    const mine = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mine.json<{ data: { id: string }[] }>().data.map((item) => item.id)).toContain(
      device.id,
    );
  });

  it("ne laisse pas le porteur du code choisir le propriétaire", async () => {
    const ticket = await issueTicket(harness, accessToken);
    const otherToken = await register(harness, "tiers@exemple.fr");

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      // Un `userId` dans le corps serait de toute façon refusé par le schéma ;
      // ce qui compte est que même authentifié comme un tiers, l'appareil
      // atterrit chez le propriétaire du ticket.
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

  it("refuse un second usage du même code", async () => {
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

    // Et surtout : aucun second appareil n'a été créé.
    const mine = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mine.json<{ data: unknown[] }>().data).toHaveLength(1);
  });

  it("refuse un code inventé", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: "x".repeat(43), ...PHONE },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuse un exécutant sans clé publique, ticket valable ou non", async () => {
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
    // Le ticket change le transport de la clé, pas la règle qui l'exige.
    expect(response.statusCode).toBe(400);

    // Le ticket n'a pas été consommé par cette tentative invalide.
    const retry = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices/pair",
      payload: { token: ticket.token, ...PHONE },
    });
    expect(retry.statusCode).toBe(201);
  });

  it("accepte un client pur sans clé publique", async () => {
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

  it("liste les tickets sans jamais rendre leur code", async () => {
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

  it("journalise l'appairage sans le code ni son empreinte", async () => {
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

describe("révocation et réappairage", () => {
  let harness: ApiHarness;
  let accessToken: string;

  beforeEach(async () => {
    harness = await makeApi({ publicApiUrl: API_URL });
    accessToken = await register(harness, "adlan@exemple.fr");
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

  it("retire la clé publique en révoquant", async () => {
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

    // Sans clé, la poignée de main est invérifiable — donc impossible, quelle
    // que soit la règle qu'un futur chemin aurait oublié de vérifier.
    expect(await harness.services.deviceCredentials.publicKeyFor(deviceId)).toBeUndefined();
  });

  it("laisse réappairer, sans ressusciter l'appareil révoqué", async () => {
    const first = await pair();
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${first}/revoke`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // Le réappairage est un appairage : un nouveau ticket, un nouvel appareil.
    // La même clé matérielle est réutilisée, et c'est normal — elle n'a pas
    // changé, c'est l'appareil enregistré qui a été retiré.
    const second = await pair();
    expect(second).not.toBe(first);
    expect(await harness.services.deviceCredentials.publicKeyFor(second)).toBe(PHONE.publicKeyPem);

    const devices = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const rows = devices.json<{ data: { id: string; trust: string }[] }>().data;
    // L'ancien reste en base et reste révoqué : l'historique des tâches y
    // renvoie, et le ressusciter effacerait la décision prise.
    expect(rows.find((item) => item.id === first)?.trust).toBe("REVOKED");
    expect(rows.find((item) => item.id === second)?.trust).toBe("PENDING");
  });

  it("refuse un challenge sur un appareil révoqué", async () => {
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

describe("sans PUBLIC_API_URL", () => {
  it("refuse d'émettre un QR plutôt que d'en produire un qui mène ailleurs", async () => {
    const harness = await makeApi();
    const token = await register(harness, "adlan@exemple.fr");
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
