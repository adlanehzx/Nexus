import type { NexusNative } from "./bridge/native-bridge.js";

/**
 * Device pairing.
 */

export interface PairingIdentity {
  /** Identifier assigned by core. Public: does not authenticate by itself. */
  deviceId: string;
  /** Alias in keystore. A reference, never the raw key. */
  keyAlias: string;
  /** Public key of device, in PEM format. */
  publicKeyPem: string;
}

/**
 * Reads the public identity of the device.
 */
export async function readPairingIdentity(
  native: NexusNative,
  input: { deviceId: string; keyAlias: string },
): Promise<PairingIdentity> {
  const publicKeyPem = await native.devicePublicKeyPem(input.keyAlias);

  return {
    deviceId: input.deviceId,
    keyAlias: input.keyAlias,
    publicKeyPem: publicKeyPem.trim(),
  };
}

/**
 * Short representation of a public key, for visual comparison.
 */
export function shortKey(publicKeyPem: string): string {
  const body = publicKeyPem
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (body.length <= 20) return body;
  return `${body.slice(0, 10)}…${body.slice(-10)}`;
}
