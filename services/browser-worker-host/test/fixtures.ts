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
 * Harnais de l'exécutant navigateur.
 *
 * Deux principes, les mêmes que pour les workers Windows et Android :
 *
 *  1. **Aucun navigateur réel.** Le worker Python est remplacé par un serveur
 *     HTTP en mémoire qui parle le vrai contrat — mêmes routes, mêmes schémas,
 *     mêmes codes d'erreur. Les tests ne demandent ni Chromium, ni clé de
 *     modèle, et ils sont donc déterministes.
 *  2. **Le reste est réel.** Vraies clés Ed25519, vraies signatures, vrai
 *     `DeviceSessionService`, vraie `WorkerGateway`, vrai `TaskCoordinator`,
 *     vraies enveloppes validées par les schémas du protocole, vrai
 *     `BrowserWorkerClient` qui sérialise et désérialise réellement.
 *
 * Ce que ces tests ne prouvent pas est dit explicitement dans le README : le
 * comportement de `browser-use` et de Chromium eux-mêmes.
 */

export const USER_ID = "user-adlan";
export const DEVICE_ID = "device-browser";

// ─────────────────────────────────────────────────────────────────────────────
// Double du worker Python
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeTaskOutcome {
  status: BrowserTask["status"];
  output?: string;
  steps?: number;
  events?: BrowserEvent[];
  error?: { code: string; message: string; retryable: boolean };
  /** Retarde la fin : sert à éprouver l'annulation et les délais. */
  hangUntilCancelled?: boolean;
}

/**
 * Worker Python simulé, au niveau du **transport HTTP**.
 *
 * On remplace `fetch`, pas le client : la sérialisation, les en-têtes, les
 * codes de statut et la validation Zod du client s'exécutent réellement. Un
 * double du client lui-même ne prouverait rien du contrat.
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

  /** Sessions ouvertes, dans l'ordre de création. */
  readonly sessions: BrowserSession[] = [];
  readonly closedSessions: string[] = [];
  /** Listes de domaines recues a la creation de session. */
  readonly requestedDomains: { allowed: string[]; prohibited: string[] }[] = [];
  /** Tâches lancées, avec l'intention réellement transmise. */
  readonly launched: { taskId: string; sessionId: string; intent: string; instructions: string }[] =
    [];
  readonly cancelled: string[] = [];

  /** Réponse par défaut d'une tâche. Modifiable par test. */
  outcome: FakeTaskOutcome = { status: "succeeded", output: "résultat", steps: 3 };
  /** Le service est injoignable : toute requête échoue au niveau réseau. */
  unreachable = false;
  /** Refuse la création de session, comme quand le pool est plein. */
  refuseSessions = false;

  #tasks = new Map<string, BrowserTask>();
  #counter = 0;
  #authorised: string;

  constructor(token: string) {
    this.#authorised = `Bearer ${token}`;
  }

  /** À passer en `fetchImpl` du `BrowserWorkerClient`. */
  readonly fetch: typeof fetch = (input, init) => {
    if (this.unreachable) {
      return Promise.reject(new Error("ECONNREFUSED"));
    }

    // `fetch` accepte trois formes ; le client n'en utilise qu'une, mais on
    // decode les trois plutot que de supposer.
    const cible =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    const url = new URL(cible);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);

    // Le jeton est vérifié pour de vrai : un test qui l'oublierait doit échouer.
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
            message: "plus de navigateur disponible",
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
      // La politique de domaine appartient au worker Python : on retient ce
      // qu'on a recu pour que les tests verifient la transmission, sans la
      // reimplementer ici.
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
        ? this.#json(404, { error: notFound("tâche") })
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
  return { code: "BROWSER_UNAUTHORIZED", message: "jeton invalide", retryable: false };
}

function notFound(what: string) {
  return { code: "BROWSER_SESSION_NOT_FOUND", message: `${what} introuvable`, retryable: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const BROWSER_TOKEN = "jeton-de-test-suffisamment-long";

export function testConfig(overrides: Partial<BrowserHostConfig> = {}): BrowserHostConfig {
  return {
    backendUrl: "wss://nexus.test/ws/worker",
    deviceId: DEVICE_ID,
    deviceKeyPath: "/inexistant/device.pem",

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
// Clés et signature
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceKeys {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Vraie paire Ed25519 — la même primitive que les exécutants sur Node. */
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
// Minuteries contrôlées
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
// Harnais complet
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

  // Type `BROWSER_WORKER` : un exécutant de la flotte du point de vue du
  // sélecteur, mais pas un appareil de l'utilisateur. Rôle `WORKER` — il
  // exécute, il ne pilote pas.
  const device = await registry.registerDevice({
    id: config.deviceId,
    userId: USER_ID,
    name: "Exécutant navigateur",
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
      link.drop("fermé par le cœur");
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

/** Laisse la file de micro-tâches se vider — la poignée de main est asynchrone. */
export async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/**
 * Attend qu'une condition devienne vraie, sans horloge réelle.
 *
 * Le prédicat peut être asynchrone — lire le registre du cœur l'est. Sans
 * l'attendre, on testerait la vérité d'un objet `Promise`, qui est toujours
 * vraie, et la boucle rendrait la main immédiatement.
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
 * Attend en laissant tourner l'horloge.
 *
 * Pour tout ce qui traverse une minuterie réelle : le client navigateur sonde
 * l'état d'une tâche toutes les cinq cents millisecondes, et une boucle de
 * micro-tâches ne l'atteint jamais.
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
  throw new Error("condition jamais atteinte");
}
