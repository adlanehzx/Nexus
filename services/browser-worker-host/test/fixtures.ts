import { createPrivateKey, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  TaskCoordinator,
  WorkerGateway,
  type Device,
  type WorkerConnection,
} from "@nexus/devices";
import {
  LoopbackLink,
  MemoryWorkerLogger,
  type CredentialSigner,
  type TimerPort,
} from "@nexus/worker-core";
import type { Envelope, NexusEvent } from "@nexus/protocol";
import {
  BrowserWorkerClient,
  type BrowserEvent,
  type BrowserSession,
  type BrowserTask,
  type BrowserWorkerHealth,
} from "@nexus/browser-client";
import type { BrowserHostConfig } from "../src/config.js";
import { assembleBrowserHost } from "../src/assemble.js";
import { BrowserWorkerHost } from "../src/worker.js";

/**
 * Browser worker harness.
 *
 * Two principles, same as for Windows and Android workers:
 *
 *  1. **No real browser.** The Python worker is replaced by an in-memory HTTP
 *     server speaking the real contract — same routes, same schemas, same error
 *     codes. Tests require neither Chromium nor model key, ensuring determinism.
 *  2. **Everything else is real.** Real Ed25519 keys, real signatures, real
 *     `DeviceSessionService`, real `WorkerGateway`, real `TaskCoordinator`,
 *     real envelopes validated by protocol schemas, real `BrowserWorkerClient`
 *     that serializes and deserializes.
 */

export const USER_ID = "user-example";
export const DEVICE_ID = "device-browser";

// ─────────────────────────────────────────────────────────────────────────────
// Python worker mock
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeTaskOutcome {
  status: BrowserTask["status"];
  output?: string;
  steps?: number;
  events?: BrowserEvent[];
  error?: { code: string; message: string; retryable: boolean };
  /** Delays completion: used to test cancellation and timeouts. */
  hangUntilCancelled?: boolean;
}

/**
 * Simulated Python worker at the **HTTP transport** level.
 *
 * Replaces `fetch`, not the client: serialization, headers, status codes,
 * and Zod validation run for real.
 */
export class FakeBrowserWorker {
  health: BrowserWorkerHealth = {
    status: "ok",
    version: "0.1.0",
    protocolVersion: 1,
    browserUseVersion: "0.13.8",
    openSessions: 0,
    runningTasks: 0,
  };

  /** Open sessions, in creation order. */
  readonly sessions: BrowserSession[] = [];
  readonly closedSessions: string[] = [];
  /** Domain lists received at session creation. */
  readonly requestedDomains: { allowed: string[]; prohibited: string[] }[] = [];
  /** Launched tasks with actual transmitted intent. */
  readonly launched: { taskId: string; sessionId: string; intent: string; instructions: string }[] =
    [];
  readonly cancelled: string[] = [];

  /** Default task outcome. Modifiable per test. */
  outcome: FakeTaskOutcome = { status: "succeeded", output: "result", steps: 3 };
  /** Service is unreachable: any request fails at network level. */
  unreachable = false;
  /** Refuses session creation, simulating pool exhaustion. */
  refuseSessions = false;

  #tasks = new Map<string, BrowserTask>();
  #counter = 0;
  #authorised: string;

  constructor(token: string) {
    this.#authorised = `Bearer ${token}`;
  }

  /** Pass as `fetchImpl` to `BrowserWorkerClient`. */
  readonly fetch: typeof fetch = (input, init) => {
    if (this.unreachable) {
      return Promise.reject(new Error("ECONNREFUSED"));
    }

    const target =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    const url = new URL(target);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);

