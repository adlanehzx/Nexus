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
import { WORKER_MESSAGE } from "@nexus/protocol";
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
 * Test harness.
 */

export const USER_ID = "user-example";

export interface FakeRun {
  request: ProcessSpawnRequest;
}

export class FakeProcessRunner implements ProcessRunner {
  readonly runs: ProcessSpawnRequest[] = [];
  readonly started: Omit<ProcessSpawnRequest, "timeoutMs">[] = [];
  readonly stopped: { processId: number; force: boolean }[] = [];

  outcomes = new Map<string, Partial<ProcessOutcome>>();
  missing = new Set<string>();
  processes: ProcessInfo[] = [
    { processId: 1000, name: "node.exe", memoryKb: 51_200 },
    { processId: 1001, name: "chrome.exe", memoryKb: 204_800 },
  ];
  nextPid = 4242;
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

export class FakeFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
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
    coreFingerprint: undefined,
    applications: new Map([
      ["chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
      ["notepad", "C:\\Windows\\notepad.exe"],
    ]),
    heartbeatIntervalMs: 20_000,
    taskTimeoutMs: 30_000,
    maxConcurrentTasks: 2,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 60_000,
    dockerAllowed: ["ps", "images", "logs", "inspect"],
    gitAllowWrite: false,
    statePath: "C:\\ProgramData\\NEXUS\\worker\\device.json",
    localLlm: {
      runtime: "disabled",
      baseUrl: "http://127.0.0.1:11434",
      model: "",
      apiKey: undefined,
    },
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
  runner.runs.length = 0;

  return { config, capabilities, runner, fileSystem };
}

export interface DeviceKeys {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export const IPHONE = { id: "device-iphone", name: "iPhone" };

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
  clientEvents: NexusEvent[];
  timers: TestTimers;
  connectWorker(): Promise<void>;
  attachClient(): Promise<void>;
  dropLink(reason?: string): Promise<void>;
}

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

export interface HarnessOptions {
  role?: DeviceRole;
  deviceName?: string;
  config?: Partial<WorkerConfig>;
  trusted?: boolean;
  sessionTtlMs?: number;
  rotateConnections?: boolean;
  seed?: (fixture: { runner: FakeProcessRunner; fileSystem: FakeFileSystem }) => void;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<WorkerHarness> {
  const registry = new DeviceRegistry();
  const credentials = new InMemoryCredentialProvider();
  const sessions = new DeviceSessionService({
    registry,
    ...(options.sessionTtlMs === undefined ? {} : { sessionTtlMs: options.sessionTtlMs }),
  });
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

  const device = await registry.registerDevice({
    id: config.deviceId,
    userId: USER_ID,
    name: options.deviceName ?? "Windows PC",
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

  let generation = 0;
  const newConnection = (): WorkerConnection => {
    generation += 1;
    return {
      connectionId:
        generation === 1 ? `conn-${device.id}` : `conn-${device.id}-${String(generation)}`,
      deviceId: device.id,
      send: (envelope: Envelope) => {
        link.deliver(envelope);
      },
      close: () => {
        link.drop("closed by core");
      },
      remoteAddress: "192.0.2.10",
    };
  };
  let connection = newConnection();

  let hellos = 0;
  link.outbound = async (envelope) => {
    if (options.rotateConnections === true && envelope.type === WORKER_MESSAGE.hello) {
      hellos += 1;
      if (hellos > 1) {
        await gateway.detachConnection(connection.connectionId, "socket closed");
        connection = newConnection();
      }
    }
    await gateway.handleMessage(connection, envelope);
  };

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
      await until(() => worker.state === "ready" || worker.state === "reconnecting");
    },

    async dropLink(reason = "network lost") {
      await gateway.detachConnection(connection.connectionId, reason);
      link.drop(reason);
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

export async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

export async function until(
  predicate: () => boolean | Promise<boolean>,
  rounds = 200,
): Promise<true> {
  for (let index = 0; index < rounds; index += 1) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`condition never met after ${String(rounds)} iterations`);
}
