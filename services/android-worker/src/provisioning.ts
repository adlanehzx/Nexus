import type { NexusNative } from "./bridge/native-bridge.js";
import { decodePairingPayload } from "@nexus/devices";

export interface PersistedProvisioning {
  apiUrl: string;
  deviceId: string;
}

export interface ProvisioningStore {
  loadProvisioning(): Promise<PersistedProvisioning | null>;
  saveProvisioning(apiUrl: string, deviceId: string): Promise<void>;
}

export async function provisionAndroidWorker(input: {
  payload: string;
  name: string;
  keyAlias: string;
  native: NexusNative & ProvisioningStore;
  fetchImpl?: typeof fetch;
}): Promise<PersistedProvisioning> {
  const parsed = parsePairingPayload(input.payload);
  const publicKeyPem = await input.native.devicePublicKeyPem(input.keyAlias);
  const request = input.fetchImpl ?? fetch;
  const response = await request(`${parsed.apiUrl}/api/v1/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: parsed.token,
      name: input.name.trim() || "Android Worker",
      type: "ANDROID",
      platform: "ANDROID",
      role: "WORKER",
      publicKeyPem,
    }),
  });
  const body = (await response.json().catch(() => undefined)) as
    { data?: { id?: unknown }; error?: { message?: unknown } } | undefined;
  if (!response.ok) {
    const message = body?.error?.message;
    throw new Error(
      typeof message === "string" ? message : `appairage refuse (${response.status})`,
    );
  }
  const deviceId = body?.data?.id;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new Error("reponse d'appairage invalide : identifiant absent");
  }
  await input.native.saveProvisioning(parsed.apiUrl, deviceId);
  return { apiUrl: parsed.apiUrl, deviceId };
}

export function parsePairingPayload(payload: string): { apiUrl: string; token: string } {
  const decoded = decodePairingPayload(payload);
  if (decoded.token.length < 16) throw new Error("lien d'appairage incomplet");
  const apiUrl = new URL(decoded.apiUrl);
  const local = ["localhost", "127.0.0.1", "10.0.2.2"].includes(apiUrl.hostname);
  const privateNetwork = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(apiUrl.hostname);
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && (local || privateNetwork))) {
    throw new Error("l'API doit utiliser HTTPS hors du reseau prive");
  }
  return { apiUrl: apiUrl.toString().replace(/\/$/, ""), token: decoded.token };
}
