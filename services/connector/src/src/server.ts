import { randomUUID } from "node:crypto";
import type { Connection, ConnectionDetector } from "@nexus/connections";
import { UnknownProviderError } from "@nexus/connections";
import { ConnectorAuthError, type RequestAuthenticator } from "./auth.js";
import {
  CURRENT_PROTOCOL_VERSION,
  EXECUTING_METHODS,
  SUPPORTED_PROTOCOL_VERSIONS,
  canonicalRequestBytes,
  connectorRequestSchema,
  type ConnectorAuthFailureReason,
  type ConnectorErrorCode,
  type ConnectorMethod,
  type ConnectorResponse,
} from "./protocol.js";

/**
 * Method dispatch for the local connector.
 *
 * Transport-free on purpose: this class takes a parsed body and returns a
 * response object. Every rule worth testing — version negotiation, signature,
 * replay, which methods exist — is therefore testable without opening a socket,
 * and the HTTP binding in `http.ts` has nothing in it but plumbing.
 */

export interface ConnectorAuditEvent {
  at: string;
  requestId: string;
  /** Null when the request was too malformed to name one. */
  method: ConnectorMethod | null;
  /** Null when the caller could not be authenticated. */
  clientId: string | null;
  providerId: string | null;
  ok: boolean;
  errorCode: ConnectorErrorCode | null;
  /**
   * Why authentication failed, when it did.
   *
   * Local only. This is the field that keeps "the nonce was reused" and "the
   * key is unknown" distinguishable for whoever operates the connector, while
   * the response says neither.
   */
  authFailureReason: ConnectorAuthFailureReason | null;
  durationMs: number;
  /** True for a method that spawned a process. */
  executed: boolean;
}

export interface ConnectorServerOptions {
  detector: ConnectionDetector;
  authenticator: RequestAuthenticator;
  /**
   * How many probe-running requests may be in flight at once.
   *
   * Each one spawns processes on a machine somebody is using, so this is a
   * limit on what a client can make the host do, not a throughput tuning knob.
   * Two is enough for a dashboard refreshing while a person clicks "test", and
   * low enough that a loop cannot turn the connector into a fork bomb.
   *
   * The gate lives here rather than in the transport on purpose: the method is
   * only trustworthy after the signature verifies, so a limit applied to an
   * unauthenticated body could be bypassed by claiming `health`.
   */
  maxConcurrentExecutions?: number;
  now?: () => number;
  onAudit?: (event: ConnectorAuditEvent) => void;
}

/** Fixed sentences. Nothing a provider or a caller supplied is interpolated into these. */
const ERROR_MESSAGES: Record<ConnectorErrorCode, string> = {
  unsupported_protocol_version: "This connector does not speak the requested protocol version.",
  malformed_request: "This request does not match the connector protocol.",
  // One sentence for every authentication failure. See the code enum.
  authentication_failed: "This request was refused.",
  unknown_method: "This connector does not provide that method.",
  unknown_provider: "This connection type is not available in this installation.",
  capacity_exhausted:
    "The connector is already running as many checks as it allows. Try again shortly.",
  internal_error: "The connector could not complete this request.",
};

export class ConnectorServer {
  readonly #detector: ConnectionDetector;
  readonly #authenticator: RequestAuthenticator;
  readonly #now: () => number;
  readonly #onAudit: ((event: ConnectorAuditEvent) => void) | undefined;
  /** Last observed state per provider. `connection.list` reports this and runs nothing. */
  readonly #observed = new Map<string, Connection>();
  readonly #maxConcurrentExecutions: number;
  #executing = 0;

  constructor(options: ConnectorServerOptions) {
    this.#detector = options.detector;
    this.#authenticator = options.authenticator;
    this.#maxConcurrentExecutions = options.maxConcurrentExecutions ?? 2;
    this.#now = options.now ?? (() => Date.now());
    this.#onAudit = options.onAudit;
  }

