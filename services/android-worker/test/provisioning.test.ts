import { describe, expect, it, vi } from "vitest";
import type { NexusNative } from "../src/bridge/native-bridge.js";
import {
  parsePairingPayload,
  provisionAndroidWorker,
  type ProvisioningStore,
} from "../src/provisioning.js";

describe("appairage au premier lancement Android", () => {
  it("consomme le ticket avec la cle publique et persiste seulement l'identite", async () => {
    const saveProvisioning = vi.fn(() => Promise.resolve());
    const native = {
      devicePublicKeyPem: vi.fn(() =>
        Promise.resolve("-----BEGIN PUBLIC KEY-----\nPUBLIC\n-----END PUBLIC KEY-----"),
      ),
      saveProvisioning,
    } as unknown as NexusNative & ProvisioningStore;
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("corps JSON attendu");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.token).toBe("ticket-secret-1234567890");
      expect(String(body.publicKeyPem)).toContain("BEGIN PUBLIC KEY");
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: "android-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const result = await provisionAndroidWorker({
      payload: "nexus://pair?api=https%3A%2F%2Fnexus.example.test&token=ticket-secret-1234567890",
      name: "Telephone",
      keyAlias: "nexus.device.key",
      native,
      fetchImpl: request,
    });

    expect(result).toEqual({ apiUrl: "https://nexus.example.test", deviceId: "android-1" });
    expect(saveProvisioning).toHaveBeenCalledWith("https://nexus.example.test", "android-1");
  });

  it("refuse une destination distante non chiffree", () => {
    expect(() =>
      parsePairingPayload(
        "nexus://pair?api=http%3A%2F%2Fexample.test&token=ticket-secret-1234567890",
      ),
    ).toThrow("HTTPS");
  });
});
