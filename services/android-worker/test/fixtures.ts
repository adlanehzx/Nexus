import { generateKeyPairSync, sign as signEcdsa, createPrivateKey } from "node:crypto";
import {
  DeviceRegistry,
  DeviceSelector,
  DeviceSessionService,
  EventRouter,
  InMemoryCredentialProvider,
  TaskCoordinator,
  WorkerGateway,
  ecdsaP256Verifier,
  type Device,
  type WorkerConnection,
} from "@nexus/devices";
import type { Envelope, NexusEvent } from "@nexus/protocol";
import {
  LoopbackLink,
  MemoryWorkerLogger,
  type CredentialSigner,
  type TimerPort,
} from "@nexus/worker-core";
import type { AndroidWorkerConfig } from "../src/config.js";
import type {
  AndroidApp,
  AndroidAppController,
  AndroidBatteryState,
  AndroidDeviceInspector,
  AndroidNotificationController,
  AndroidPlatform,
  AndroidScreenshotProvider,
  AndroidUiController,
  ScrollDirection,
  Screenshot,
  UiNode,
  UiSelector,
} from "../src/ports.js";
import { assembleCapabilities } from "../src/assemble.js";
import { AndroidWorker } from "../src/worker.js";

/**
 * Harnais de test.
 *
 * Deux principes, comme pour le worker Windows :
 *
 *  1. **Aucun appel Android réel.** Les quatre ports sont remplacés par des
 *     doubles en mémoire. Les tests ne demandent ni émulateur, ni APK, ni
 *     téléphone — et ils sont donc déterministes.
 *  2. **Le reste est réel.** Vraies clés ECDSA P-256, vraies signatures, vrai
 *     `DeviceSessionService`, vraie `WorkerGateway`, vrai `TaskCoordinator`,
 *     vraies enveloppes validées par les schémas du protocole.
 *
 * Ce que ces tests ne prouvent pas est aussi important : le comportement du
 * système Android lui-même. La liste de vérification sur appareil physique du
 * README couvre ce qui ne peut pas l'être ici.
 */

export const USER_ID = "user-example";
export const IPHONE = { id: "device-iphone", name: "iPhone" };

// ─────────────────────────────────────────────────────────────────────────────
// Doubles des ports Android
// ─────────────────────────────────────────────────────────────────────────────

export class FakeAppController implements AndroidAppController {
  apps: AndroidApp[] = [
    { packageName: "com.spotify.music", label: "Spotify", launchable: true },
    { packageName: "com.whatsapp", label: "WhatsApp", launchable: true },
    { packageName: "com.android.settings", label: "Paramètres", launchable: true },
    { packageName: "com.example.service", label: "Service", launchable: false },
  ];
  readonly opened: string[] = [];
  /** Le système refuse le lancement — cas courant depuis Android 10. */
  launchBlocked = false;

  listApps(): Promise<AndroidApp[]> {
    return Promise.resolve(this.apps);
  }

  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }> {
    this.opened.push(packageName);
    return Promise.resolve(
      this.launchBlocked
        ? { launched: false, reason: "background activity start blocked" }
        : { launched: true },
    );
  }

  isInstalled(packageName: string): Promise<boolean> {
    return Promise.resolve(this.apps.some((app) => app.packageName === packageName));
  }
}

export class FakeUiController implements AndroidUiController {
  accessibilityEnabled = true;
  readonly clicks: UiSelector[] = [];
  readonly inputs: { selector: UiSelector; length: number }[] = [];
  readonly scrolls: { direction: ScrollDirection; amount: number }[] = [];
  /** Ne rend la main qu'à l'annulation — pour éprouver délais et annulation. */
  hangUntilAborted = false;

  nodes = new Map<string, UiNode>([
    ["text:Rechercher", node({ text: "Rechercher", clickable: true, viewId: "com.app:id/search" })],
    ["viewId:com.app:id/field", node({ viewId: "com.app:id/field", editable: true })],
    ["viewId:com.app:id/label", node({ viewId: "com.app:id/label" })],
  ]);

