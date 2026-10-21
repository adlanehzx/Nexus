import type { Envelope } from "@nexus/protocol";

/**
 * Worker connection link port.
 *
 * Abstract transport interface decoupled from WebSockets or HTTP implementations.
 */

export type LinkState = "idle" | "connecting" | "open" | "closed";

export interface WorkerLink {
  readonly state: LinkState;
  connect(): Promise<void>;
  send(envelope: Envelope): Promise<void>;
  close(reason: string): Promise<void>;
  onMessage(handler: (envelope: unknown) => void): void;
  /** Triggered on planned or unplanned connection drops to drive reconnection. */
  onClose(handler: (reason: string) => void): void;
}

/**
 * In-memory loopback transport for unit and integration testing.
 */
export class LoopbackLink implements WorkerLink {
  #state: LinkState = "idle";
  #onMessage: ((envelope: unknown) => void) | undefined;
  #onClose: ((reason: string) => void) | undefined;

  /** Outbound receiver hooked up by integration test harnesses. */
  outbound: (envelope: Envelope) => Promise<void> | void = () => undefined;
  /** Fault injection flag to fail next connect attempt. */
  failNextConnect = false;

  readonly sent: Envelope[] = [];

  get state(): LinkState {
    return this.#state;
  }

  connect(): Promise<void> {
    this.#state = "connecting";
    if (this.failNextConnect) {
      this.failNextConnect = false;
      this.#state = "closed";
      return Promise.reject(new Error("connection refused"));
    }
    this.#state = "open";
    return Promise.resolve();
  }

  async send(envelope: Envelope): Promise<void> {
    if (this.#state !== "open") throw new Error("channel closed");
    this.sent.push(envelope);
    await this.outbound(envelope);
  }

  /** Injects a server-to-worker inbound envelope. */
  deliver(envelope: unknown): void {
    this.#onMessage?.(envelope);
  }

  close(reason: string): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closed";
    this.#onClose?.(reason);
    return Promise.resolve();
  }

  /** Simulates network drop. */
  drop(reason: string): void {
    void this.close(reason);
  }

  onMessage(handler: (envelope: unknown) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#onClose = handler;
  }
}
