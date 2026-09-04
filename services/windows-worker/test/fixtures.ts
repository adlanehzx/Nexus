import { generateKeyPairSync } from "node:crypto";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  TaskCoordinator,
  WorkerGateway,
  type Device,
  type DeviceRole,
  type WorkerConnection,
} from "@nexus/devices";
import type { Envelope, NexusEvent } from "@nexus/protocol";
import type { WorkerConfig } from "../src/config.js";
import { type LocalCapabilityRegistry } from "@nexus/worker-core";
import { assembleCapabilities } from "../src/assemble.js";
import { LoopbackLink, type WorkerRuntime } from "@nexus/worker-core";
import { InMemoryCredentialSigner } from "../src/connection/signer.js";
import { MemoryWorkerLogger } from "@nexus/worker-core";
import { createWindowsWorker } from "../src/worker.js";
import type { TimerPort } from "@nexus/worker-core";
import type { FileStat, FileSystemPort } from "../src/runtime/file-system.js";
import type {
  ProcessInfo,
  ProcessOutcome,
  ProcessRunner,
  ProcessSpawnRequest,
  StartedProcess,
} from "../src/runtime/process-runner.js";

/**
 * Harnais de test.
 *
 * Deux principes tenus dans tout ce fichier :
 *
 *  1. **Aucun processus réel, aucune écriture disque réelle.** Les ports
 *     `ProcessRunner` et `FileSystemPort` sont remplacés par des doubles en
 *     mémoire. Lancer les tests sur la machine d'un développeur ne doit rien
 *     lui faire — ni tuer un processus, ni écrire un fichier, ni cloner un dépôt.
 *  2. **Le reste est réel.** Vraies clés Ed25519, vraies signatures, vrai
 *     `DeviceSessionService`, vraie `WorkerGateway`, vrai `TaskCoordinator`,
 *     vraies enveloppes validées par les schémas du protocole. On ne simule que
 *     les frontières externes.
 */

export const USER_ID = "user-adlan";

// ─────────────────────────────────────────────────────────────────────────────
// Doubles de ports système
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeRun {
  request: ProcessSpawnRequest;
}

/**
 * Faux lanceur de processus.
 *
 * Enregistre ce qu'on lui demande et rend ce qu'on lui a dit de rendre. C'est ce
 * qui permet de vérifier qu'un argument est bien passé **en tant qu'argument**,
 * sans jamais l'exécuter.
 */
export class FakeProcessRunner implements ProcessRunner {
  readonly runs: ProcessSpawnRequest[] = [];
  readonly started: Omit<ProcessSpawnRequest, "timeoutMs">[] = [];
  readonly stopped: { processId: number; force: boolean }[] = [];

  /** Résultat par exécutable ; à défaut, une réussite vide. */
  outcomes = new Map<string, Partial<ProcessOutcome>>();
  /** Exécutables dont la sonde doit échouer. */
  missing = new Set<string>();
  processes: ProcessInfo[] = [
    { processId: 1000, name: "node.exe", memoryKb: 51_200 },
    { processId: 1001, name: "chrome.exe", memoryKb: 204_800 },
  ];
  nextPid = 4242;
  /**
   * Simule un processus qui ne rend jamais la main tant qu'on ne l'annule pas.
   *
   * Ne s'applique qu'aux appels **annulables** — ceux qui portent un signal.
   * Les sondes de disponibilité (`git --version`, `docker version`) n'en ont
   * pas : les bloquer empêcherait le worker de démarrer, ce qui n'est pas le
   * comportement qu'on cherche à mettre en scène.
   */
  hangUntilAborted = false;

  run(request: ProcessSpawnRequest): Promise<ProcessOutcome> {
    this.runs.push(request);

    if (this.missing.has(request.executable)) {
      return Promise.reject(new Error("ENOENT"));
    }

    if (this.hangUntilAborted && request.signal !== undefined) {
      return new Promise<ProcessOutcome>((resolve) => {
        const finish = () =>
          resolve({
            processId: this.nextPid,
            exitCode: null,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
            durationMs: 1,
            status: "cancelled",
            truncated: false,
          });
        if (request.signal?.aborted === true) finish();
        else request.signal?.addEventListener("abort", finish, { once: true });
      });
    }

    const override = this.outcomes.get(request.executable) ?? {};
    return Promise.resolve({
      processId: this.nextPid,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 5,
      status: "completed",
      truncated: false,
      ...override,
    });
  }

  start(request: Omit<ProcessSpawnRequest, "timeoutMs">): Promise<StartedProcess> {
    this.started.push(request);
    this.nextPid += 1;
    return Promise.resolve({
      processId: this.nextPid,
      executable: request.executable,
      startedAt: new Date().toISOString(),
    });
  }

  stop(processId: number, force: boolean): Promise<boolean> {
    this.stopped.push({ processId, force });
    return Promise.resolve(true);
  }

  list(): Promise<ProcessInfo[]> {
    return Promise.resolve(this.processes);
  }

  argsFor(executable: string): string[] | undefined {
    return this.runs.find((run) => run.executable === executable)?.args as string[] | undefined;
  }
}

