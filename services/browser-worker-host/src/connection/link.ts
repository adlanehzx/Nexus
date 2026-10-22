import { readFile } from "node:fs/promises";
import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { WorkerConfigurationError, type CredentialSigner } from "@nexus/worker-core";
import type { Envelope } from "@nexus/protocol";
import type { LinkState, WorkerLink } from "@nexus/worker-core";

/**
 * Host connectivity to the core: outbound WebSocket transport and challenge signer.
 */

const OPEN = 1;
const CONNECTING = 0;

/** Standard WebSocket subset used by this link. */
interface StandardWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => StandardWebSocket;

export interface CoreLinkOptions {
  /** NEXUS core URL, e.g. `https://nexus.local`. */
  backendUrl: string;
  path?: string;
  connectTimeoutMs?: number;
  /** Maximum downstream frame size in bytes. */
  maxFrameBytes?: number;
  /** Injected by tests. Defaults to global `WebSocket`. */
  socketFactory?: WebSocketFactory;
}

export class CoreLink implements WorkerLink {
  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #factory: WebSocketFactory;

  #socket: StandardWebSocket | undefined;
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #closing = false;

  constructor(options: CoreLinkOptions) {
    this.#url = toSocketUrl(options.backendUrl, options.path ?? "/ws/worker");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? 262_144;
    this.#factory = options.socketFactory ?? defaultFactory;
  }

  get state(): LinkState {
    return this.#state;
  }

  get url(): string {
    return this.#url;
  }

  connect(): Promise<void> {
    this.#state = "connecting";
    this.#closing = false;

    return new Promise<void>((resolve, reject) => {
      let socket: StandardWebSocket;
      try {
        socket = this.#factory(this.#url);
      } catch (cause) {
        this.#state = "closed";
        reject(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }

      this.#socket = socket;

      let settled = false;
      const once = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      const timer = setTimeout(() => {
        once(() => {
          this.#state = "closed";
          this.#drop("connection timeout exceeded");
          reject(new Error("connection timeout exceeded"));
        });
      }, this.#connectTimeoutMs);

      socket.addEventListener("open", () => {
        once(() => {
          this.#state = "open";
          resolve();
        });
      });

      socket.addEventListener("message", (event) => {
        this.#receive(event.data);
      });

      socket.addEventListener("error", () => {
        once(() => {
          this.#state = "closed";
          reject(new Error("connection failed"));
        });
      });

      socket.addEventListener("close", (event) => {
        const text = event.reason ?? "";
        const description = text.length > 0 ? text : `code ${String(event.code ?? 1006)}`;

        this.#state = "closed";
        once(() => {
          reject(new Error(`connection rejected (${description})`));
        });

        if (!this.#closing) this.#onClose?.(description);
      });
    });
  }

  send(envelope: Envelope): Promise<void> {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) {
      return Promise.reject(new Error("channel closed"));
    }

    try {
      socket.send(JSON.stringify(envelope));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  close(reason: string): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();

    this.#closing = true;
    this.#state = "closed";
    this.#drop(reason);
    return Promise.resolve();
  }

  onMessage(handler: (envelope: unknown) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }

  #drop(reason: string): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    if (socket.readyState !== OPEN && socket.readyState !== CONNECTING) return;

    try {
      socket.close(1000, reason.slice(0, 100));
    } catch {
      // Ignored
    }
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    if (data.length > this.#maxFrameBytes) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    this.#onMessage?.(parsed);
  }
}

const defaultFactory: WebSocketFactory = (url) => {
  const implementation = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof implementation !== "function") {
    throw new Error("no WebSocket implementation found: Node 22 or newer is required");
  }
  const Constructor = implementation as new (url: string) => StandardWebSocket;
  return new Constructor(url);
};

/**
 * Format outbound WebSocket URL from backend base URL.
 */
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
  if (!cleartext && url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new WorkerConfigurationError([
      `NEXUS_BACKEND_URL: protocol "${url.protocol}" is unsupported`,
    ]);
  }

  const scheme = cleartext ? "ws:" : "wss:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  return base.endsWith(path) ? base : `${base}${path}`;
}

/**
 * Ed25519 signer reading private key in PEM format from disk.
 */
export class FileCredentialSigner implements CredentialSigner {
  readonly #path: string;

  constructor(privateKeyPath: string) {
    this.#path = privateKeyPath;
  }

  async sign(nonce: string): Promise<string> {
    let pem: string;
    try {
      pem = await readFile(this.#path, "utf8");
    } catch (cause) {
      throw new WorkerConfigurationError([
        `private key unreadable (${cause instanceof Error ? cause.message : "unknown error"})`,
      ]);
    }

    try {
      const key = createPrivateKey(pem);
      return signEd25519(null, Buffer.from(nonce, "utf8"), key).toString("base64");
    } catch {
      throw new WorkerConfigurationError(["private key is not an Ed25519 key in PEM format"]);
    }
  }
}