    // Token is verified for real.
    if (url.pathname !== "/v1/health" && headers.get("authorization") !== this.#authorised) {
      return Promise.resolve(this.#json(401, { error: unauthorised() }));
    }

    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return Promise.resolve(this.#route(method, url, body));
  };

  #route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;

    if (path === "/v1/health") {
      return this.#json(200, { ...this.health, openSessions: this.sessions.length });
    }

    if (method === "POST" && path === "/v1/sessions") {
      if (this.refuseSessions) {
        return this.#json(503, {
          error: {
            code: "BROWSER_POOL_EXHAUSTED",
            message: "no browser available",
            retryable: true,
          },
        });
      }
      const request = body as {
        ownerId?: string;
        allowedDomains?: string[];
        prohibitedDomains?: string[];
      };
      this.#counter += 1;
      const session: BrowserSession = {
        sessionId: `sess-${String(this.#counter)}`,
        ownerId: request.ownerId ?? "",
        status: "open",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        currentUrl: null,
        activeTaskId: null,
      };
      this.sessions.push(session);
      this.requestedDomains.push({
        allowed: request.allowedDomains ?? [],
        prohibited: request.prohibitedDomains ?? [],
      });
      return this.#json(201, session);
    }

    const sessionTask = /^\/v1\/sessions\/([^/]+)\/tasks$/.exec(path);
    if (method === "POST" && sessionTask !== null) {
      const request = body as {
        taskId: string;
        sessionId: string;
        intent: string;
        instructions: string;
      };
      this.launched.push({
        taskId: request.taskId,
        sessionId: request.sessionId,
        intent: request.intent,
        instructions: request.instructions,
      });

      const task: BrowserTask = {
        taskId: request.taskId,
        sessionId: request.sessionId,
        status: this.outcome.hangUntilCancelled === true ? "running" : this.outcome.status,
        intent: request.intent as BrowserTask["intent"],
        steps: this.outcome.steps ?? 0,
        output: this.outcome.output ?? null,
        error: this.outcome.error ?? null,
        events: this.outcome.events ?? [],
        startedAt: new Date().toISOString(),
        finishedAt: this.outcome.hangUntilCancelled === true ? null : new Date().toISOString(),
        durationMs: 1_200,
      };
      this.#tasks.set(task.taskId, task);
      return this.#json(202, { ...task, status: "queued", events: [] });
    }

    const session = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (session !== null) {
      const id = decodeURIComponent(session[1]!);
      if (method === "DELETE") {
        this.closedSessions.push(id);
        const index = this.sessions.findIndex((entry) => entry.sessionId === id);
        if (index >= 0) this.sessions.splice(index, 1);
        return this.#json(204, undefined);
      }
      const found = this.sessions.find((entry) => entry.sessionId === id);
      return found === undefined
        ? this.#json(404, { error: notFound("session") })
        : this.#json(200, found);
    }

    const cancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel !== null) {
      const id = decodeURIComponent(cancel[1]!);
      this.cancelled.push(id);
      const task = this.#tasks.get(id);
      if (task !== undefined) this.#tasks.set(id, { ...task, status: "cancelled" });
      return this.#json(200, this.#tasks.get(id));
    }

    const status = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (method === "GET" && status !== null) {
      const id = decodeURIComponent(status[1]!);
      const task = this.#tasks.get(id);
      return task === undefined
        ? this.#json(404, { error: notFound("task") })
        : this.#json(200, task);
    }

    return this.#json(404, { error: notFound("route") });
  }

  #json(status: number, payload: unknown): Response {
    if (status === 204 || payload === undefined) {
      return new Response(null, { status });
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}

function unauthorised() {
  return { code: "BROWSER_UNAUTHORIZED", message: "invalid token", retryable: false };
}

