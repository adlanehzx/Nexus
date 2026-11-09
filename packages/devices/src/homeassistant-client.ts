import { AppError } from "@nexus/shared";
import type {
  HomeAssistantClientAdapter,
  HomeAssistantEntityState,
  HomeAssistantServiceCall,
} from "./homeassistant.js";

/**
 * Real Home Assistant client: REST for point queries and service calls,
 * WebSocket for the live event stream and the registries (areas, devices,
 * entities), which HA only exposes over WebSocket.
 *
 * ## Secrets
 *
 * The long-lived access token lives in a private field. It is sent in the
 * `Authorization` header (REST) and in the `auth` frame (WebSocket), and
 * nowhere else: no error message, status object or log line built here ever
 * contains it. Errors raised by `fetch` itself never include request headers.
 *
 * ## Reconnection
 *
 * A dropped socket is retried with exponential backoff and jitter, capped.
 * An `auth_invalid` reply is final: retrying a rejected token would only
 * hammer HA's login ban counter (HA bans an IP after repeated failures).
 */

export type HomeAssistantConnectionState =
  "disconnected" | "connecting" | "connected" | "auth_failed" | "unreachable";

export interface HomeAssistantConnectionStatus {
  readonly state: HomeAssistantConnectionState;
  readonly haVersion: string | null;
  readonly connectedAt: string | null;
  readonly lastError: string | null;
  /** Consecutive failed attempts since the last successful connection. */
  readonly attempt: number;
  readonly nextRetryAt: string | null;
}

export interface HaStateObject {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly last_changed?: string;
  readonly last_updated?: string;
}

export interface HaArea {
  readonly area_id: string;
  readonly name: string;
}

export interface HaDeviceEntry {
  readonly id: string;
  readonly name: string | null;
  readonly name_by_user?: string | null;
  readonly area_id: string | null;
  readonly manufacturer?: string | null;
  readonly model?: string | null;
}

export interface HaEntityEntry {
  readonly entity_id: string;
  readonly device_id: string | null;
  readonly area_id: string | null;
  readonly name?: string | null;
  readonly original_name?: string | null;
  readonly disabled_by?: string | null;
  readonly hidden_by?: string | null;
  readonly entity_category?: string | null;
  readonly platform?: string;
}

export interface HomeAssistantSnapshot {
  readonly states: readonly HaStateObject[];
  readonly areas: readonly HaArea[];
  readonly devices: readonly HaDeviceEntry[];
  readonly entities: readonly HaEntityEntry[];
}

export interface HaStateChangedEvent {
  readonly entityId: string;
  readonly oldState: HaStateObject | null;
  readonly newState: HaStateObject | null;
}

/** Minimal WebSocket surface: satisfied by the WHATWG `WebSocket` global and by `ws`. */
export interface HaSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type HaSocketFactory = (url: string) => HaSocket;

export interface HomeAssistantClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly socketFactory?: HaSocketFactory;
  readonly backoff?: { initialMs?: number; maxMs?: number; factor?: number };
  readonly random?: () => number;
  readonly requestTimeoutMs?: number;
  /** Application-level ping cadence. 0 disables keepalive (tests). */
  readonly keepaliveMs?: number;
  readonly now?: () => number;
}

export class HomeAssistantAuthError extends AppError {
  readonly code = "HOMEASSISTANT_AUTH_FAILED";
  readonly httpStatus = 401;

  constructor() {
    super({
      message: "Home Assistant rejected the access token",
      userMessage:
        "Home Assistant rejected the access token. Generate a new long-lived token in your HA profile and paste it again.",
    });
  }
}

export class HomeAssistantUnavailableError extends AppError {
  readonly code = "HOMEASSISTANT_UNAVAILABLE";
  readonly httpStatus = 503;

  constructor(reason: string) {
    super({
      message: `Home Assistant unavailable: ${reason}`,
      userMessage: `Home Assistant is not reachable (${reason}).`,
      context: { reason },
    });
  }
}

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const SERVICE_PART = /^[a-z_][a-z0-9_]*$/;