/**
 * Faux disque.
 *
 * `links` permet de mettre en scène une évasion par lien symbolique — un dossier
 * autorisé qui pointe ailleurs — ce qui serait pénible à reproduire pour de vrai
 * sous Windows, où créer une jonction demande des privilèges.
 */
export class FakeFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  /** Chemin déclaré → chemin réel. */
  readonly links = new Map<string, string>();
  readonly writes: { path: string; content: string; append: boolean }[] = [];

  realpath(candidate: string): Promise<string> {
    const lowered = candidate.toLowerCase();
    for (const [from, to] of this.links) {
      const source = from.toLowerCase();
      if (lowered === source) return Promise.resolve(to);
      if (lowered.startsWith(`${source}\\`)) {
        return Promise.resolve(to + candidate.slice(from.length));
      }
    }
    return Promise.resolve(candidate);
  }

  readFile(absolutePath: string, maxBytes: number): Promise<string> {
    return Promise.resolve((this.files.get(absolutePath) ?? "").slice(0, maxBytes));
  }

  writeFile(absolutePath: string, content: string, append: boolean): Promise<number> {
    this.writes.push({ path: absolutePath, content, append });
    this.files.set(absolutePath, append ? (this.files.get(absolutePath) ?? "") + content : content);
    return Promise.resolve(Buffer.byteLength(content, "utf8"));
  }

  stat(absolutePath: string): Promise<FileStat | undefined> {
    if (this.directories.has(absolutePath)) {
      return Promise.resolve({ size: 0, isDirectory: true, modifiedAt: NOW.toISOString() });
    }
    const content = this.files.get(absolutePath);
    if (content === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      size: Buffer.byteLength(content, "utf8"),
      isDirectory: false,
      modifiedAt: NOW.toISOString(),
    });
  }

  ensureDirectory(absolutePath: string): Promise<void> {
    this.directories.add(absolutePath);
    return Promise.resolve();
  }
}

const NOW = new Date("2026-09-02T10:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const ALLOWED_ROOT = "C:\\Projets";

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    backendUrl: "wss://nexus.test/ws/worker",
    deviceId: "device-windows",
    credentialPath: "C:\\ProgramData\\NEXUS\\device.key",
    allowedPaths: [ALLOWED_ROOT],
    declaredCapabilities: [],
    allowedExecutables: ["git", "node", "pnpm", "docker", "tasklist", "rundll32"],
    allowedEnv: ["PATH", "TEMP"],
    // Table d'applications de test. `app.open` n'accepte que ces noms — jamais
    // un chemin, ce qui est précisément la garantie qu'on éprouve.
    // Pas d'épinglage en test : le canal en boucle n'ouvre aucune connexion TLS.
    coreFingerprint: undefined,
    applications: new Map([
      ["chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
      ["bloc-notes", "C:\\Windows\\notepad.exe"],
    ]),
    heartbeatIntervalMs: 20_000,
    taskTimeoutMs: 30_000,
    maxConcurrentTasks: 2,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 60_000,
    dockerAllowed: ["ps", "images", "logs", "inspect"],
    gitAllowWrite: false,
    // Chemin fictif : aucun test n'écrit l'état public, et un chemin réel
    // ferait apparaître un fichier sur la machine de qui lance la suite.
    statePath: "C:\\ProgramData\\NEXUS\\worker\\device.json",
    logLevel: "debug",
    ...overrides,
  };
}

export interface AssembledFixture {
  config: WorkerConfig;
  capabilities: LocalCapabilityRegistry;
  runner: FakeProcessRunner;
  fileSystem: FakeFileSystem;
}

/** Assemble les capacités avec des ports en mémoire, sondes déjà exécutées. */
export async function assembleForTest(
  overrides: Partial<WorkerConfig> = {},
  seed?: (fixture: { runner: FakeProcessRunner; fileSystem: FakeFileSystem }) => void,
): Promise<AssembledFixture> {
  const config = testConfig(overrides);
  const runner = new FakeProcessRunner();
  const fileSystem = new FakeFileSystem();
  seed?.({ runner, fileSystem });

  const { capabilities } = assembleCapabilities({
    config,
    runner,
    fileSystem,
    env: { PATH: "C:\\Windows;C:\\Program Files\\Git\\cmd", TEMP: "C:\\Temp" },
  });
  await capabilities.probeAll();
  // Les sondes ont lancé `git --version` et `docker version`. Ce sont des
  // préparatifs, pas le sujet des tests : on repart d'un journal vierge.
  runner.runs.length = 0;

  return { config, capabilities, runner, fileSystem };
}

