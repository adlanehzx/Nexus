import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApi, type ApiHarness } from "./harness.js";

/**
 * Worker versions as seen from API.
 *
 * The key invariant is what the API does **not** do: no route updates a
 * worker, and the advisory notice points to a local administrative action.
 * A UI presenting a "lagging" status with an "Update" button would suggest a channel
 * that does not exist — and will not exist, as it constitutes remote code execution.
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
      name: "Desktop workstation",
      type: "WINDOWS_PC",
      platform: "WINDOWS",
      role: "WORKER",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCo=\n-----END PUBLIC KEY-----\n",
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ data: { id: string } }>().data.id;
  if (agentVersion !== null) {
    // The version is announced by worker upon registration; here we store it
    // directly in the registry, which is identical from core perspective.
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

describe("with an expected version", () => {
  let harness: ApiHarness;
  let token: string;

  beforeEach(async () => {
    harness = await makeApi({ expectedWorkerVersion: "1.2.0" });
    token = await register(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("flags a lagging worker and names a local action", async () => {
    const id = await addWorker(harness, token, "1.0.0");
    const device = await deviceOf(harness, token, id);

    expect(device.agentVersion).toBe("1.0.0");
    expect(device.update.status).toBe("en-retard");
    expect(device.update.expected).toBe("1.2.0");
    expect(device.update.action).toMatch(/on its host machine/);
  });

  it("requests nothing from an up-to-date worker", async () => {
    const id = await addWorker(harness, token, "1.2.0");
    const device = await deviceOf(harness, token, id);
    expect(device.update.status).toBe("a-jour");
    expect(device.update.action).toBeNull();
  });

  it("asserts nothing for a worker that has not announced its version", async () => {
    const id = await addWorker(harness, token, null);
    const device = await deviceOf(harness, token, id);
    expect(device.update.status).toBe("inconnu");
  });

  it("also returns notice in the list", async () => {
    await addWorker(harness, token, "1.0.0");
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = response.json<{ data: { update: { status: string } }[] }>().data;
    expect(rows[0]?.update.status).toBe("en-retard");
  });

  it("exposes no route that would update a worker", async () => {
    const id = await addWorker(harness, token, "1.0.0");
    // Channel does not exist, and its absence is by design: asserting this
    // prevents inadvertent addition down the line.
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

describe("without expected version", () => {
  it("returns no notice rather than claiming up to date", async () => {
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
