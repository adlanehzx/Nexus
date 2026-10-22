import { verify as verifySignature } from "node:crypto";
import { AppError } from "@nexus/shared";
import type { ConnectorAuthFailureReason } from "./protocol.js";

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
  /**
   * The precise cause, for the audit trail.
   *
   * Carried on the error rather than encoded in it, so the single place that
   * builds a response cannot accidentally forward it. There is no mapping from
   * this value to an external code: every one of them answers the same way.
   */
  readonly reason: ConnectorAuthFailureReason;

  constructor(reason: ConnectorAuthFailureReason, detail: string) {
    super({
      message: `connector request rejected: ${detail}`,
      // Deliberately uniform across causes. Telling a caller whether the key was
      // unknown, the signature wrong, the nonce reused or the timestamp stale
      // hands them a way to narrow down what to change.
      userMessage: "This request was refused.",
      context: { reason },
    });
    this.reason = reason;
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
  /**
   * Nonces per client: `clientId` → (`nonce` → expiry).
   *
   * ## Why nested rather than a composite string key
   *
   * A single map keyed by `${clientId}:${nonce}` would be ambiguous, and not
   * theoretically: `clientId` admits `.`, `_`, `-` and `:` (see the protocol
   * schema), so *every* single-character separator appears in the alphabet of
   * the thing being joined. Client `a:b` with nonce `c` and client `a` with
   * nonce `b:c` would collide, which means one client could consume another's
   * nonce — turning a replay defence into a denial-of-service primitive
   * usable by any authorised client against any other.
   *
   * Length-prefixing would fix the ambiguity. A nested map removes the question
   * entirely, which is cheaper to review than an encoding nobody re-derives.
   */
  readonly #seen = new Map<string, Map<string, number>>();
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /**
   * True when this client has not used this nonce.
   *
   * Scoped per client on purpose. Nonces are chosen by clients independently,
   * so two honest clients picking the same value is a coincidence, not an
   * attack, and must not make the second one fail.
   */
  remember(clientId: string, nonce: string, now: number): boolean {
    this.#evict(now);
    const forClient = this.#seen.get(clientId) ?? new Map<string, number>();
    if (forClient.has(nonce)) return false;
    forClient.set(nonce, now + this.#ttlMs);
    this.#seen.set(clientId, forClient);
    return true;
  }

  /** Total remembered nonces across all clients. For tests and diagnostics. */
  get size(): number {
    let total = 0;
    for (const forClient of this.#seen.values()) total += forClient.size;
    return total;
  }

  /** Number of clients currently holding at least one nonce. */
  get clientCount(): number {
    return this.#seen.size;
  }

  #evict(now: number): void {
    // Eviction on write rather than on a timer: a timer in a long-lived process
    // is one more thing to shut down, and the store is only read on write.
    for (const [clientId, forClient] of this.#seen) {
      for (const [nonce, expiresAt] of forClient) {
        if (expiresAt <= now) forClient.delete(nonce);
      }
      // Drop the client's map too, or an inactive client leaks an empty map
      // for as long as the process lives.
      if (forClient.size === 0) this.#seen.delete(clientId);
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
    if (Number.isNaN(issuedAt)) {
      // Defensive: the schema already requires an ISO 8601 timestamp, so this
      // is unreachable through the protocol. It is an authentication failure
      // all the same — anything else would make the shape of the timestamp
      // distinguishable from the rest.
      throw new ConnectorAuthError("malformed_timestamp", "unparseable issuedAt");
    }

    const now = this.#now();
    if (issuedAt > now + this.#clockSkewMs) {
      // A request from the future is not a clock problem to accommodate: it
      // would extend the window a captured request stays valid for.
      throw new ConnectorAuthError("future_timestamp", "issuedAt is in the future");
    }
    if (now - issuedAt > this.#acceptanceWindowMs) {
      throw new ConnectorAuthError(
        "expired_timestamp",
        "issuedAt is outside the acceptance window",
      );
    }

    const client = this.#clients.get(input.clientId);
    if (!client) throw new ConnectorAuthError("unknown_client", "unknown client");

    if (!verifyEd25519(client.publicKey, input.canonical, input.signature)) {
      throw new ConnectorAuthError("invalid_signature", "signature does not verify");
    }

    // Nonce last, and only after the signature verifies. Recording a nonce for
    // an unverified request would let an unauthenticated caller burn the nonce
    // of a request it merely observed, and so deny the real client its retry.
    if (!this.#nonces.remember(client.clientId, input.nonce, now)) {
      throw new ConnectorAuthError("replayed_nonce", "nonce already used");
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
