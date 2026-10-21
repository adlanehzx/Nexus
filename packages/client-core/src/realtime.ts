import { uuidv7 } from "@nexus/shared";
import {
  CLIENT_HELLO,
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
  WsCloseCode,
  clientEnvelope,
  envelopeSchema,
  type ClientToServerType,
  type ServerToClientType,
} from "@nexus/protocol";
import type { NetworkMonitor, SocketTransport, TimerPort } from "./ports.js";
import { systemTimers } from "./ports.js";
import type { SessionManager } from "./session.js";
import type { ClientAction, ConnectionState } from "./store.js";

/**
 * Real-time channel, client side.
 *
 * Mobile clients lose network connectivity frequently: elevators, subways,
 * switching between Wi-Fi and mobile data, lock screen. Reconnection is therefore
 * not an exceptional failure, but the **normal operating state**.
 *
 * Three core decisions:
 *
 *  1. **Exponential backoff with jitter.** Without jitter, all clients reconnect
 *     at the exact same millisecond after a server restart, overwhelming it.
 *  2. **No reconnection attempts when offline.** When the OS signals offline status,
 *     do not dial into the void: wait for the network restored signal.
 *     Retrying without network drains battery and never succeeds.
 *  3. **Full handshake re-executed** after each drop. A session whose validity
 *     is unverified cannot be assumed valid.
 */

export interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export interface RealtimeClientOptions {
  socket: SocketTransport;
  session: SessionManager;
  /** Client WebSocket channel URL, e.g. `wss://nexus.example.com/ws/client`. */
  url: string;
  dispatch: (action: ClientAction) => void;
  network?: NetworkMonitor;
  timers?: TimerPort;
  now?: () => Date;
  newId?: () => string;
  random?: () => number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Timeout after which an unacknowledged request is aborted. */
  requestTimeoutMs?: number;
}

export class RealtimeClient {
  readonly #socket: SocketTransport;
  readonly #session: SessionManager;
  readonly #url: string;
  readonly #dispatch: (action: ClientAction) => void;
  readonly #network: NetworkMonitor | undefined;
  readonly #timers: TimerPort;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #random: () => number;
  readonly #minMs: number;
  readonly #maxMs: number;
  readonly #requestTimeoutMs: number;

  readonly #pending = new Map<string, PendingRequest>();

  #state: ConnectionState = "offline";
  #attempt = 0;
  #reconnectHandle: unknown;
  #reconnecting = false;
  #stopped = true;

