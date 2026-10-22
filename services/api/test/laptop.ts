import { z } from "zod";
import {
  LocalCapabilityRegistry,
  LoopbackLink,
  MemoryWorkerLogger,
  WorkerRuntime,
  type CredentialSigner,
  type HealthSource,
  type TimerPort,
} from "@nexus/worker-core";
import { RealtimeClient, SessionManager } from "@nexus/client-core";
import type {
  HttpClient,
  HttpResponse,
  SecureStorage,
  SocketState,
  SocketTransport,
} from "@nexus/client-core";
import type { Envelope } from "@nexus/protocol";
import type { WorkerConnection } from "@nexus/devices";
import { initialState, reduce, type ClientAction, type ClientState } from "@nexus/client-core";
import { signNonce, type Account, type ApiHarness, type RegisteredDevice } from "./harness.js";

/**
 * The Windows laptop, mounted for real.
 *
 * This file assembles, in a single process, exactly what runs on the
 * machine — **the real code on both sides**:
 *
 *  - the client: `SessionManager`, `RealtimeClient`, and the reducer from
 *    `@nexus/client-core`, the exact components running in the Windows window and iPhone;
 *  - the worker: `WorkerRuntime` from `@nexus/worker-core`, the daemon runtime;
 *  - the core: the complete Fastify API, with its real permissions, real
 *    gateway, and real coordinator.
 *
 * Only two elements are replaced, and both are **external boundaries**:
 * network transport, replaced by direct channel wiring (same envelopes, same schemas),
 * and worker system calls, replaced by in-memory capabilities — we avoid having
 * a test suite execute processes on the host machine.
 *
 * What is **not** replaced deserves mention, as it is what the tests prove:
 * Ed25519 signatures are real, tokens are real, device ownership verification
 * is real, worker selection is real.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Client side: wire `SocketTransport` to `ClientChannel`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory client transport.
 *
 * `RealtimeClient` believes it communicates with a WebSocket; it actually talks
 * to the API client channel. Frames transmitted are **the exact same bytes**
 * as on the wire: serialized, validated by `envelopeSchema`, decoded by
 * `parseClientRequest`.
 *
 * The handshake is handled here because transport handles it in production too:
 * `client.hello` is not a routed request, it opens the session.
 */
export class ChannelSocket implements SocketTransport {
  #state: SocketState = "idle";
  #onMessage: ((data: string) => void) | undefined;
  #onClose: ((reason: string, code?: number) => void) | undefined;
  #context: { userId: string; sessionId: string; deviceId: string } | undefined;

  readonly #harness: ApiHarness;
  /** Observed upstream envelopes, for tests to inspect. */
  readonly sent: Envelope[] = [];

  constructor(harness: ApiHarness) {
    this.#harness = harness;
  }

  get state(): SocketState {
    return this.#state;
  }

  get deviceId(): string | undefined {
    return this.#context?.deviceId;
  }

  connect(): Promise<void> {
    this.#state = "open";
    return Promise.resolve();
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Envelope;
    this.sent.push(envelope);

    void (async () => {
      if (this.#context === undefined) {
        await this.#open(envelope);
        return;
      }
      await this.#harness.app.clientChannel.handle(this.#context, envelope);
    })();
  }

  async #open(envelope: Envelope): Promise<void> {
    const payload = envelope.payload as { accessToken?: string; deviceId?: string };

    try {
      const context = await this.#harness.app.clientChannel.authenticate({
        accessToken: payload.accessToken ?? "",
        deviceId: payload.deviceId ?? "",
      });

      await this.#harness.app.clientChannel.attach(context, {
        send: (data) => {
          this.#onMessage?.(data);
        },
        close: (code, reason) => {
          this.#state = "closed";
          this.#onClose?.(reason, code);
        },
      });

      this.#context = context;
    } catch {
      // 4401: the core rejected the session. Client distinguishes this
      // from network disconnect and rotates token before retrying.
      this.#state = "closed";
      this.#onClose?.("authentication rejected", 4401);
    }
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";

    if (this.#context !== undefined) {
      this.#harness.app.clientChannel.detach(this.#context.deviceId);
      this.#context = undefined;
    }
    this.#onClose?.(reason, 1000);
  }

  onMessage(handler: (data: string) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string, code?: number) => void): void {
    this.#onClose = handler;
  }
}

/** HTTP client wired to `app.inject()` — no open port. */
export class InjectHttpClient implements HttpClient {
  readonly #harness: ApiHarness;
  readonly requests: { method: string; path: string }[] = [];

  constructor(harness: ApiHarness) {
    this.#harness = harness;
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    this.requests.push({ method: input.method, path: input.path });

    const response = await this.#harness.app.inject({
      method: input.method,
      url: input.path,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.body === undefined ? {} : { payload: input.body as never }),
    });

    // 204, proxy error page: none of these should fail caller on parse error.
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = null;
    }

    return { status: response.statusCode, body };
  }
}

