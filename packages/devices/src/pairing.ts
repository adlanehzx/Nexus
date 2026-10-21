import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, uuidv7 } from "@nexus/shared";

/**
 * Single-use ticket device pairing.
 *
 * ## What this replaces and what it retains
 *
 * A mobile device private key originates inside its hardware keystore and never leaves it.
 * The Core must receive the device's public key. Historically this was transported manually:
 * copy from phone, paste into dashboard. Manual transport is slow and error-prone.
 *
 * The pairing ticket replaces manual transport while maintaining cryptographic proof of ownership.
 *
 * ## Why a ticket proves physical authorization
 *
 * The ticket is issued from an already-authenticated session and displayed on the owner's screen.
 * Scanning requires visual proximity to the display: it provides physical presence proof.
 * The ticket binds to the authenticated owner's `userId`, ensuring the created device belongs
 * strictly to that owner.
 *
 * Three core security properties:
 *
 * 1. Single-use: once paired, the ticket is immediately consumed;
 * 2. Short lifetime: 5-minute default TTL;
 * 3. Never stored in cleartext: only the SHA-256 hash is persisted in the database.
 *
 * ## What the ticket does not grant
 *
 * Paired devices register in `PENDING` state and remain offline until explicit administrator approval.
 */

/** Default pairing ticket TTL (5 minutes). */
export const PAIRING_TICKET_TTL_MS = 5 * 60_000;

/** Secret entropy length in bytes. */
const CODE_BYTES = 32;

export interface PairingTicket {
  id: string;
  userId: string;
  /**
   * SHA-256 hash of the code (hex).
   *
   * The plaintext code only exists in the generation response. Store lookups match
   * by cryptographic hash.
   */
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Device created by this ticket once redeemed. */
  deviceId: string | null;
  /** Optional human label for administration. */
  label: string | null;
}

/**
 * Public summary of a pairing ticket.
 *
 * Omit code hash from serialized representations.
 */
export interface PairingTicketSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  deviceId: string | null;
  label: string | null;
  status: "pending" | "consumed" | "expired";
}

export interface PairingTicketStore {
  save(ticket: PairingTicket): Promise<void>;
  findByCodeHash(codeHash: string): Promise<PairingTicket | undefined>;
  listByUser(userId: string): Promise<PairingTicket[]>;
  /** Prunes expired or consumed tickets older than `before`. */
  prune(before: Date): Promise<number>;
}

export class InMemoryPairingTicketStore implements PairingTicketStore {
  readonly #tickets = new Map<string, PairingTicket>();

  save(ticket: PairingTicket): Promise<void> {
    this.#tickets.set(ticket.id, structuredClone(ticket));
    return Promise.resolve();
  }

  findByCodeHash(codeHash: string): Promise<PairingTicket | undefined> {
    for (const ticket of this.#tickets.values()) {
      if (ticket.codeHash === codeHash) return Promise.resolve(structuredClone(ticket));
    }
    return Promise.resolve(undefined);
  }