  constructor(options: RealtimeClientOptions) {
    this.#socket = options.socket;
    this.#session = options.session;
    this.#url = options.url;
    this.#dispatch = options.dispatch;
    this.#network = options.network;
    this.#timers = options.timers ?? systemTimers;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
    this.#random = options.random ?? Math.random;
    this.#minMs = options.reconnectMinMs ?? 1_000;
    this.#maxMs = options.reconnectMaxMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

    this.#socket.onMessage((data) => {
      this.#onMessage(data);
    });
    this.#socket.onClose((reason, code) => {
      this.#onClose(reason, code);
    });

    this.#network?.onChange((online) => {
      this.#dispatch({ kind: "network", online });

      // Network restoration triggers immediate reconnection without waiting for
      // the backoff timer to expire: the user has just re-entered coverage and is watching.
      if (online && !this.#stopped && this.#state !== "connected") {
        this.#attempt = 0;
        void this.#connect();
      }
    });
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get pendingRequestCount(): number {
    return this.#pending.size;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#connect();
  }

  /**
   * Intentional stop.
   *
   * In-flight requests are rejected: their response will never arrive, and an
   * unsettled promise leaves caller UI stuck indefinitely.
   */
  stop(reason = "stop requested"): void {
    this.#stopped = true;
    this.#cancelReconnect();
    this.#rejectAllPending(new Error(reason));

    this.#socket.close(reason);
    this.#setState("offline");
  }

  // ── Requests ────────────────────────────────────────────────────────────

  /**
   * Sends a request and awaits its acknowledgement.
   *
   * Each request carries a `requestId`: the server returns it in the ACK,
   * allowing multiple in-flight requests without confusion. An unacknowledged
   * request is aborted after a timeout to prevent dangling promises on silent sockets.
   */
  request<T = unknown>(type: ClientToServerType, payload: unknown): Promise<T> {
    if (this.#state !== "connected") {
      return Promise.reject(new Error("No connection to NEXUS core."));
    }

    const requestId = this.#newId();

    return new Promise<T>((resolve, reject) => {
      const timer = this.#timers.set(() => {
        this.#pending.delete(requestId);
        reject(new Error("NEXUS core did not respond."));
      }, this.#requestTimeoutMs);

      this.#pending.set(requestId, {
        resolve: (data) => {
          resolve(data as T);
        },
        reject,
        timer,
      });

      this.#send(type, payload, requestId);
    });
  }

  /** Sends a message in the conversation. */
  sendMessage(input: { conversationId: string | null; text: string }) {
    return this.request<{ conversationId: string; messageId: string }>(
      CLIENT_TO_SERVER.messageSend,
      input,
    );
  }

  cancelTask(taskId: string, reason = "cancelled by user") {
    return this.request<{ cancelled: boolean }>(CLIENT_TO_SERVER.taskCancel, { taskId, reason });
  }

  cancelAgentRun(runId: string, reason = "cancelled by user") {
    return this.request<{ cancelled: boolean }>(CLIENT_TO_SERVER.agentCancel, { runId, reason });
  }

  respondToConfirmation(confirmationId: string, decision: "approved" | "rejected") {
    return this.request<{ accepted: boolean }>(CLIENT_TO_SERVER.confirmationRespond, {
      confirmationId,
      decision,
    });
  }

  /**
   * Lists the fleet devices.
   *
   * Reuses the exact shape returned by the channel — name, role, status,
   * active capabilities.
   */
  listDevices(workersOnly = false) {
    return this.request<{
      devices: { id: string; name: string; role: string; status: string; capabilities: string[] }[];
    }>(CLIENT_TO_SERVER.deviceList, { workersOnly });
  }

  subscribe(conversationId: string | null) {
    return this.request(CLIENT_TO_SERVER.conversationSubscribe, { conversationId });
  }

  // ── Connection ──────────────────────────────────────────────────────────

  async #connect(): Promise<void> {
    // Reconnecting without network only wastes battery.
    if (this.#network?.isOnline() === false) {
      this.#setState("offline");
      return;
    }

    // The handshake announces where requests originate: without an attached device,
    // there is nothing to announce. We halt before opening the socket without
    // scheduling a retry: network return will not create a device, and looping
    // would obscure the real cause behind generic connection lost messages.
    // The caller must register or bind the device via `SessionManager.ensureDevice`
    // before calling `start`.
    if (this.#session.deviceId === null) {
      this.#setState("offline");
      this.#dispatch({
        kind: "error",
        code: "CLIENT_NO_DEVICE",
        message: "This device is not yet attached to NEXUS.",
        at: this.#now().toISOString(),
      });
      return;
    }

    this.#setState("connecting");

    try {
      await this.#socket.connect(this.#url);
    } catch {
      this.#scheduleReconnect("connection failed");
      return;
    }

    this.#setState("authenticating");

    try {
      // Full handshake every time. The token is re-read from session, which may
      // have refreshed it in the interim.
      this.#send(
        CLIENT_HELLO as ClientToServerType,
        {
          accessToken: this.#session.accessToken(),
          deviceId: this.#session.deviceId,
        },
        this.#newId(),
      );
    } catch {
      // Missing token: stop retrying in a loop; user must re-authenticate.
      this.#stopped = true;
      this.#setState("offline");
      this.#socket.close("missing session");
      return;
    }

    this.#setState("connected");
  }

  #onMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Malformed frames should not close the connection: subsequent frames
      // may be completely valid.
      return;
    }

    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) return;

    // A parseable frame from the core is proof that the handshake succeeded.
    // Resetting backoff upon socket open would cause tight retry loops if the server
    // accepts TCP connections but rejects handshakes.
    this.#attempt = 0;

    const type = envelope.data.type as ServerToClientType;
    const payload = (envelope.data.payload ?? {}) as Record<string, unknown>;

    if (type === SERVER_TO_CLIENT.ack) {
      this.#settleRequest(envelope.data.requestId, payload);
      return;
    }

    this.#dispatch({
      kind: "server",
      type,
      // Envelope timestamp accompanies payload: UI displays server time,
      // not local client time.
      payload: { ...payload, ts: envelope.data.ts },
    });
  }

  #settleRequest(requestId: string | undefined, payload: Record<string, unknown>): void {
    if (requestId === undefined) return;

    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;

    this.#pending.delete(requestId);
    this.#timers.clear(pending.timer);

    if (payload.ok === true) {
      pending.resolve(payload.data);
      return;
    }

    const error = payload.error as { code?: string; message?: string } | null;
    const failure = new Error(error?.message ?? "Request rejected.");
    // Error code accompanies failure: UI distinguishes missing permission
    // from unreachable server.
    (failure as Error & { code?: string }).code = error?.code ?? "REQUEST_FAILED";

    pending.reject(failure);
  }

  #onClose(reason: string, code?: number): void {
    if (this.#stopped) return;

    // In-flight requests will never receive acknowledgements.
    this.#rejectAllPending(new Error("Connection lost."));

    // The core rejected the session, not the connection. For example, a client
    // running overnight where the access token expired while socket stayed open.
    // Reconnecting with the same token would fail indefinitely.
    //
    // Rotate token once before retrying. If refresh fails, session is cleared
    // and subsequent attempts abort cleanly instead of hammering the server.
    if (code === WsCloseCode.UNAUTHENTICATED) {
      void this.#session
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          this.#scheduleReconnect(reason);
        });
      return;
    }

    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    if (this.#reconnecting || this.#stopped) return;

    this.#reconnecting = true;
    this.#setState("reconnecting");

    const delay = this.#backoffDelay();
    this.#dispatch({
      kind: "error",
      code: "CONNECTION_LOST",
      message: `Connection lost (${reason}). Retrying in ${String(
        Math.round(delay / 1000),
      )} s.`,
      at: this.#now().toISOString(),
    });

    this.#reconnectHandle = this.#timers.set(() => {
      this.#reconnecting = false;
      this.#reconnectHandle = undefined;
      if (!this.#stopped) void this.#connect();
    }, delay);
  }

  /**
   * Exponential backoff with capped jitter.
   *
   * Jitter disperses reconnections across client devices; the cap ensures long
   * outages do not delay reconnection beyond reasonable user wait times.
   */
  #backoffDelay(): number {
    const base = Math.min(this.#minMs * 2 ** this.#attempt, this.#maxMs);
    this.#attempt += 1;

    const spread = base * 0.3;
    const delay = base - spread + this.#random() * spread * 2;

    return Math.round(Math.min(Math.max(delay, this.#minMs), this.#maxMs));
  }

  #cancelReconnect(): void {
    if (this.#reconnectHandle === undefined) return;
    this.#timers.clear(this.#reconnectHandle);
    this.#reconnectHandle = undefined;
    this.#reconnecting = false;
  }

  #rejectAllPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      this.#timers.clear(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(type: ClientToServerType, payload: unknown, requestId: string): void {
    this.#socket.send(
      JSON.stringify(
        clientEnvelope(type as never, payload as never, {
          id: this.#newId(),
          at: this.#now(),
          requestId,
        }),
      ),
    );
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#dispatch({ kind: "connection", state });
  }
}