  isAccessibilityEnabled(): Promise<boolean> {
    return Promise.resolve(this.accessibilityEnabled);
  }

  findNode(selector: UiSelector): Promise<UiNode | undefined> {
    if (selector.kind === "coordinates") return Promise.resolve(undefined);
    return Promise.resolve(this.nodes.get(`${selector.kind}:${selector.value}`));
  }

  click(selector: UiSelector, signal: AbortSignal): Promise<{ clicked: boolean }> {
    this.clicks.push(selector);
    return this.#maybeHang(signal, { clicked: true });
  }

  inputText(
    selector: UiSelector,
    text: string,
    signal: AbortSignal,
  ): Promise<{ entered: boolean; characters: number }> {
    // On n'enregistre que la longueur : ce double ne doit pas retenir un mot de
    // passe plus longtemps que le code de production.
    this.inputs.push({ selector, length: text.length });
    return this.#maybeHang(signal, { entered: true, characters: text.length });
  }

  scroll(
    direction: ScrollDirection,
    amount: number,
    signal: AbortSignal,
  ): Promise<{ scrolled: boolean }> {
    this.scrolls.push({ direction, amount });
    return this.#maybeHang(signal, { scrolled: true });
  }

  #maybeHang<T>(signal: AbortSignal, value: T): Promise<T> {
    if (!this.hangUntilAborted) return Promise.resolve(value);

