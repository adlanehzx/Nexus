import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApi, type ApiHarness } from "./harness.js";

/**
 * Versions des exécutants, vues de l'API.
 *
 * Le point à défendre est ce que l'API **ne** fait pas : aucune route ne met un
 * worker à jour, et l'avis rendu nomme un geste local. Une interface qui
 * afficherait « en retard » avec un bouton laisserait croire à un canal qui
 * n'existe pas — et qui n'existera pas, parce qu'il serait de l'exécution de
 * code à distance.
 */

const PASSWORD = "MotDePasseTresSolide!42";

async function register(harness: ApiHarness): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "alex@example.test", displayName: "Alex", password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken;
}

async function addWorker(harness: ApiHarness, token: string, agentVersion: string | null) {
  const created = await harness.app.inject({
    method: "POST",
    url: "/api/v1/devices",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Poste fixe",
      type: "WINDOWS_PC",
      platform: "WINDOWS",
      role: "WORKER",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCo=\n-----END PUBLIC KEY-----\n",
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ data: { id: string } }>().data.id;
  if (agentVersion !== null) {
    // La version est annoncée par l'exécutant à son enregistrement ; ici on la
    // pose directement dans le registre, qui est la même chose vue du cœur.
    await harness.services.deviceRegistry.updateDevice(id, { agentVersion });
  }
  return id;
}

async function deviceOf(harness: ApiHarness, token: string, id: string) {
  const response = await harness.app.inject({
    method: "GET",
    url: `/api/v1/devices/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    data: {
      agentVersion: string | null;
      update: { status: string; expected: string | null; action: string | null };
    };
  }>().data;
}

describe("avec une version attendue", () => {
  let harness: ApiHarness;
  let token: string;

  beforeEach(async () => {
    harness = await makeApi({ expectedWorkerVersion: "1.2.0" });
    token = await register(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("signale un exécutant en retard et nomme un geste local", async () => {
    const id = await addWorker(harness, token, "1.0.0");
    const device = await deviceOf(harness, token, id);

    expect(device.agentVersion).toBe("1.0.0");
    expect(device.update.status).toBe("en-retard");
    expect(device.update.expected).toBe("1.2.0");
    expect(device.update.action).toMatch(/on its host machine/);
  });

  it("ne demande rien à un exécutant à jour", async () => {
    const id = await addWorker(harness, token, "1.2.0");
    const device = await deviceOf(harness, token, id);
    expect(device.update.status).toBe("a-jour");
    expect(device.update.action).toBeNull();
  });

  it("n'affirme rien sur un exécutant qui n'a pas annoncé sa version", async () => {
    const id = await addWorker(harness, token, null);
    const device = await deviceOf(harness, token, id);
    expect(device.update.status).toBe("inconnu");
  });

  it("rend l'avis aussi dans la liste", async () => {
    await addWorker(harness, token, "1.0.0");
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = response.json<{ data: { update: { status: string } }[] }>().data;
    expect(rows[0]?.update.status).toBe("en-retard");
  });

  it("n'expose aucune route qui mettrait un exécutant à jour", async () => {
    const id = await addWorker(harness, token, "1.0.0");
    // Le canal n'existe pas, et son absence est une décision : la vérifier
    // empêche qu'on l'ajoute par commodité un jour sans y repenser.
    for (const url of [
      `/api/v1/devices/${id}/update`,
      `/api/v1/devices/${id}/upgrade`,
      `/api/v1/devices/${id}/install`,
    ]) {
      const response = await harness.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(response.statusCode, url).toBe(404);
    }
  });
});

describe("sans version attendue", () => {
  it("ne rend aucun avis plutôt que d'affirmer « à jour »", async () => {
    const harness = await makeApi();
    const token = await register(harness);
    const id = await addWorker(harness, token, "1.0.0");
    const device = await deviceOf(harness, token, id);

    expect(device.update.status).toBe("inconnu");
    expect(device.update.expected).toBeNull();
    expect(device.update.action).toBeNull();
    await harness.close();
  });
});