/** Normalizes and validates a user-supplied HA base URL. Throws on anything but http(s). */
export function normalizeHomeAssistantUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Home Assistant URL must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Home Assistant URL must not embed credentials.");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function defaultSocketFactory(url: string): HaSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => HaSocket }).WebSocket;
  if (Ctor === undefined) throw new Error("No WebSocket implementation available.");
  return new Ctor(url);
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HomeAssistantClient implements HomeAssistantClientAdapter {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #socketFactory: HaSocketFactory;
  readonly #initialMs: number;
  readonly #maxMs: number;
  readonly #factor: number;
  readonly #random: () => number;
  readonly #timeoutMs: number;
  readonly #keepaliveMs: number;
  readonly #now: () => number;

  #socket: HaSocket | undefined;
  #wanted = false;
  #nextId = 1;
  #pending = new Map<number, PendingCommand>();
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  #status: HomeAssistantConnectionStatus = {
    state: "disconnected",
    haVersion: null,
    connectedAt: null,
    lastError: null,
    attempt: 0,
    nextRetryAt: null,
  };
  readonly #stateListeners = new Set<(event: HaStateChangedEvent) => void>();
  readonly #statusListeners = new Set<(status: HomeAssistantConnectionStatus) => void>();
  readonly #readyListeners = new Set<() => void>();

  constructor(options: HomeAssistantClientOptions) {
    this.#baseUrl = normalizeHomeAssistantUrl(options.baseUrl);
    if (options.token.trim().length < 8) throw new Error("Home Assistant token is too short.");
    this.#token = options.token.trim();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#initialMs = options.backoff?.initialMs ?? 1_000;
    this.#maxMs = options.backoff?.maxMs ?? 60_000;
    this.#factor = options.backoff?.factor ?? 2;
    this.#random = options.random ?? Math.random;
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#keepaliveMs = options.keepaliveMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get status(): HomeAssistantConnectionStatus {
    return this.#status;
  }

  /** Never serialize the token by accident. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.#baseUrl, status: this.#status };
  }

  onStateChanged(listener: (event: HaStateChangedEvent) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  onStatus(listener: (status: HomeAssistantConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** Called after every successful (re)connection, once the event subscription is live. */
  onReady(listener: () => void): () => void {
    this.#readyListeners.add(listener);
    return () => this.#readyListeners.delete(listener);
  }

  // ── REST ────────────────────────────────────────────────────────────────

  /** Verifies URL and token over REST. Throws `HomeAssistantAuthError` on 401/403. */
  async checkConnection(): Promise<{
    version: string | null;
    locationName: string | null;
    timeZone: string | null;
    language: string | null;
  }> {
    const config = (await this.#rest("GET", "/api/config")) as Record<string, unknown>;
    return {
      version: typeof config.version === "string" ? config.version : null,
      locationName: typeof config.location_name === "string" ? config.location_name : null,
      timeZone: typeof config.time_zone === "string" ? config.time_zone : null,
      language: typeof config.language === "string" ? config.language : null,
    };
  }

  /**
   * Advances a config flow (e.g. an integration HA discovered on the network).
   * An empty input confirms a discovery step.
   */
  async configFlowStep(
    flowId: string,
    input: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!/^[a-zA-Z0-9]{8,64}$/.test(flowId)) throw new Error("Invalid flow id.");
    return (await this.#rest("POST", `/api/config/config_entries/flow/${flowId}`, input)) as Record<
      string,
      unknown
    >;
  }

  async getState(entityId: string): Promise<HomeAssistantEntityState | undefined> {
    if (!ENTITY_ID.test(entityId)) throw new Error(`Invalid entity id: ${entityId}`);
    try {
      const raw = (await this.#rest("GET", `/api/states/${entityId}`)) as HaStateObject;
      return {
        entityId: raw.entity_id,
        state: raw.state,
        attributes: raw.attributes,
        lastChanged: raw.last_changed ?? "",
      };
    } catch (error) {
      if (error instanceof HomeAssistantUnavailableError && error.message.includes("HTTP 404")) {
        return undefined;
      }
      throw error;
    }
  }

  async listStatesRest(): Promise<HaStateObject[]> {
    return (await this.#rest("GET", "/api/states")) as HaStateObject[];
  }

  async callService(
    call: HomeAssistantServiceCall,
  ): Promise<{ success: boolean; newState?: string }> {
    if (!SERVICE_PART.test(call.domain) || !SERVICE_PART.test(call.service)) {
      throw new Error(`Invalid service: ${call.domain}.${call.service}`);
    }
    if (!ENTITY_ID.test(call.targetEntityId)) {
      throw new Error(`Invalid entity id: ${call.targetEntityId}`);
    }
    const changed = await this.#rest("POST", `/api/services/${call.domain}/${call.service}`, {
      ...(call.serviceData ?? {}),
      entity_id: call.targetEntityId,
    });
    const target = Array.isArray(changed)
      ? (changed as HaStateObject[]).find((s) => s.entity_id === call.targetEntityId)
      : undefined;
    return target === undefined ? { success: true } : { success: true, newState: target.state };
  }

  async #rest(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new HomeAssistantUnavailableError(
        controller.signal.aborted ? "request timed out" : describeNetworkError(error),
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) throw new HomeAssistantAuthError();
    if (!response.ok) throw new HomeAssistantUnavailableError(`HTTP ${String(response.status)}`);
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  // ── WebSocket ───────────────────────────────────────────────────────────

  /**
   * Starts the live connection. Resolves once authenticated and subscribed,
   * rejects on the first failure; reconnection continues in the background
   * unless the token was rejected.
   */
  connect(): Promise<void> {
    this.#wanted = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const offReady = this.onReady(() => {
        if (settled) return;
        settled = true;
        offReady();
        offStatus();
        resolve();
      });
      const offStatus = this.onStatus((status) => {
        if (settled) return;
        if (status.state === "auth_failed" || status.state === "unreachable") {
          settled = true;
          offReady();
          offStatus();
          reject(
            status.state === "auth_failed"
              ? new HomeAssistantAuthError()
              : new HomeAssistantUnavailableError(status.lastError ?? "unreachable"),
          );
        }
      });
      this.#open();
    });
  }

  /** Stops the connection and any pending reconnection. Idempotent. */
  close(): void {
    this.#wanted = false;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#stopKeepalive();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#rejectPending(new HomeAssistantUnavailableError("connection closed"));
    try {
      socket?.close(1000, "client closing");
    } catch {
      // already closed
    }
    this.#setStatus({ state: "disconnected", nextRetryAt: null });
  }

  /** Full registry snapshot over the live socket. */
  async fetchSnapshot(): Promise<HomeAssistantSnapshot> {
    const [states, areas, devices, entities] = await Promise.all([
      this.command("get_states") as Promise<HaStateObject[]>,
      this.command("config/area_registry/list") as Promise<HaArea[]>,
      this.command("config/device_registry/list") as Promise<HaDeviceEntry[]>,
      this.command("config/entity_registry/list") as Promise<HaEntityEntry[]>,
    ]);
    return {
      states: Array.isArray(states) ? states : [],
      areas: Array.isArray(areas) ? areas : [],
      devices: Array.isArray(devices) ? devices : [],
      entities: Array.isArray(entities) ? entities : [],
    };
  }

  /** Sends one WebSocket command and resolves with its `result`. */
  command(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.#socket;
    if (socket === undefined || this.#status.state !== "connected") {
      return Promise.reject(new HomeAssistantUnavailableError("not connected"));
    }
    return this.#send(socket, type, payload);
  }

  #send(socket: HaSocket, type: string, payload: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HomeAssistantUnavailableError(`command ${type} timed out`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ ...payload, id, type }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new HomeAssistantUnavailableError(describeNetworkError(error)));
      }
    });
  }

  #open(): void {
    if (!this.#wanted) return;
    this.#setStatus({ state: "connecting", nextRetryAt: null });
    const url = `${this.#baseUrl.replace(/^http/, "ws")}/api/websocket`;
    let socket: HaSocket;
    try {
      socket = this.#socketFactory(url);
    } catch (error) {
      this.#failed(describeNetworkError(error));
      return;
    }
    this.#socket = socket;
    let authenticated = false;
    let closedHandled = false;

    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      const messages = parseMessages(event.data);
      for (const message of messages) {
        const type = message.type;
        if (type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: this.#token }));
        } else if (type === "auth_ok") {
          authenticated = true;
          const version = typeof message.ha_version === "string" ? message.ha_version : null;
          void this.#afterAuth(socket, version);
        } else if (type === "auth_invalid") {
          closedHandled = true;
          this.#wanted = false;
          this.#socket = undefined;
          try {
            socket.close(1000, "auth invalid");
          } catch {
            // ignore
          }
          this.#setStatus({
            state: "auth_failed",
            lastError: "Home Assistant rejected the access token.",
            nextRetryAt: null,
          });
        } else if (type === "result" || type === "pong") {
          this.#settle(message);
        } else if (type === "event") {
          this.#dispatchEvent(message);
        }
      }
    });

    socket.addEventListener("close", () => {
      if (closedHandled || this.#socket !== socket) return;
      closedHandled = true;
      this.#socket = undefined;
      this.#stopKeepalive();
      this.#rejectPending(new HomeAssistantUnavailableError("connection lost"));
      if (!this.#wanted) return;
      this.#failed(authenticated ? "connection lost" : "connection refused or closed");
    });

    socket.addEventListener("error", () => {
      // `close` always follows `error`; the reconnection logic lives there.
    });
  }

  async #afterAuth(socket: HaSocket, version: string | null): Promise<void> {
    // Mark connected so `command` accepts calls, then subscribe.
    this.#setStatus({
      state: "connected",
      haVersion: version,
      connectedAt: new Date(this.#now()).toISOString(),
      lastError: null,
      attempt: 0,
      nextRetryAt: null,
    });
    try {
      await this.#send(socket, "subscribe_events", { event_type: "state_changed" });
    } catch (error) {
      if (this.#socket === socket) {
        try {
          socket.close(4000, "subscription failed");
        } catch {
          // ignore
        }
      }
      void error;
      return;
    }
    this.#startKeepalive(socket);
    for (const listener of [...this.#readyListeners]) listener();
  }

  #failed(reason: string): void {
    const attempt = this.#status.attempt + 1;
    const base = Math.min(this.#maxMs, this.#initialMs * this.#factor ** (attempt - 1));
    const delay = Math.round(base * (0.5 + this.#random() * 0.5));
    this.#setStatus({
      state: "unreachable",
      lastError: reason,
      attempt,
      nextRetryAt: new Date(this.#now() + delay).toISOString(),
    });
    if (!this.#wanted) return;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#open();
    }, delay);
    this.#retryTimer.unref?.();
  }

  #startKeepalive(socket: HaSocket): void {
    this.#stopKeepalive();
    if (this.#keepaliveMs <= 0) return;
    this.#keepaliveTimer = setInterval(() => {
      this.#send(socket, "ping", {}).catch(() => {
        // No pong: the link is dead even if TCP has not noticed. Force a reconnect.
        try {
          socket.close(4001, "keepalive timeout");
        } catch {
          // ignore
        }
      });
    }, this.#keepaliveMs);
    this.#keepaliveTimer.unref?.();
  }

  #stopKeepalive(): void {
    if (this.#keepaliveTimer !== undefined) clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = undefined;
  }

  #settle(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (message.type === "pong" || message.success === true) {
      pending.resolve(message.result ?? null);
    } else {
      const error = message.error as { code?: string; message?: string } | undefined;
      pending.reject(
        new HomeAssistantUnavailableError(
          `command failed: ${error?.code ?? "unknown"} ${error?.message ?? ""}`.trim(),
        ),
      );
    }
  }

  #dispatchEvent(message: Record<string, unknown>): void {
    const event = message.event as
      { event_type?: string; data?: Record<string, unknown> } | undefined;
    if (event?.event_type !== "state_changed" || event.data === undefined) return;
    const entityId = event.data.entity_id;
    if (typeof entityId !== "string") return;
    const change: HaStateChangedEvent = {
      entityId,
      oldState: (event.data.old_state as HaStateObject | null | undefined) ?? null,
      newState: (event.data.new_state as HaStateObject | null | undefined) ?? null,
    };
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(change);
      } catch {
        // A faulty listener must not break the event stream.
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #setStatus(patch: Partial<HomeAssistantConnectionStatus>): void {
    this.#status = { ...this.#status, ...patch };
    for (const listener of [...this.#statusListeners]) listener(this.#status);
  }
}

function parseMessages(data: unknown): Record<string, unknown>[] {
  let text: string;
  if (typeof data === "string") text = data;
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
  else if (ArrayBuffer.isView(data)) {
    text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  } else return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    // HA may coalesce several messages into a JSON array.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  } catch {
    return [];
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause !== undefined && typeof cause.code === "string") return cause.code;
    return error.message.slice(0, 120);
  }
  return "network error";
}
