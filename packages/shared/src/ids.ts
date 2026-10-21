/**
 * NEXUS Identifiers.
 *
 * ## Why randomness uses the Web Crypto API
 *
 * This file is imported everywhere: the core on Node, the Windows client
 * inside a Tauri WebView, and the Android worker on Hermes.
 *
 * `globalThis.crypto.getRandomValues` is the sole cryptographic random
 * source available across all target environments:
 *
 *   Node >= 18   crypto is global, without imports
 *   browser      native
 *   Tauri        native (WebView2)
 *   Hermes       native Android adapter via SecureRandom
 *
 * No Math.random fallback: predictability would compromise session and
 * correlation IDs. Clear failure is preferred over predictable IDs.
 */

interface RandomSource {
  getRandomValues<T extends Uint8Array>(into: T): T;
}

function randomBytes(count: number): Uint8Array {
  // Structural type rather than DOM Crypto: compiled with lib ES2023 and types: ["node"].
  const source = (globalThis as { crypto?: Partial<RandomSource> }).crypto;

  if (source?.getRandomValues === undefined) {
    throw new Error(
      "No cryptographic randomness source: globalThis.crypto.getRandomValues is missing. " +
        "Under Node, require version 18 or newer; on an embedded engine, install " +
        "the Web Crypto API before loading @nexus/shared.",
    );
  }

  return source.getRandomValues(new Uint8Array(count));
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/** Formats bytes as hex string without Buffer dependency (for browser compatibility). */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte];
  return out;
}

/** Formats 32 hex chars into canonical 8-4-4-4-12 UUID layout. */
function format(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * UUID v7 — time-ordered identifier.
 *
 * Used as primary key across the entire data model: unlike UUID v4,
 * it preserves B-tree index insertion locality without fragmentation,
 * while remaining unguessable and generated client/application-side.
 *
 * Format (RFC 9562):
 *   48 bits  Unix timestamp in milliseconds
 *    4 bits  version (0b0111)
 *   12 bits  random
 *    2 bits  variant (0b10)
 *   62 bits  random
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit timestamp, big-endian, on bytes 0..5.
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Version 7 in high 4 bits of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant in high 2 bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return format(toHex(bytes));
}

/** Extracts the timestamp encoded in a UUID v7. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, "").slice(0, 12);
  return Number(BigInt("0x" + hex));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Request correlation identifier. Propagates end-to-end — HTTP, jobs, agent runs,
 * tool executions, WebSocket events — and appears in every log line.
 * A single correlation ID traces the full history of a request.
 *
 * Uses UUID v4: correlation IDs are never used as B-tree primary keys, and
 * omitting timestamps prevents leaking wall-clock times in response headers.
 */
export function newCorrelationId(): string {
  const bytes = randomBytes(16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return format(toHex(bytes));
}