function notFound(what: string) {
  return { code: "BROWSER_SESSION_NOT_FOUND", message: `${what} not found`, retryable: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const BROWSER_TOKEN = "test-token-sufficiently-long";

export function testConfig(overrides: Partial<BrowserHostConfig> = {}): BrowserHostConfig {
  return {
    backendUrl: "wss://nexus.test/ws/worker",
    deviceId: DEVICE_ID,
    deviceKeyPath: "/nonexistent/device.pem",

    browserWorkerUrl: "http://127.0.0.1:8100",
    browserWorkerToken: BROWSER_TOKEN,

    declaredCapabilities: [],
    allowedDomains: [],
    prohibitedDomains: [],

    maxSteps: 15,
    sessionTtlSeconds: 600,
    headless: true,

    heartbeatIntervalMs: 30_000,
    taskTimeoutMs: 60_000,
    maxConcurrentTasks: 2,
    reconnectMinMs: 2_000,
    reconnectMaxMs: 120_000,
    logLevel: "debug",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys and signing
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceKeys {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Real Ed25519 pair — same primitive as Node workers. */
export function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export class TestSigner implements CredentialSigner {
  readonly #pem: string;

  constructor(privateKeyPem: string) {
    this.#pem = privateKeyPem;
  }

  sign(nonce: string): Promise<string> {
    const signature = signEd25519(null, Buffer.from(nonce, "utf8"), createPrivateKey(this.#pem));
    return Promise.resolve(signature.toString("base64"));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Controlled timers
// ─────────────────────────────────────────────────────────────────────────────

export class TestTimers implements TimerPort {
  #next = 1;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  set = (callback: () => void, delayMs: number): unknown => {
    const handle = this.#next++;
    this.pending.set(handle, { callback, delayMs });
    return handle;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  flush(): number {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, { callback }] of entries) callback();
    return entries.length;
  }

  get delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full harness
// ─────────────────────────────────────────────────────────────────────────────

export const BROWSER_PERMISSIONS = [
  "browser.navigate",
  "browser.interact",
  "browser.login",
  "browser.purchase",
];

export interface BrowserHarness {
  registry: DeviceRegistry;
  sessions: DeviceSessionService;
  selector: DeviceSelector;
  router: EventRouter;
  gateway: WorkerGateway;
  coordinator: TaskCoordinator;
  credentials: InMemoryCredentialProvider;
  host: BrowserWorkerHost;
  link: LoopbackLink;
  logger: MemoryWorkerLogger;
  python: FakeBrowserWorker;
  client: BrowserWorkerClient;
  device: Device;
  keys: DeviceKeys;
  clientEvents: NexusEvent[];
  timers: TestTimers;
  connect(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<BrowserHostConfig>;
  trusted?: boolean;
  permissions?: string[];
  seed?: (python: FakeBrowserWorker) => void;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<BrowserHarness> {
  const registry = new DeviceRegistry();
  const credentials = new InMemoryCredentialProvider();
  const sessions = new DeviceSessionService({ registry });
  const router = new EventRouter({ registry });
  const gateway = new WorkerGateway({ registry, sessions, credentials, router });
  const selector = new DeviceSelector({ registry });
  const coordinator = new TaskCoordinator({ registry, selector, router, transport: gateway });

  const keys = generateDeviceKeys();
  const config = testConfig(options.config);

  const device = await registry.registerDevice({
    id: config.deviceId,
    userId: USER_ID,
    name: "Browser worker",
    type: "BROWSER_WORKER",
    platform: "WEB",
    role: "WORKER",
    grantedPermissions: options.permissions ?? BROWSER_PERMISSIONS,
  });
  credentials.set(device.id, keys.publicKeyPem);
  if (options.trusted !== false) await registry.trustDevice(device.id);

  const python = new FakeBrowserWorker(config.browserWorkerToken);
  options.seed?.(python);

  const client = new BrowserWorkerClient({
    baseUrl: config.browserWorkerUrl,
    token: config.browserWorkerToken,
    fetchImpl: python.fetch,
  });

  const assembled = assembleBrowserHost({ config, client });
  const logger = new MemoryWorkerLogger();
  const link = new LoopbackLink();
  const timers = new TestTimers();

  const host = new BrowserWorkerHost({
    config,
    capabilities: assembled.capabilities,
    client,
    sessions: assembled.sessions,
    link,
    signer: new TestSigner(keys.privateKeyPem),
    logger,
    timers,
    random: () => 0.5,
  });

  const connection: WorkerConnection = {
    connectionId: `conn-${device.id}`,
    deviceId: device.id,
    send: (envelope: Envelope) => {
      link.deliver(envelope);
    },
    close: () => {
      link.drop("closed by core");
    },
    remoteAddress: "192.0.2.7",
  };
  link.outbound = (envelope) => gateway.handleMessage(connection, envelope);

  const clientEvents: NexusEvent[] = [];

  return {
    registry,
    sessions,
    selector,
    router,
    gateway,
    coordinator,
    credentials,
    host,
    link,
    logger,
    python,
    client,
    device,
    keys,
    clientEvents,
    timers,

    async connect() {
      await host.start();
      await until(() => host.state === "ready" || host.state === "reconnecting");
    },
  };
}

/** Let microtask queue flush — handshake is asynchronous. */
export async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/**
 * Wait for condition to become true without real clock.
 */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  rounds = 400,
): Promise<boolean> {
  for (let index = 0; index < rounds; index += 1) {
    if (await predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}

/**
 * Wait allowing clock to tick.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never met");
}
