import tls from "node:tls";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import type { Envelope } from "@nexus/protocol";
import type { LinkState, WorkerLink } from "@nexus/worker-core";
import { WorkerConfigurationError } from "../errors.js";

/**
 * Real channel to core: an **outbound** WebSocket connection.
 */

export interface WebSocketLinkOptions {
  backendUrl: string;
  path?: string;
  connectTimeoutMs?: number;
  userAgent?: string;
  corePublicKeyFingerprint?: string;
}

export class WebSocketLink implements WorkerLink {
  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #userAgent: string;
  readonly #fingerprint: string | undefined;

  #socket: WebSocket | undefined;
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;

  constructor(options: WebSocketLinkOptions) {
    this.#url = toSocketUrl(options.backendUrl, options.path ?? "/ws/worker");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#userAgent = options.userAgent ?? "nexus-windows-worker";
    this.#fingerprint = options.corePublicKeyFingerprint;
  }

  get state(): LinkState {
    return this.#state;
  }

  get url(): string {
    return this.#url;
  }

  connect(): Promise<void> {
    this.#state = "connecting";

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url, {
        headers: { "user-agent": this.#userAgent },
        handshakeTimeout: this.#connectTimeoutMs,
        ...(this.#fingerprint === undefined
          ? {}
          : { checkServerIdentity: pinnedIdentity(this.#fingerprint) }),
        maxPayload: 262_144,
      });

      this.#socket = socket;

      let settled = false;
      const once = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };

      socket.on("open", () => {
        once(() => {
          this.#state = "open";
          resolve();
        });
      });

      socket.on("message", (data) => {
        try {
          this.#onMessage?.(JSON.parse(decodeFrame(data)));
        } catch {
          return;
        }
      });

      socket.on("error", (cause) => {
        once(() => {
          this.#state = "closed";
          reject(cause);
        });
      });

      socket.on("close", (code, reason) => {
        const text = reason.toString("utf8");
        const description = text.length > 0 ? text : `code ${String(code)}`;

        this.#state = "closed";

        once(() => {
          reject(new Error(`connection refused (${description})`));
        });

        this.#onClose?.(description);
      });
    });
  }

  send(envelope: Envelope): Promise<void> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("channel closed"));
    }

    return new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(envelope), (cause) => {
        if (cause == null) resolve();
        else reject(cause);
      });
    });
  }

  close(reason: string): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();

    this.#state = "closed";
    this.#socket?.close(1000, reason.slice(0, 100));
    return Promise.resolve();
  }

  onMessage(handler: (envelope: unknown) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }
}

function decodeFrame(data: Buffer | ArrayBuffer | readonly Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function pinnedIdentity(expected: string) {
  return (hostname: string, certificate: { pubkey?: Buffer }): Error | undefined => {
    const authorised = tls.checkServerIdentity(hostname, certificate as never);
    if (authorised !== undefined) return authorised;

    const pubkey = certificate.pubkey;
    if (pubkey === undefined) {
      return new Error("certificate without usable public key");
    }

    const actual = createHash("sha256").update(pubkey).digest("base64");
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);

    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return new Error("unexpected core public key fingerprint");
    }

    return undefined;
  };
}

export function toSocketUrl(backendUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    throw new WorkerConfigurationError([`NEXUS_BACKEND_URL: "${backendUrl}" is not a valid URL`]);
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const cleartext = url.protocol === "http:" || url.protocol === "ws:";

  if (cleartext && !local) {
    throw new WorkerConfigurationError([
      "NEXUS_BACKEND_URL: a remote address must use wss:// or https://",
    ]);
  }

  const scheme = cleartext ? "ws:" : "wss:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/$/, "")}`;

  return `${base}${path}`;
}
