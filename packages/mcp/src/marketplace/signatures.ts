import crypto from "node:crypto";
import { McpSecurityError } from "../errors.js";
import type { MarketplacePublisher, PackageProvenance } from "./types.js";

/**
 * Deterministic canonical JSON representation for cryptographic signing.
 * Sorts object keys recursively.
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson((obj as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Calculates SHA-256 digest of arbitrary payload.
 */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export interface KeyPairResult {
  publicKeyPem: string;
  privateKeyPem: string;
  keyFingerprint: string;
}

/**
 * Generates an Ed25519 key pair for marketplace signing and testing.
 */
export function generateSigningKeyPair(): KeyPairResult {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const fingerprint = sha256Hex(publicKey).slice(0, 32);
  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    keyFingerprint: fingerprint,
  };
}

/**
 * Signs a manifest payload with an Ed25519 private key.
 */
export function signPackagePayload(
  payload: unknown,
  privateKeyPem: string,
  publisher: MarketplacePublisher,
  sourceUrl?: string,
): PackageProvenance {
  const canonical = canonicalizeJson(payload);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privateKeyPem);
  const signatureBase64 = signature.toString("base64");
  const attestationHash = sha256Hex(Buffer.from(canonical, "utf8"));

  return {
    publisher,
    signature: signatureBase64,
    attestationHash,
    timestamp: new Date().toISOString(),
    sourceUrl,
  };
}

/**
 * Verifies the cryptographic signature and provenance of a package payload.
 * Fail-closed: invalid signature, unknown publisher or tampered data throws immediately.
 */
export function verifyPackageProvenance(payload: unknown, provenance: PackageProvenance): boolean {
  if (!provenance?.signature || !provenance.publisher?.publicKey) {
    throw new McpSecurityError(
      provenance?.publisher?.name ?? "unknown",
      "Missing cryptographic signature or publisher public key",
    );
  }

  const canonical = canonicalizeJson(payload);
  const currentHash = sha256Hex(Buffer.from(canonical, "utf8"));

  if (provenance.attestationHash && provenance.attestationHash !== currentHash) {
    throw new McpSecurityError(
      provenance.publisher.name,
      `Attestation hash mismatch: expected ${provenance.attestationHash}, calculated ${currentHash}`,
    );
  }

  try {
    const isVerified = crypto.verify(
      null,
      Buffer.from(canonical, "utf8"),
      provenance.publisher.publicKey,
      Buffer.from(provenance.signature, "base64"),
    );

    if (!isVerified) {
      throw new McpSecurityError(
        provenance.publisher.name,
        "Package signature verification failed: invalid digital signature",
      );
    }

    return true;
  } catch (err: unknown) {
    if (err instanceof McpSecurityError) throw err;
    throw new McpSecurityError(
      provenance.publisher.name,
      `Cryptographic verification error: ${(err as Error).message}`,
    );
  }
}
