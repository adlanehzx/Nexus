import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { makeApi, type ApiHarness } from "./harness.js";
import { generateKeyPairSync } from "node:crypto";

describe("Provisioning Android Worker", () => {
  let harness: ApiHarness;

  beforeEach(async () => {
    harness = await makeApi();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("déroule un provisioning de bout en bout réussi", async () => {
    const registerResponse = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "claude@nexus.local",
        displayName: "Claude",
        password: "MotDePasseTresLongEtSecurise123!",
      },
    });
    expect(registerResponse.statusCode).toBe(201);
    const { user, tokens } = registerResponse.json().data;
    expect(user.id).toBeDefined();

    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    const deviceResponse = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: {
        name: "Redmi Note 13 Claude",
        type: "ANDROID",
        platform: "ANDROID",
        role: "WORKER",
        publicKeyPem,
      },
    });
    expect(deviceResponse.statusCode).toBe(201);
    const device = deviceResponse.json().data;

    const trustResponse = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/trust`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(trustResponse.statusCode).toBe(200);

    const challengeResponse = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });
    expect(challengeResponse.statusCode).toBe(200);
    const challenge = challengeResponse.json<{ data: { nonce: string } }>().data;

    const crypto = await import("node:crypto");
    const signature = crypto
      .sign(null, Buffer.from(challenge.nonce, "utf8"), privateKey)
      .toString("base64");

    const declaredCapabilities = ["android.app.list", "android.app.open", "android.notification"];
    const authWorkerResponse = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/sessions`,
      payload: { nonce: challenge.nonce, signature, capabilities: declaredCapabilities },
    });
    expect(authWorkerResponse.statusCode).toBe(201);
  });

  it("refuse un UUID nul ou inconnu", async () => {
    const challengeResponse = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/00000000-0000-0000-0000-000000000000/challenge`,
    });
    expect(challengeResponse.statusCode).toBe(404);

    const authResponse = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/00000000-0000-0000-0000-000000000000/sessions`,
      payload: { nonce: "fake-nonce", signature: "fake-sig" },
    });
    expect(authResponse.statusCode).toBe(404);
  });
});
