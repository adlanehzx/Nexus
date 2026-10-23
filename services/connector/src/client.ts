import { randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { request as httpRequest } from "node:http";
import { AppError } from "@nexus/shared";
import type { ConnectorListenTarget } from "./http.js";
import {
  CURRENT_PROTOCOL_VERSION,
  canonicalRequestBytes,
  type ConnectorParams,
  type ConnectorRequest,
  type ConnectorResponse,
} from "./protocol.js";

export class ConnectorClientError extends AppError {
  readonly code = "CONNECTOR_CLIENT_ERROR";
  readonly httpStatus = 502;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super({
      message: `connector client error: ${message}`,
      userMessage: "Failed to communicate with local connector.",
      context,
    });
  }
}

export interface ConnectorHttpClientOptions {
  clientId: string;
  privateKey: KeyObject | string;
  target: ConnectorListenTarget;
  /** Optional pinned identity fingerprint for the connector */
  pinnedFingerprint?: string;
  /** Request timeout in milliseconds (default: 15_000) */
  timeoutMs?: number;
}

export class ConnectorHttpClient {
  readonly #clientId: string;
  readonly #privateKey: KeyObject | string;
  readonly #target: ConnectorListenTarget;
  readonly #pinnedFingerprint: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: ConnectorHttpClientOptions) {
    if (process.platform === "win32" && options.target.kind === "unix") {
      throw new ConnectorClientError(
        "Unix domain sockets are not supported on Windows until a safe transport exists",
      );
    }
    this.#clientId = options.clientId;
    this.#privateKey = options.privateKey;
    this.#target = options.target;
    this.#pinnedFingerprint = options.pinnedFingerprint;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  getPinnedFingerprint(): string | undefined {
    return this.#pinnedFingerprint;
  }

  async health(): Promise<ConnectorResponse> {
    return this.invoke({ method: "health" });
  }

  async capabilities(): Promise<ConnectorResponse> {
    return this.invoke({ method: "capabilities" });
  }

  async list(): Promise<ConnectorResponse> {
    return this.invoke({ method: "connection.list" });
  }

  async detect(): Promise<ConnectorResponse> {
    return this.invoke({ method: "connection.detect" });
  }

  async test(providerId: string): Promise<ConnectorResponse> {
    return this.invoke({ method: "connection.test", providerId });
  }

  async invoke(params: ConnectorParams): Promise<ConnectorResponse> {
    const requestId = randomUUID();
    const issuedAt = new Date().toISOString();
    const nonce = randomBytes(16).toString("hex");

    const requestToSign = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
      issuedAt,
      nonce,
      clientId: this.#clientId,
      method: params.method,
      params,
    };

    const signature = sign(null, canonicalRequestBytes(requestToSign), this.#privateKey).toString(
      "base64",
    );

    const fullPayload: ConnectorRequest = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId,
      issuedAt,
      nonce,
      clientId: this.#clientId,
      signature,
      params,
    };

    const bodyStr = JSON.stringify(fullPayload);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr).toString(),
    };

    const reqOptions =
      this.#target.kind === "unix"
        ? {
            socketPath: this.#target.path,
            path: "/rpc",
            method: "POST",
            headers,
            timeout: this.#timeoutMs,
          }
        : {
            host: "127.0.0.1",
            port: this.#target.port,
            path: "/rpc",
            method: "POST",
            headers,
            timeout: this.#timeoutMs,
          };

    return new Promise<ConnectorResponse>((resolve, reject) => {
      const req = httpRequest(reqOptions, (res) => {
        let responseData = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseData += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(
              new ConnectorClientError(`HTTP ${res.statusCode}: ${responseData}`, {
                statusCode: res.statusCode,
              }),
            );
          }
          try {
            const parsed = JSON.parse(responseData) as ConnectorResponse;
            resolve(parsed);
          } catch {
            reject(new ConnectorClientError("Invalid JSON received from connector"));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new ConnectorClientError(`Request timed out after ${this.#timeoutMs}ms`));
      });

      req.on("error", (err) => {
        reject(new ConnectorClientError(err.message, { originalError: err }));
      });

      req.write(bodyStr);
      req.end();
    });
  }
}
