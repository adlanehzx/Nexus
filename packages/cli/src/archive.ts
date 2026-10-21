import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Backup archive format.
 *
 * Designed to be simple and self-describing rather than an opaque encrypted tarball.
 * The manifest travels in plaintext, allowing inspection of contents, timestamp,
 * and recovery instructions without possessing the decryption passphrase.
 *
 * ```
 *   NEXUSBK1\n
 *   <JSON manifest byte length, decimal>\n
 *   <JSON manifest>
 *   <payload, optionally encrypted>
 * ```
 */

export const MAGIC = "NEXUSBK1";

/** Encryption parameters: AES-256-GCM, key derived with scrypt. */
export interface Encryption {
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  kdf: { name: "scrypt"; cost: number; blockSize: number; parallelization: number };
}

export interface ArchiveEntry {
  /** Logical path in archive (e.g. `postgres.dump`). */
  name: string;
  bytes: number;
  /** Plaintext SHA-256 digest. */
  sha256: string;
  description: string;
}

export interface Manifest {
  format: typeof MAGIC;
  createdAt: string;
  nexusVersion: string;
  origin: string;
  entries: ArchiveEntry[];
  encryption?: Encryption;
  includesSecrets: boolean;
  restore: string[];
}

const KDF = { name: "scrypt", cost: 2 ** 15, blockSize: 8, parallelization: 1 } as const;

export const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: KDF.cost,
    r: KDF.blockSize,
    p: KDF.parallelization,
    maxmem: 256 * 1024 * 1024,
  });
}

export interface BuildInput {
  entries: { name: string; description: string; content: Buffer }[];
  nexusVersion: string;
  origin: string;
  createdAt: Date;
  includesSecrets: boolean;
  restore: string[];
  passphrase?: string;
}

export function buildArchive(input: BuildInput): Buffer {
  const payload = Buffer.concat(input.entries.map((entry) => entry.content));

  const manifest: Manifest = {
    format: MAGIC,
    createdAt: input.createdAt.toISOString(),
    nexusVersion: input.nexusVersion,
    origin: input.origin,
    includesSecrets: input.includesSecrets,
    restore: input.restore,
    entries: input.entries.map((entry) => ({
      name: entry.name,
      bytes: entry.content.length,
      sha256: sha256(entry.content),
      description: entry.description,
    })),
  };

  let body = payload;
  if (input.passphrase !== undefined) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(input.passphrase, salt), iv);
    body = Buffer.concat([cipher.update(payload), cipher.final()]);
    manifest.encryption = {
      algorithm: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      kdf: KDF,
    };
  }

  const header = Buffer.from(`${MAGIC}\n`, "utf8");
  const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const length = Buffer.from(`${manifestJson.length}\n`, "utf8");
  return Buffer.concat([header, length, manifestJson, body]);
}

export interface ReadArchive {
  manifest: Manifest;
  body: Buffer;
}

/** Reads header and manifest without decrypting payload. */
export function readArchive(archive: Buffer): ReadArchive {
  const text = archive.subarray(0, 4096).toString("utf8");
  if (!text.startsWith(`${MAGIC}\n`)) {
    throw new Error("unreadable archive: missing NEXUSBK1 header");
  }
  const afterMagic = MAGIC.length + 1;
  const lengthEnd = archive.indexOf(0x0a, afterMagic);
  if (lengthEnd < 0) throw new Error("truncated archive: missing manifest length header");

  const declared = Number(archive.subarray(afterMagic, lengthEnd).toString("utf8"));
  if (!Number.isInteger(declared) || declared <= 0) {
    throw new Error("unreadable archive: invalid manifest length");
  }

  const manifestStart = lengthEnd + 1;
  const manifestEnd = manifestStart + declared;
  if (archive.length < manifestEnd) throw new Error("truncated archive: incomplete manifest");

  const manifest = JSON.parse(
    archive.subarray(manifestStart, manifestEnd).toString("utf8"),
  ) as Manifest;
  return { manifest, body: archive.subarray(manifestEnd) };
}

/**
 * Decrypts and unpacks archive payload into constituent entries.
 */
export function extractEntries(read: ReadArchive, passphrase?: string): Map<string, Buffer> {
  const { manifest } = read;
  let payload = read.body;

  if (manifest.encryption !== undefined) {
    if (passphrase === undefined) {
      throw new Error("encrypted archive: passphrase required");
    }
    const { salt, iv, authTag } = manifest.encryption;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, Buffer.from(salt, "base64")),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    try {
      payload = Buffer.concat([decipher.update(payload), decipher.final()]);
    } catch {
      throw new Error("decryption failed: incorrect passphrase or corrupted archive");
    }
  }

  const entries = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of manifest.entries) {
    const content = payload.subarray(offset, offset + entry.bytes);
    if (content.length !== entry.bytes) {
      throw new Error(`truncated archive: incomplete entry ${entry.name}`);
    }
    const digest = sha256(content);
    if (digest !== entry.sha256) {
      throw new Error(`invalid digest for ${entry.name}: archive has been tampered with`);
    }
    entries.set(entry.name, content);
    offset += entry.bytes;
  }
  return entries;
}

export const BACKUP_NAME = /^nexus-backup-\d{8}T\d{6}Z\.nxbk$/;

export function rotationVictims(names: string[], keep: number): string[] {
  const ours = names.filter((name) => BACKUP_NAME.test(name)).sort();
  if (keep < 1) throw new Error("rotation must retain at least one archive");
  return ours.slice(0, Math.max(0, ours.length - keep));
}

export function backupName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `nexus-backup-${stamp}.nxbk`;
}