  listByUser(userId: string): Promise<PairingTicket[]> {
    return Promise.resolve(
      [...this.#tickets.values()]
        .filter((ticket) => ticket.userId === userId)
        .map((ticket) => structuredClone(ticket)),
    );
  }

  prune(before: Date): Promise<number> {
    let removed = 0;
    for (const [id, ticket] of this.#tickets) {
      const done = ticket.consumedAt !== null || ticket.expiresAt.getTime() <= before.getTime();
      if (done && ticket.createdAt.getTime() <= before.getTime()) {
        this.#tickets.delete(id);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  get size(): number {
    return this.#tickets.size;
  }
}

export class PairingTicketInvalidError extends AppError {
  readonly code = "PAIRING_TICKET_INVALID";
  readonly httpStatus = 401;

  constructor(reason: "unknown" | "expired" | "consumed") {
    super({
      message: `Pairing ticket rejected: ${reason}`,
      userMessage: "This pairing code is no longer valid. Display a new QR code and scan again.",
      context: { reason },
    });
  }
}

export interface PairingServiceOptions {
  store: PairingTicketStore;
  ttlMs?: number;
  now?: () => Date;
  newId?: () => string;
  /** Replaceable entropy generator for testing. */
  randomCode?: () => string;
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Generates single-use code: 32 bytes of CSPRNG randomness, base64url-encoded. */
export function newPairingCode(): string {
  return randomBytes(CODE_BYTES).toString("base64url");
}

export interface IssuedTicket {
  ticket: PairingTicket;
  /** Plaintext single-use code, returned once upon issuance. */
  code: string;
}

export class PairingService {
  readonly #store: PairingTicketStore;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #randomCode: () => string;

  constructor(options: PairingServiceOptions) {
    this.#store = options.store;
    this.#ttlMs = options.ttlMs ?? PAIRING_TICKET_TTL_MS;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#randomCode = options.randomCode ?? newPairingCode;
  }

  async issue(input: { userId: string; label?: string }): Promise<IssuedTicket> {
    const createdAt = this.#now();
    const code = this.#randomCode();
    const ticket: PairingTicket = {
      id: this.#newId(),
      userId: input.userId,
      codeHash: hashPairingCode(code),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.#ttlMs),
      consumedAt: null,
      deviceId: null,
      label: input.label ?? null,
    };
    await this.#store.save(ticket);
    return { ticket, code };
  }

  /**
   * Exchanges pairing code for ticket validation.
   *
   * Device creation is completed by caller via `complete`.
   */
  async redeem(code: string): Promise<PairingTicket> {
    const ticket = await this.#store.findByCodeHash(hashPairingCode(code));
    if (ticket === undefined) throw new PairingTicketInvalidError("unknown");
    if (ticket.consumedAt !== null) throw new PairingTicketInvalidError("consumed");
    if (ticket.expiresAt.getTime() <= this.#now().getTime()) {
      throw new PairingTicketInvalidError("expired");
    }
    return ticket;
  }

  /** Marks ticket consumed and associates created device. */
  async complete(ticket: PairingTicket, deviceId: string): Promise<PairingTicket> {
    const consumed: PairingTicket = { ...ticket, consumedAt: this.#now(), deviceId };
    await this.#store.save(consumed);
    return consumed;
  }

  async list(userId: string): Promise<PairingTicketSummary[]> {
    const now = this.#now().getTime();
    const tickets = await this.#store.listByUser(userId);
    return tickets
      .map((ticket) => ({
        id: ticket.id,
        createdAt: ticket.createdAt,
        expiresAt: ticket.expiresAt,
        consumedAt: ticket.consumedAt,
        deviceId: ticket.deviceId,
        label: ticket.label,
        status:
          ticket.consumedAt !== null
            ? ("consumed" as const)
            : ticket.expiresAt.getTime() <= now
              ? ("expired" as const)
              : ("pending" as const),
      }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  prune(): Promise<number> {
    return this.#store.prune(this.#now());
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QR Pairing Payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dedicated protocol scheme rather than a standard web URL.
 *
 * Avoids leaking pairing credentials into browser history or web proxy logs.
 */
export const PAIRING_URI_SCHEME = "nexus";

export interface PairingPayload {
  /** Core API base URL that the device will communicate with. */
  apiUrl: string;
  /** Single-use pairing token. */
  token: string;
}

export function encodePairingPayload(payload: PairingPayload): string {
  const url = new URL(`${PAIRING_URI_SCHEME}://pair`);
  url.searchParams.set("api", payload.apiUrl);
  url.searchParams.set("token", payload.token);
  return url.toString();
}

export function decodePairingPayload(text: string): PairingPayload {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch (error) {
    throw new PairingPayloadError("unreadable payload", { cause: error });
  }
  if (url.protocol !== `${PAIRING_URI_SCHEME}:` || url.host !== "pair") {
    throw new PairingPayloadError("QR code is not a valid NEXUS pairing QR code");
  }
  const apiUrl = url.searchParams.get("api");
  const token = url.searchParams.get("token");
  if (apiUrl === null || token === null) {
    throw new PairingPayloadError("incomplete payload");
  }
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch (error) {
    throw new PairingPayloadError("invalid API URL", { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PairingPayloadError("invalid API URL: only http and https protocols permitted");
  }
  return { apiUrl, token };
}

export class PairingPayloadError extends AppError {
  readonly code = "PAIRING_PAYLOAD_INVALID";
  readonly httpStatus = 400;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super({
      message,
      userMessage: "This QR code cannot be used to pair a device.",
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

/** Constant-time comparison helper for pairing codes. */
export function pairingCodesEqual(left: string, right: string): boolean {
  const a = Buffer.from(hashPairingCode(left), "hex");
  const b = Buffer.from(hashPairingCode(right), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