// ─────────────────────────────────────────────────────────────────────────────
// Appareils
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceKeys {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Vraie paire Ed25519 : les signatures des tests sont de vraies signatures. */
export function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export const IPHONE = { id: "device-iphone", name: "iPhone" };

// ─────────────────────────────────────────────────────────────────────────────
// Harnais complet : cœur + worker reliés par un canal en mémoire
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerHarness {
  registry: DeviceRegistry;
  sessions: DeviceSessionService;
  selector: DeviceSelector;
  router: EventRouter;
  gateway: WorkerGateway;
  coordinator: TaskCoordinator;
  credentials: InMemoryCredentialProvider;
  worker: WorkerRuntime;
  link: LoopbackLink;
  logger: MemoryWorkerLogger;
  runner: FakeProcessRunner;
  fileSystem: FakeFileSystem;
  capabilities: LocalCapabilityRegistry;
  device: Device;
  keys: DeviceKeys;
  /** Événements reçus par l'iPhone, le client d'origine. */
  clientEvents: NexusEvent[];
  /** Fait avancer les minuteries injectées. */
  timers: TestTimers;
  connectWorker(): Promise<void>;
  attachClient(): Promise<void>;
}

/** Minuteries contrôlées : pas d'attente réelle dans les tests de reprise. */
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

  /** Déclenche toutes les minuteries en attente, une fois chacune. */
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

export interface HarnessOptions {
  role?: DeviceRole;
  deviceName?: string;
  config?: Partial<WorkerConfig>;
  /** Approuver l'appareil. Faux pour éprouver le refus d'un appareil en attente. */
  trusted?: boolean;
  seed?: (fixture: { runner: FakeProcessRunner; fileSystem: FakeFileSystem }) => void;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<WorkerHarness> {
  const registry = new DeviceRegistry();
  const credentials = new InMemoryCredentialProvider();
  const sessions = new DeviceSessionService({ registry });
  const router = new EventRouter({ registry });
  const gateway = new WorkerGateway({ registry, sessions, credentials, router });
  const selector = new DeviceSelector({ registry });
  const coordinator = new TaskCoordinator({
    registry,
    selector,
    router,
    transport: gateway,
  });

  const keys = generateDeviceKeys();
  const config = testConfig({ deviceId: "device-windows", ...options.config });

  // L'appareil est enregistré côté cœur avec un rôle. Le worker, lui, ignore
  // tout de ce rôle : c'est le point que vérifie le test d'architecture.
  const device = await registry.registerDevice({
    id: config.deviceId,
    userId: USER_ID,
    name: options.deviceName ?? "Poste Windows",
    type: "WINDOWS_PC",
    platform: "WINDOWS",
    role: options.role ?? "WORKER",
    grantedPermissions: [
      "terminal.execute",
      "filesystem.read",
      "filesystem.write",
      "process.list",
      "process.start",
      "process.stop",
      "docker.execute",
      "git.status",
      "git.diff",
      "git.branch",
      "git.pull",
      "git.checkout",
      "git.clone",
      "git.commit",
      "browser.open",
    ],
  });
  credentials.set(device.id, keys.publicKeyPem);
  if (options.trusted !== false) await registry.trustDevice(device.id);

  // Le client d'origine : un iPhone, purement client.
  await registry.registerDevice({
    id: IPHONE.id,
    userId: USER_ID,
    name: IPHONE.name,
    type: "IPHONE",
    platform: "IOS",
    role: "CLIENT",
  });
  await registry.trustDevice(IPHONE.id);

  const runner = new FakeProcessRunner();
  const fileSystem = new FakeFileSystem();
  options.seed?.({ runner, fileSystem });

  const { capabilities } = assembleCapabilities({
    config,
    runner,
    fileSystem,
    env: { PATH: "C:\\Windows", TEMP: "C:\\Temp" },
  });

  const logger = new MemoryWorkerLogger();
  const link = new LoopbackLink();
  const timers = new TestTimers();

  const worker = createWindowsWorker({
    config,
    link,
    signer: new InMemoryCredentialSigner(keys.privateKeyPem),
    capabilities,
    logger,
    timers,
    random: () => 0.5,
  });

  // Câblage du canal : ce que le worker envoie arrive à la passerelle, ce que la
  // passerelle envoie arrive au worker. Mêmes enveloppes que sur le fil.
  const connection: WorkerConnection = {
    connectionId: `conn-${device.id}`,
    deviceId: device.id,
    send: (envelope: Envelope) => {
      link.deliver(envelope);
    },
    close: () => {
      link.drop("fermé par le cœur");
    },
    remoteAddress: "192.0.2.10",
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
    worker,
    link,
    logger,
    runner,
    fileSystem,
    capabilities,
    device,
    keys,
    clientEvents,
    timers,

    async connectWorker() {
      await worker.start();
      // La poignée de main est une chaîne d'allers-retours asynchrones :
      // hello → challenge → authenticate → session → register → registered.
      // On attend son terme plutôt qu'un nombre arbitraire de micro-tâches —
      // sinon un test observe un état intermédiaire et échoue au hasard.
      await until(() => worker.state === "ready" || worker.state === "reconnecting");
    },

    async attachClient() {
      await router.attach({
        deviceId: IPHONE.id,
        userId: USER_ID,
        send: (event) => {
          clientEvents.push(event);
        },
      });
    },
  };
}

/** Laisse la file de micro-tâches se vider — la poignée de main est asynchrone. */
export async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/** Attend qu'une condition devienne vraie, sans horloge réelle. */
export async function until(predicate: () => boolean, rounds = 200): Promise<boolean> {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}
