import { WorkerConfigurationError } from "@nexus/worker-core";
import type { Envelope } from "@nexus/protocol";
import type { LinkState, WorkerLink } from "@nexus/worker-core";

/**
 * Real channel from phone to core: an outbound WebSocket.
 */

const CONNECTING = 0;
const OPEN = 1;

/**
 * Standard WebSocket subset used by this channel.
 */
export interface WebSocketLike {
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

/** Socket factory. */
export type WebSocketFactory = (
  url: string,
  protocols: string[] | undefined,
  options: { headers: Record<string, string> },
) => WebSocketLike;

export interface AndroidWebSocketLinkOptions {
  /** NEXUS core, for example `https://nexus.example.com`. */
  backendUrl: string;
  /** Worker channel path added to URL. */
  path?: string;
  connectTimeoutMs?: number;
  userAgent?: string;
  maxFrameBytes?: number;
  socketFactory?: WebSocketFactory;
}

export class AndroidWebSocketLink implements WorkerLink {
  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #userAgent: string;
  readonly #maxFrameBytes: number;
  readonly #factory: WebSocketFactory;

  #socket: WebSocketLike | undefined;
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;
  #closing = false;

  constructor(options: AndroidWebSocketLinkOptions) {
    this.#url = toAndroidSocketUrl(options.backendUrl, options.path ?? "/ws/worker");
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#userAgent = options.userAgent ?? "nexus-android-worker";
    this.#maxFrameBytes = options.maxFrameBytes ?? 262_144;
    this.#factory = options.socketFactory ?? defaultSocketFactory;
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
      let socket: WebSocketLike;
      try {
        socket = this.#factory(this.#url, undefined, {
          headers: { "user-agent": this.#userAgent },
        });
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
          reject(new Error(`connection refused (${description})`));
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
      // Ignore errors when closing already dead socket.
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

/** Slices WebSocket from environment — React Native, or Node in tests. */
const defaultSocketFactory: WebSocketFactory = (url, protocols, options) => {
  const implementation = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof implementation !== "function") {
    throw new Error("no WebSocket implementation in this environment");
  }

  const Constructor = implementation as new (
    url: string,
    protocols?: string[],
    options?: { headers: Record<string, string> },
  ) => WebSocketLike;

  return protocols === undefined
    ? new Constructor(url, undefined, options)
    : new Constructor(url, protocols, options);
};

/**
 * Builds socket URL.
 */
export function toAndroidSocketUrl(backendUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    throw new WorkerConfigurationError([`NEXUS_BACKEND_URL: "${backendUrl}" is not a valid URL`]);
  }

  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "10.0.2.2";
  const cleartext = url.protocol === "http:" || url.protocol === "ws:";

  if (cleartext && !local) {
    throw new WorkerConfigurationError([
      "NEXUS_BACKEND_URL: a remote address must use wss:// or https://",
    ]);
  }

  if (!cleartext && url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new WorkerConfigurationError([
      `NEXUS_BACKEND_URL: unsupported protocol "${url.protocol}"`,
    ]);
  }

  const scheme = cleartext ? "ws:" : "wss:";
  const base = `${scheme}//${url.host}${url.pathname.replace(/\/$/, "")}`;

  return base.endsWith(path) ? base : `${base}${path}`;
}
