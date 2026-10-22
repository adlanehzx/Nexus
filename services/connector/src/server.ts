import { randomUUID } from "node:crypto";
import type { Connection, ConnectionDetector, ConnectionState } from "@nexus/connections";
import { UnknownProviderError } from "@nexus/connections";
import { ConnectorAuthError, type RequestAuthenticator } from "./auth.js";
import {
  CURRENT_PROTOCOL_VERSION,
  EXECUTING_METHODS,
  SUPPORTED_PROTOCOL_VERSIONS,
  canonicalRequestBytes,
  connectorRequestSchema,
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
  durationMs: number;
  /** True for a method that spawned a process. */
  executed: boolean;
}

export interface ConnectorServerOptions {
  detector: ConnectionDetector;
  authenticator: RequestAuthenticator;
  now?: () => number;
  onAudit?: (event: ConnectorAuditEvent) => void;
}

/** Fixed sentences. Nothing a provider or a caller supplied is interpolated into these. */
const ERROR_MESSAGES: Record<ConnectorErrorCode, string> = {
  unsupported_protocol_version: "This connector does not speak the requested protocol version.",
  malformed_request: "This request does not match the connector protocol.",
  unauthenticated: "This request was refused.",
  replayed_request: "This request was refused.",
  expired_request: "This request was refused.",
  unknown_method: "This connector does not provide that method.",
  unknown_provider: "This connection type is not available in this installation.",
  internal_error: "The connector could not complete this request.",
};

export class ConnectorServer {
  readonly #detector: ConnectionDetector;
  readonly #authenticator: RequestAuthenticator;
  readonly #now: () => number;
  readonly #onAudit: ((event: ConnectorAuditEvent) => void) | undefined;
  /** Last observed state per provider. `connection.list` reports this and runs nothing. */
  readonly #observed = new Map<string, Connection>();

  constructor(options: ConnectorServerOptions) {
    this.#detector = options.detector;
    this.#authenticator = options.authenticator;
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
      const code = error instanceof ConnectorAuthError ? error.connectorCode : "internal_error";
      return this.#fail(request.requestId, code, frame);
    }

    frame.executed = EXECUTING_METHODS.includes(method);

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
    }
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
          const connections = await this.#detector.detectAll(this.#previousStates());
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
    const previous = this.#observed.get(providerId)?.state ?? "not_installed";
    const connection = await this.#detector.detect(providerId, previous);
    this.#observed.set(providerId, connection);
    return connection;
  }

  #previousStates(): Map<string, ConnectionState> {
    return new Map([...this.#observed].map(([id, connection]) => [id, connection.state]));
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
  }): void {
    this.#onAudit?.({
      at: new Date(this.#now()).toISOString(),
      requestId: input.requestId,
      method: input.method,
      clientId: input.clientId,
      providerId: input.providerId,
      ok: input.ok,
      errorCode: input.errorCode,
      durationMs: this.#now() - input.startedAt,
      executed: input.executed,
    });
  }
}