  async handle(body: unknown): Promise<ConnectorResponse> {
    const startedAt = this.#now();
    const parsed = connectorRequestSchema.safeParse(body);

    if (!parsed.success) {
      // No requestId to echo: one is minted so the rejection is still traceable
      // in the audit log. The validation detail is deliberately not returned —
      // it would describe the protocol to a caller who failed to authenticate.
      return this.#fail(randomUUID(), "malformed_request", {
        method: null,
        clientId: null,
        providerId: null,
        startedAt,
        executed: false,
        authFailureReason: null,
      });
    }

    const request = parsed.data;
    const method = request.params.method;
    const providerId = "providerId" in request.params ? (request.params.providerId ?? null) : null;
    const frame = {
      method,
      clientId: null as string | null,
      providerId,
      startedAt,
      executed: false,
      authFailureReason: null as ConnectorAuthFailureReason | null,
    };

    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(request.protocolVersion as 1)) {
      // Refused, not guessed. Accepting an unknown version would mean assuming a
      // payload shape, and the first thing that breaks would be a signature.
      return this.#fail(request.requestId, "unsupported_protocol_version", frame);
    }

    try {
      const client = this.#authenticator.verify({
        clientId: request.clientId,
        requestId: request.requestId,
        issuedAt: request.issuedAt,
        nonce: request.nonce,
        signature: request.signature,
        canonical: canonicalRequestBytes({
          protocolVersion: request.protocolVersion,
          method,
          requestId: request.requestId,
          issuedAt: request.issuedAt,
          nonce: request.nonce,
          clientId: request.clientId,
          params: request.params,
        }),
      });
      frame.clientId = client.clientId;
    } catch (error) {
      if (!(error instanceof ConnectorAuthError)) {
        return this.#fail(request.requestId, "internal_error", frame);
      }
      // The reason goes to the audit trail; the response does not carry it and
      // there is no code to carry it in. That is the whole point.
      return this.#fail(request.requestId, "authentication_failed", {
        ...frame,
        authFailureReason: error.reason,
      });
    }

    frame.executed = EXECUTING_METHODS.includes(method);

    // Only probe-running methods are counted. A read of what was already
    // observed spawns nothing, so rate-limiting it would protect nothing and
    // would make a dashboard stutter for no reason.
    if (frame.executed && this.#executing >= this.#maxConcurrentExecutions) {
      return this.#fail(request.requestId, "capacity_exhausted", frame);
    }
    if (frame.executed) this.#executing += 1;

    try {
      const result = await this.#dispatch(request.params);
      this.#audit({ ...frame, requestId: request.requestId, ok: true, errorCode: null });
      return {
        ok: true,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        result,
      };
    } catch (error) {
      const code = error instanceof UnknownProviderError ? "unknown_provider" : "internal_error";
      return this.#fail(request.requestId, code, frame);
    } finally {
      // `finally`, so a throw cannot leak a slot. A counter that only
      // decrements on the happy path wedges the connector shut after the first
      // failure, which is the bug this kind of gate usually ships with.
      if (frame.executed) this.#executing -= 1;
    }
  }

  /** In-flight probe-running requests. For tests and diagnostics. */
  get executing(): number {
    return this.#executing;
  }

  async #dispatch(params: Parameters<typeof canonicalRequestBytes>[0]["params"]): Promise<unknown> {
    switch (params.method) {
      case "health":
        return {
          status: "ok",
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        };

      case "capabilities":
        // Methods and providers, never anything about the host's environment.
        return {
          methods: [
            "health",
            "capabilities",
            "connection.list",
            "connection.detect",
            "connection.test",
          ],
          executingMethods: [...EXECUTING_METHODS],
        };

      case "connection.list":
        return { connections: [...this.#observed.values()] };

      case "connection.detect": {
        if (params.providerId === undefined) {
          // The stored Connections are passed straight through: they satisfy
          // `PreviousObservation`, so history such as `lastSuccessAt` survives
          // a later failure instead of being recomputed from nothing.
          const connections = await this.#detector.detectAll(this.#observed);
          for (const connection of connections)
            this.#observed.set(connection.providerId, connection);
          return { connections };
        }
        return { connections: [await this.#detectOne(params.providerId)] };
      }

      case "connection.test":
        // In this batch a test re-runs the declared presence probe, because no
        // provider declares a session probe yet. The distinction is kept in the
        // protocol so adding one later is not a protocol change.
        return { connection: await this.#detectOne(params.providerId) };
    }
  }

  async #detectOne(providerId: string): Promise<Connection> {
    const previous = this.#observed.get(providerId);
    const connection =
      previous === undefined
        ? await this.#detector.detect(providerId)
        : await this.#detector.detect(providerId, previous);
    this.#observed.set(providerId, connection);
    return connection;
  }

  #fail(
    requestId: string,
    code: ConnectorErrorCode,
    frame: {
      method: ConnectorMethod | null;
      clientId: string | null;
      providerId: string | null;
      startedAt: number;
      executed: boolean;
      authFailureReason: ConnectorAuthFailureReason | null;
    },
  ): ConnectorResponse {
    this.#audit({ ...frame, requestId, ok: false, errorCode: code });
    return {
      ok: false,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
      error: { code, message: ERROR_MESSAGES[code] },
    };
  }

  #audit(input: {
    requestId: string;
    method: ConnectorMethod | null;
    clientId: string | null;
    providerId: string | null;
    ok: boolean;
    errorCode: ConnectorErrorCode | null;
    startedAt: number;
    executed: boolean;
    authFailureReason: ConnectorAuthFailureReason | null;
  }): void {
    this.#onAudit?.({
      at: new Date(this.#now()).toISOString(),
      requestId: input.requestId,
      method: input.method,
      clientId: input.clientId,
      providerId: input.providerId,
      ok: input.ok,
      errorCode: input.errorCode,
      authFailureReason: input.authFailureReason,
      durationMs: this.#now() - input.startedAt,
      executed: input.executed,
    });
  }
}