export class MemoryStorage implements SecureStorage {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

export interface ClientRig {
  session: SessionManager;
  realtime: RealtimeClient;
  socket: ChannelSocket;
  state: () => ClientState;
  actions: ClientAction[];
}

/**
 * Mounts a complete client for a given device.
 *
 * Token belongs to the account and authenticates. Device indicates origin,
 * and core verifies it belongs to the token owner.
 */
export async function mountClient(
  harness: ApiHarness,
  account: Account,
  device: RegisteredDevice,
): Promise<ClientRig> {
  const storage = new MemoryStorage();
  storage.values.set("nexus.access", account.accessToken);
  storage.values.set("nexus.refresh", account.refreshToken);
  storage.values.set("nexus.device", device.device.id);

  const session = new SessionManager({ http: new InjectHttpClient(harness), storage });
  await session.restore();

  let state = initialState;
  const actions: ClientAction[] = [];
  const socket = new ChannelSocket(harness);

  const realtime = new RealtimeClient({
    socket,
    session,
    url: "wss://nexus.test/ws/client",
    dispatch: (action) => {
      actions.push(action);
      state = reduce(state, action);
    },
    timers: NO_TIMERS,
  });

  await realtime.start();
  return { session, realtime, socket, actions, state: () => state };
}

/**
 * Inert timers.
 *
 * Tests require neither request timeouts nor scheduled reconnects:
 * they test routing, and real timers make tests slow and flaky.
 */
const NO_TIMERS: TimerPort = {
  set: () => 0,
  clear: () => undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// Worker side: wire `WorkerLink` to `WorkerChannel`
// ─────────────────────────────────────────────────────────────────────────────

class StaticSigner implements CredentialSigner {
  readonly #pem: string;

  constructor(privateKeyPem: string) {
    this.#pem = privateKeyPem;
  }

  sign(nonce: string): Promise<string> {
    return Promise.resolve(signNonce(this.#pem, nonce));
  }
}

class SimpleHealth implements HealthSource {
  active = 0;
  max = 2;
  degraded = false;

  snapshot() {
    return { activeTasks: this.active, maxConcurrentTasks: this.max };
  }
  hasCapacity(): boolean {
    return this.active < this.max;
  }
  isDegraded(): boolean {
    return this.degraded;
  }
}

export interface WorkerRig {
  runtime: WorkerRuntime;
  link: LoopbackLink;
  health: SimpleHealth;
  logger: MemoryWorkerLogger;
  /** What the test capability actually received. */
  executed: { capability: string; input: unknown }[];
  /** Cuts channel — machine turns off, cable disconnects. */
  disconnect(reason?: string): void;
}

/**
 * Simulated capability behaviour.
 *
 * A test capability does not have to be silent: an end-to-end scenario
 * must be able to report progress, fail, or hang.
 * These are the three forms a real worker takes.
 */
export type CapabilityBehaviour = (
  input: Record<string, unknown>,
  context: { onProgress: (progress: { percent?: number; label?: string }) => void },
) => Promise<unknown>;

/**
 * Mounts a complete worker for a given device.
 *
 * Capabilities are in-memory doubles — nothing runs on the test runner host.
 * Everything else is real runtime: handshake, signature, registration,
 * dispatch, progress, result, recovery.
 */
export function mountWorker(
  harness: ApiHarness,
  device: RegisteredDevice,
  options: {
    capabilities?: readonly string[];
    connectionId?: string;
    platform?: string;
    /** Behaviour per capability. Defaults to immediate success. */
    behaviours?: Readonly<Record<string, CapabilityBehaviour>>;
  } = {},
): WorkerRig {
  const names = options.capabilities ?? ["filesystem.read", "terminal.execute"];
  const executed: { capability: string; input: unknown }[] = [];

  const registry = new LocalCapabilityRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `Test capability: ${name}`,
      inputSchema: z.record(z.string(), z.unknown()).default({}),
      riskLevel: "SAFE",
      execute: async (input: Record<string, unknown>, context) => {
        executed.push({ capability: name, input });

        const behaviour = options.behaviours?.[name];
        if (behaviour === undefined) return { ok: true, capability: name };

        return behaviour(input, { onProgress: context.onProgress });
      },
    });
  }

  const link = new LoopbackLink();
  const health = new SimpleHealth();
  const logger = new MemoryWorkerLogger();
  const connectionId = options.connectionId ?? `conn-${device.device.id}`;

  // API worker channel receives what runtime sends, and sends back what
  // gateway produces. Both ends exchange protocol envelopes validated
  // by the exact wire schemas.
  const connection: WorkerConnection = {
    connectionId,
    deviceId: device.device.id,
    send: (envelope: Envelope) => {
      link.deliver(envelope);
    },
    close: () => {
      link.drop("closed by core");
    },
  };

  link.outbound = async (envelope) => {
    await harness.services.gateway.handleMessage(connection, envelope);
  };

  const runtime = new WorkerRuntime({
    config: {
      deviceId: device.device.id,
      platform: options.platform ?? "WINDOWS",
      workerVersion: "0.1.0",
      heartbeatIntervalMs: 60_000,
      taskTimeoutMs: 5_000,
      maxConcurrentTasks: 2,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 10_000,
    },
    link,
    signer: new StaticSigner(device.privateKeyPem),
    capabilities: registry,
    logger,
    health,
    timers: NO_TIMERS,
  });

  return {
    runtime,
    link,
    health,
    logger,
    executed,
    disconnect: (reason = "machine powered off") => {
      // Two actions, as on the wire: worker socket drops — triggering recovery —
      // and transport notifies gateway so core does not wait indefinitely.
      link.drop(reason);
      void harness.services.gateway.detachConnection(connectionId, reason);
    },
  };
}
