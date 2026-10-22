import { generateKeyPairSync, randomUUID, randomBytes, sign } from "node:crypto";
import {
  CURRENT_PROTOCOL_VERSION,
  canonicalRequestBytes,
  type ConnectorParams,
  type ConnectorRequest,
} from "../src/protocol.js";

/**
 * A correct client, used to prove the server accepts one.
 *
 * Written against the published canonical encoding rather than by reaching into
 * the server: a test client that shares the server's private helpers would pass
 * even if the encoding on the wire were wrong.
 */
export interface TestClient {
  clientId: string;
  publicKey: string;
  sign(params: ConnectorParams, overrides?: Partial<ConnectorRequest>): ConnectorRequest;
}

export function createTestClient(clientId = "test-client"): TestClient {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  return {
    clientId,
    publicKey: publicKeyPem,
    sign(params, overrides = {}) {
      const base = {
        protocolVersion: overrides.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
        requestId: overrides.requestId ?? randomUUID(),
        issuedAt: overrides.issuedAt ?? new Date().toISOString(),
        nonce: overrides.nonce ?? randomBytes(16).toString("hex"),
        clientId: overrides.clientId ?? clientId,
      };
      const signature = sign(
        null,
        canonicalRequestBytes({ ...base, method: params.method, params }),
        privateKey,
      ).toString("base64");
      return { ...base, signature: overrides.signature ?? signature, params };
    },
  };
}
