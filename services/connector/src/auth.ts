import { createHash, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { AppError } from "@nexus/shared";
import type { ConnectorErrorCode } from "./protocol.js";

/**
 * Authenticating a local request.
 *
 * ## Why a local socket still needs authentication
 *
 * "It only listens on loopback" is not an authorisation decision. Every process
 * on the machine can reach loopback, including a browser tab executing someone
 * else's JavaScript and any dependency of any tool the user happens to run. A
 * connector that trusts its transport is a connector that lets a web page
 * enumerate and probe the user's agent installations.
 *
 * So the transport is a containment measure and the signature is the actual
 * check. Neither substitutes for the other.
 */

export class ConnectorAuthError extends AppError {
  readonly code = "CONNECTOR_AUTH_FAILED";
  readonly httpStatus = 401;
  readonly connectorCode: ConnectorErrorCode;

  constructor(connectorCode: ConnectorErrorCode, detail: string) {
    super({
      message: `connector request rejected: ${detail}`,
      // Deliberately uniform across causes. Telling a caller whether the key was
      // unknown, the signature wrong, the nonce reused or the timestamp stale
      // hands them a way to narrow down what to change.
      userMessage: "This request was refused.",
      context: { connectorCode },
    });
    this.connectorCode = connectorCode;
  }
}

/** A client allowed to talk to this connector. Public keys only — never a secret. */
export interface ConnectorClient {
  clientId: string;
  /** SPKI PEM Ed25519 public key. */
  publicKey: string;
}

/**
 * Remembers nonces for at least the acceptance window.
 *
 * In memory, and that is a deliberate limit worth stating: a connector restart
 * forgets its nonces, so a request captured seconds before a restart could be
 * replayed once afterwards. Within the window, the timestamp check still bounds
 * that to a few seconds. Persisting it belongs with the connector's own storage
 * decision, which this batch does not make.
 */
export class NonceStore {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /** True when the nonce is fresh. A second call with the same nonce is false. */
  remember(nonce: string, now: number): boolean {
    this.#evict(now);
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, now + this.#ttlMs);
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }

  #evict(now: number): void {
    // Eviction on write rather than on a timer: a timer in a long-lived process
    // is one more thing to shut down, and the store is only read on write.
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(nonce);
    }
  }
}

export interface RequestAuthenticatorOptions {
  clients: readonly ConnectorClient[];
  /** How long a signed request stays acceptable. */
  acceptanceWindowMs?: number;
  /** Tolerated clock difference in either direction. */
  clockSkewMs?: number;
  now?: () => number;
}

export class RequestAuthenticator {
  readonly #clients: Map<string, ConnectorClient>;
  readonly #nonces: NonceStore;
  readonly #acceptanceWindowMs: number;
  readonly #clockSkewMs: number;
  readonly #now: () => number;

  constructor(options: RequestAuthenticatorOptions) {
    this.#clients = new Map(options.clients.map((client) => [client.clientId, client]));
    // 30 seconds: long enough for a slow local round trip, short enough that a
    // captured request is worthless by the time anybody notices it.
    this.#acceptanceWindowMs = options.acceptanceWindowMs ?? 30_000;
    this.#clockSkewMs = options.clockSkewMs ?? 5_000;
    this.#now = options.now ?? (() => Date.now());
    // The nonce must outlive the window it protects, skew included, or a
    // forgotten nonce becomes a replay the timestamp check still accepts.
    this.#nonces = new NonceStore(this.#acceptanceWindowMs + this.#clockSkewMs);
  }

  /**
   * Verifies a request, or throws.
   *
   * Order matters and is chosen for cost: cheap checks first, the signature
   * last. Verifying a signature before checking the timestamp would let an
   * unauthenticated caller spend the connector's CPU at will.
   */
  verify(input: {
    clientId: string;
    requestId: string;
    issuedAt: string;
    nonce: string;
    signature: string;
    canonical: Buffer;
  }): ConnectorClient {
    const issuedAt = Date.parse(input.issuedAt);
    if (Number.isNaN(issuedAt))
      throw new ConnectorAuthError("malformed_request", "unparseable issuedAt");

    const now = this.#now();
    if (issuedAt > now + this.#clockSkewMs) {
      // A request from the future is not a clock problem to accommodate: it
      // would extend the window a captured request stays valid for.
      throw new ConnectorAuthError("expired_request", "issuedAt is in the future");
    }
    if (now - issuedAt > this.#acceptanceWindowMs) {
      throw new ConnectorAuthError("expired_request", "issuedAt is outside the acceptance window");
    }

    const client = this.#clients.get(input.clientId);
    if (!client) throw new ConnectorAuthError("unauthenticated", "unknown client");

    if (!verifyEd25519(client.publicKey, input.canonical, input.signature)) {
      throw new ConnectorAuthError("unauthenticated", "signature does not verify");
    }

    // Nonce last, and only after the signature verifies. Recording a nonce for
    // an unverified request would let an unauthenticated caller burn the nonce
    // of a request it merely observed, and so deny the real client its retry.
    if (!this.#nonces.remember(input.nonce, now)) {
      throw new ConnectorAuthError("replayed_request", "nonce already used");
    }

    return client;
  }
}

/**
 * Ed25519 verification that fails closed.
 *
 * Mirrors `ed25519Verifier` in `@nexus/devices` — same algorithm, same SPKI PEM
 * input, same "any error means false" posture — over the canonical request
 * bytes rather than a bare nonce. Duplicated rather than imported because
 * `@nexus/devices` carries pairing and session storage this service has no
 * business depending on; consolidating the primitive into `@nexus/shared` is
 * recorded as a deferred change.
 */
export function verifyEd25519(publicKey: string, data: Buffer, signature: string): boolean {
  try {
    return verifySignature(null, data, publicKey, Buffer.from(signature, "base64"));
  } catch {
    // A malformed key or an unparseable signature is a failed verification, not
    // an exception to handle somewhere up the stack.
    return false;
  }
}

/**
 * Constant-time comparison of two short strings.
 *
 * Available for any future shared-token path. It hashes first so the comparison
 * does not leak the inputs' lengths, which a naive `timingSafeEqual` on raw
 * buffers would do by throwing on a length mismatch.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const hash = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(hash(left), hash(right));
}