    return new Promise<T>((_, reject) => {
      const abort = () => {
        reject(new Error("annulée"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function node(overrides: Partial<UiNode>): UiNode {
  return {
    viewId: null,
    text: null,
    contentDescription: null,
    className: "android.widget.TextView",
    clickable: false,
    editable: false,
    scrollable: false,
    bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    ...overrides,
  };
}

export class FakeScreenshotProvider implements AndroidScreenshotProvider {
  available = true;
  captures = 0;
  /** Image renvoyée. Volontairement minuscule : ce n'est pas le sujet du test. */
  image: Screenshot = {
    base64: "aW1hZ2UtZmFjdGljZQ==",
    format: "png",
    width: 720,
    height: 1280,
    bytes: 18,
  };
  hangUntilAborted = false;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  capture(_maxDimension: number, signal: AbortSignal): Promise<Screenshot> {
    this.captures += 1;

    if (!this.hangUntilAborted) return Promise.resolve(this.image);
    return new Promise<Screenshot>((_, reject) => {
      const abort = () => {
        reject(new Error("annulée"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

export class FakeNotificationController implements AndroidNotificationController {
  allowed = true;
  readonly posted: { title: string; body: string }[] = [];
  failNext = false;

  canPostNotifications(): Promise<boolean> {
    return Promise.resolve(this.allowed);
  }

  notify(input: { title: string; body: string }): Promise<{
    posted: boolean;
    notificationId: number;
  }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("NotificationManager indisponible"));
    }
    this.posted.push({ title: input.title, body: input.body });
    return Promise.resolve({ posted: true, notificationId: this.posted.length });
  }
}

export class FakeDeviceInspector implements AndroidDeviceInspector {
  battery: AndroidBatteryState = { percent: 85, charging: false, powerSaveMode: false };
  sdk = 33;

  batteryState(): Promise<AndroidBatteryState> {
    return Promise.resolve(this.battery);
  }

  sdkVersion(): Promise<number> {
    return Promise.resolve(this.sdk);
  }
}

export interface FakePlatform extends AndroidPlatform {
  apps: FakeAppController;
  ui: FakeUiController;
  screenshots: FakeScreenshotProvider;
  notifications: FakeNotificationController;
  device: FakeDeviceInspector;
}

export function makePlatform(): FakePlatform {
  return {
    apps: new FakeAppController(),
    ui: new FakeUiController(),
    screenshots: new FakeScreenshotProvider(),
    notifications: new FakeNotificationController(),
    device: new FakeDeviceInspector(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export function testConfig(overrides: Partial<AndroidWorkerConfig> = {}): AndroidWorkerConfig {
  return {
    backendUrl: "wss://nexus.test/ws/worker",
    deviceId: "device-android",
    keyAlias: "nexus.device.key",
    declaredCapabilities: [],
    allowedPackages: [],
    deniedPackages: [],
    allowCoordinateClicks: false,
    screenshotMaxDimension: 1_280,
    screenshotMinIntervalMs: 0,
    lowBatteryPercent: 20,
    criticalBatteryPercent: 10,
    heartbeatIntervalMs: 30_000,
    taskTimeoutMs: 30_000,
    maxConcurrentTasks: 1,
    reconnectMinMs: 2_000,
    reconnectMaxMs: 120_000,
    availabilityIntervalMs: 30_000,
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

/**
 * Vraie paire ECDSA P-256.
 *
 * P-256 et non Ed25519 : c'est ce que le magasin de clés d'Android sait faire,
 * et donc ce que le Redmi utilisera réellement.
 */
export function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Signataire de test : imite le magasin de clés d'Android côté Node. */
export class TestEcdsaSigner implements CredentialSigner {
  readonly #pem: string;

  constructor(privateKeyPem: string) {
    this.#pem = privateKeyPem;
  }

  sign(nonce: string): Promise<string> {
    const signature = signEcdsa("sha256", Buffer.from(nonce, "utf8"), createPrivateKey(this.#pem));
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

export interface AndroidHarness {
  registry: DeviceRegistry;
  sessions: DeviceSessionService;
  selector: DeviceSelector;
  router: EventRouter;
  gateway: WorkerGateway;
  coordinator: TaskCoordinator;
  credentials: InMemoryCredentialProvider;
  worker: AndroidWorker;
  link: LoopbackLink;
  logger: MemoryWorkerLogger;
  platform: FakePlatform;
  device: Device;
  keys: DeviceKeys;
  clientEvents: NexusEvent[];
  timers: TestTimers;
  connectWorker(): Promise<void>;
  attachClient(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<AndroidWorkerConfig>;
  trusted?: boolean;
  seed?: (platform: FakePlatform) => void;
}

export const ANDROID_PERMISSIONS = [
  "android.app.list",
  "android.app.open",
  "android.ui.click",
  "android.ui.input",
  "android.ui.scroll",
  "android.ui.screenshot",
  "android.notification",
];

export async function makeHarness(options: HarnessOptions = {}): Promise<AndroidHarness> {
  const registry = new DeviceRegistry();
  const credentials = new InMemoryCredentialProvider();
  // Le cœur vérifie une signature P-256 : c'est le seul réglage qui change par
  // rapport au worker Windows, et il tient dans un port déjà existant.
  const sessions = new DeviceSessionService({ registry, verifier: ecdsaP256Verifier });
  const router = new EventRouter({ registry });
  const gateway = new WorkerGateway({ registry, sessions, credentials, router });
  const selector = new DeviceSelector({ registry });
  const coordinator = new TaskCoordinator({ registry, selector, router, transport: gateway });

  const keys = generateDeviceKeys();
  const config = testConfig(options.config);

  // Rôle WORKER, et pas BOTH : le Redmi n'est pas un client NEXUS. Il exécute,
  // il ne reçoit pas les événements de l'utilisateur.
  const device = await registry.registerDevice({
    id: config.deviceId,
    userId: USER_ID,
    name: "Téléphone Android",
    type: "ANDROID",
    platform: "ANDROID",
    role: "WORKER",
    grantedPermissions: ANDROID_PERMISSIONS,
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

  const platform = makePlatform();
  options.seed?.(platform);

  const { capabilities } = assembleCapabilities({ config, platform });
  const logger = new MemoryWorkerLogger();
  const link = new LoopbackLink();
  const timers = new TestTimers();

  const worker = new AndroidWorker({
    config,
    platform,
    capabilities,
    link,
    signer: new TestEcdsaSigner(keys.privateKeyPem),
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
    remoteAddress: "192.0.2.42",
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
    platform,
    device,
    keys,
    clientEvents,
    timers,

    async connectWorker() {
      await worker.start();
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
export async function until(predicate: () => boolean, rounds = 300): Promise<boolean> {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}
