import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AppError, type ErrorSeverity } from "@nexus/shared";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * `scrypt`, available natively in Node without dependencies. Selected over
 * bcrypt due to high memory cost in addition to compute time, significantly
 * increasing ASIC/hardware cracking costs.
 *
 * Parameters are stored within the encoded hash. Upgrading parameters later
 * will not break existing hashes: each hash is verified using its own parameters,
 * and `needsRehash` flags outdated hashes for automatic upgrade on next login.
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * Production parameters. `N = 2^16` takes approximately 350 ms per call.
 */
export const SCRYPT_INTERACTIVE: ScryptParams = { N: 65_536, r: 8, p: 1 };

/**
 * Fast parameters, for tests only.
 */
export const SCRYPT_FAST: ScryptParams = { N: 4_096, r: 8, p: 1 };

const CURRENT = SCRYPT_INTERACTIVE;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Memory limit passed to scrypt.
 */
const memoryFor = (params: ScryptParams): number => Math.max(1 << 20, 144 * params.N * params.r);

export class PasswordTooWeakError extends AppError {
  readonly code = "PASSWORD_TOO_WEAK";
  readonly httpStatus = 400;
  override readonly severity: ErrorSeverity = "warning";

  constructor(reason: string) {
    super({
      message: `Password refused: ${reason}`,
      userMessage: `Password refused: ${reason}`,
      context: { reason },
    });
  }
}

/**
 * Minimum requirement: 12 characters.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < 12) {
    throw new PasswordTooWeakError("it must be at least 12 characters");
  }
  if (password.length > 1_024) {
    throw new PasswordTooWeakError("it cannot exceed 1024 characters");
  }
}

/**
 * Encoded hash format: `scrypt$N$r$p$salt$key`.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT,
): Promise<string> {
  assertPasswordAcceptable(password);

  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...params,
    maxmem: memoryFor(params),
  });

  return [
    "scrypt",
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Verifies password against hash.
 * Returns false rather than throwing on invalid hash to prevent timing attacks.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (parsed === undefined) return false;

  try {
    const derived = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: memoryFor(parsed),
    });

    return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}

/** Checks whether the encoded hash used outdated parameters. */
export function needsRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (parsed === undefined) return true;

  return parsed.N < CURRENT.N || parsed.r < CURRENT.r || parsed.p < CURRENT.p;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(encoded: string): ParsedHash | undefined {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;

  const N = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined;

  // Bound parsed parameters to prevent memory exhaustion DoS
  if (N > 1 << 18 || r > 16 || p > 16) return undefined;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(parts[4] ?? "", "base64url"),
      key: Buffer.from(parts[5] ?? "", "base64url"),
    };
  } catch {
    return undefined;
  }
}
